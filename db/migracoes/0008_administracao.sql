-- 0008_administracao: registro da administração de cada dose, exceção de conferência, segunda
-- validação de alto risco e as alergias que quem prescreveu confirmou conscientemente.
--
-- Regras que o banco garante (além do código):
--  - uma dose agendada tem no máximo UM resultado final (administrada, recusada, não administrada);
--    "adiada" não é final e pode se repetir;
--  - a mesma chave de idempotência (gerada pelo tablet) nunca grava dois registros;
--  - o registro é coerente: a dose, a prescrição, o idoso e o lote se referem às mesmas coisas;
--  - nada é alterado nem apagado depois de gravado (correção é um registro novo, auditado).

-- Alergias que quem prescreveu viu e confirmou, com justificativa, ao prescrever. Na hora de dar
-- o remédio, só essas deixam de bloquear; uma alergia cadastrada depois bloqueia.
ALTER TABLE prescricao ADD COLUMN alergias_confirmadas uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE OR REPLACE FUNCTION prescricao_conteudo_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.casa_id, OLD.idoso_id, OLD.medicamento_id, OLD.grupo_id, OLD.versao,
      OLD.substitui_id, OLD.tipo, OLD.dose, OLD.unidade, OLD.via, OLD.instrucoes, OLD.inicio,
      OLD.fim, OLD.alto_risco, OLD.sos_indicacao, OLD.sos_limite_diario, OLD.sos_intervalo_min,
      OLD.prescritor, OLD.justificativa, OLD.criado_por, OLD.criado_em, OLD.alergias_confirmadas)
     IS DISTINCT FROM
     (NEW.id, NEW.casa_id, NEW.idoso_id, NEW.medicamento_id, NEW.grupo_id, NEW.versao,
      NEW.substitui_id, NEW.tipo, NEW.dose, NEW.unidade, NEW.via, NEW.instrucoes, NEW.inicio,
      NEW.fim, NEW.alto_risco, NEW.sos_indicacao, NEW.sos_limite_diario, NEW.sos_intervalo_min,
      NEW.prescritor, NEW.justificativa, NEW.criado_por, NEW.criado_em, NEW.alergias_confirmadas)
  THEN
    RAISE EXCEPTION 'O conteúdo de uma prescrição não pode ser alterado: crie uma nova versão.';
  END IF;
  IF OLD.status <> 'ativa' AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.encerrada_em IS DISTINCT FROM OLD.encerrada_em
      OR NEW.encerrada_por IS DISTINCT FROM OLD.encerrada_por
      OR NEW.motivo_encerramento IS DISTINCT FROM OLD.motivo_encerramento) THEN
    RAISE EXCEPTION 'Prescrição encerrada não pode ser reaberta.';
  END IF;
  RETURN NEW;
END $$;

CREATE TYPE resultado_administracao AS ENUM ('administrada', 'recusada', 'nao_administrada', 'adiada');
-- qr: pulseira e etiqueta lidas; excecao: etiqueta ilegível, lote escolhido e liberado pelo
-- enfermeiro; tardio: lançado depois, a partir da folha de contingência.
CREATE TYPE metodo_conferencia AS ENUM ('qr', 'excecao', 'tardio');

CREATE TABLE administracao (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  casa_id          uuid NOT NULL REFERENCES casa (id),
  -- Gerada pelo tablet para cada tentativa de registro: o reenvio da mesma tentativa (rede
  -- instável, toque duplo) devolve o registro já gravado em vez de criar outro.
  chave            uuid NOT NULL,
  -- NULL só nas doses "se necessário" (SOS), que não têm horário agendado.
  dose_agendada_id uuid,
  prescricao_id    uuid NOT NULL,
  idoso_id         uuid NOT NULL,
  resultado        resultado_administracao NOT NULL,
  -- Recusa, não administração, adiamento, sintoma do SOS ou o porquê do horário fora da janela.
  motivo           text CHECK (motivo IS NULL OR length(btrim(motivo)) BETWEEN 3 AND 500),
  adiada_para      timestamptz,
  lote_id          uuid,
  quantidade       numeric(12, 3) CHECK (quantidade IS NULL OR quantidade > 0),
  usuario_id       uuid NOT NULL REFERENCES usuario (id),
  dispositivo_id   uuid REFERENCES dispositivo (id),
  -- Quando o remédio foi dado (ou recusado). No registro tardio é o horário informado.
  ocorrida_em      timestamptz NOT NULL,
  registrada_em    timestamptz NOT NULL,
  metodo           metodo_conferencia NOT NULL,
  -- Fora da janela de tolerância: em que sentido (o motivo é obrigatório nesse caso).
  fora_da_janela   text CHECK (fora_da_janela IS NULL OR fora_da_janela IN ('atrasado', 'adiantado')),
  -- Antecipação além do limite: o enfermeiro que liberou.
  liberada_por     uuid REFERENCES usuario (id),
  UNIQUE (id, casa_id),
  UNIQUE (casa_id, chave),
  FOREIGN KEY (dose_agendada_id, casa_id) REFERENCES dose_agendada (id, casa_id),
  FOREIGN KEY (prescricao_id, casa_id) REFERENCES prescricao (id, casa_id),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id),
  FOREIGN KEY (lote_id, casa_id) REFERENCES lote_estoque (id, casa_id),
  CONSTRAINT administracao_lote_so_quando_dada CHECK (
    (resultado = 'administrada') = (lote_id IS NOT NULL AND quantidade IS NOT NULL)
  ),
  CONSTRAINT administracao_motivo_obrigatorio CHECK (
    resultado = 'administrada' OR motivo IS NOT NULL
  ),
  CONSTRAINT administracao_motivo_fora_da_janela CHECK (
    fora_da_janela IS NULL OR motivo IS NOT NULL
  ),
  CONSTRAINT administracao_adiada_tem_horario CHECK (
    (resultado = 'adiada') = (adiada_para IS NOT NULL)
  ),
  -- SOS não se agenda, não se recusa nem se adia: ou foi dado (com o sintoma), ou não há registro.
  CONSTRAINT administracao_sos_so_administrada CHECK (
    dose_agendada_id IS NOT NULL OR (resultado = 'administrada' AND motivo IS NOT NULL)
  ),
  CONSTRAINT administracao_tardio_sem_qr CHECK (
    metodo <> 'tardio' OR resultado <> 'adiada'
  )
);

-- No máximo um resultado final por dose. Duas leituras simultâneas do mesmo QR: uma grava, a
-- outra esbarra aqui (e o código devolve "já registrada por ... às ...").
CREATE UNIQUE INDEX administracao_final_unica ON administracao (dose_agendada_id)
  WHERE resultado <> 'adiada' AND dose_agendada_id IS NOT NULL;
CREATE INDEX administracao_dose ON administracao (dose_agendada_id, seq);
CREATE INDEX administracao_prescricao ON administracao (prescricao_id, ocorrida_em);
CREATE INDEX administracao_casa_data ON administracao (casa_id, registrada_em DESC);

ALTER TABLE administracao ENABLE ROW LEVEL SECURITY;
ALTER TABLE administracao FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON administracao
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON administracao FROM ilpi_app;

CREATE FUNCTION registro_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registro de % não pode ser alterado nem apagado: faça um novo registro.', TG_TABLE_NAME;
END $$;

CREATE TRIGGER administracao_imutavel
  BEFORE UPDATE OR DELETE ON administracao
  FOR EACH ROW EXECUTE FUNCTION registro_imutavel();

-- Coerência entre as partes do registro, conferida no banco (o código confere antes, com
-- mensagens boas; isto é a última barreira contra um defeito no código).
CREATE FUNCTION administracao_coerente() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
  d record;
  l record;
BEGIN
  SELECT idoso_id, medicamento_id, tipo INTO p FROM prescricao WHERE id = NEW.prescricao_id;
  IF p.idoso_id <> NEW.idoso_id THEN
    RAISE EXCEPTION 'Administração incoerente: a prescrição é de outro idoso.'
      USING ERRCODE = '23514', CONSTRAINT = 'administracao_coerente';
  END IF;
  IF NEW.dose_agendada_id IS NULL THEN
    IF p.tipo <> 'sos' THEN
      RAISE EXCEPTION 'Administração incoerente: dose regular sem horário agendado.'
        USING ERRCODE = '23514', CONSTRAINT = 'administracao_coerente';
    END IF;
  ELSE
    SELECT prescricao_id, idoso_id, cancelada_em INTO d FROM dose_agendada WHERE id = NEW.dose_agendada_id;
    IF d.prescricao_id <> NEW.prescricao_id OR d.idoso_id <> NEW.idoso_id THEN
      RAISE EXCEPTION 'Administração incoerente: a dose é de outra prescrição ou de outro idoso.'
        USING ERRCODE = '23514', CONSTRAINT = 'administracao_coerente';
    END IF;
    IF d.cancelada_em IS NOT NULL THEN
      RAISE EXCEPTION 'Dose cancelada não recebe registro.'
        USING ERRCODE = '23514', CONSTRAINT = 'administracao_coerente';
    END IF;
  END IF;
  IF NEW.lote_id IS NOT NULL THEN
    SELECT medicamento_id, idoso_id INTO l FROM lote_estoque WHERE id = NEW.lote_id;
    IF l.medicamento_id <> p.medicamento_id THEN
      RAISE EXCEPTION 'Administração incoerente: o lote é de outro medicamento.'
        USING ERRCODE = '23514', CONSTRAINT = 'administracao_coerente';
    END IF;
    IF l.idoso_id IS NOT NULL AND l.idoso_id <> NEW.idoso_id THEN
      RAISE EXCEPTION 'Administração incoerente: o lote é do estoque de outro idoso.'
        USING ERRCODE = '23514', CONSTRAINT = 'administracao_coerente';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER administracao_coerente
  BEFORE INSERT ON administracao
  FOR EACH ROW EXECUTE FUNCTION administracao_coerente();

-- O consumo de estoque passa a apontar para uma administração que existe, na mesma casa.
ALTER TABLE movimento_estoque
  ADD CONSTRAINT movimento_administracao_fk
  FOREIGN KEY (administracao_id, casa_id) REFERENCES administracao (id, casa_id);
CREATE UNIQUE INDEX movimento_um_consumo_por_administracao
  ON movimento_estoque (administracao_id) WHERE tipo = 'consumo';

-- Exceção de conferência: etiqueta ilegível ou danificada. Nunca vale para alergia, lote
-- vencido ou idoso errado (o código não oferece; o registro sem pulseira não existe).
CREATE TABLE excecao_conferencia (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id          uuid NOT NULL REFERENCES casa (id),
  administracao_id uuid NOT NULL UNIQUE,
  motivo           text NOT NULL CHECK (motivo IN ('etiqueta_ilegivel', 'etiqueta_danificada')),
  liberada_por     uuid NOT NULL REFERENCES usuario (id),
  justificativa    text NOT NULL CHECK (length(btrim(justificativa)) BETWEEN 10 AND 500),
  criada_em        timestamptz NOT NULL,
  FOREIGN KEY (administracao_id, casa_id) REFERENCES administracao (id, casa_id)
);

ALTER TABLE excecao_conferencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE excecao_conferencia FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON excecao_conferencia
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON excecao_conferencia FROM ilpi_app;
CREATE TRIGGER excecao_conferencia_imutavel
  BEFORE UPDATE OR DELETE ON excecao_conferencia
  FOR EACH ROW EXECUTE FUNCTION registro_imutavel();

-- Segunda validação de alto risco: outra pessoa, que não quem registrou.
CREATE TABLE segunda_validacao (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id          uuid NOT NULL REFERENCES casa (id),
  administracao_id uuid NOT NULL UNIQUE,
  validador_id     uuid NOT NULL REFERENCES usuario (id),
  validada_em      timestamptz NOT NULL,
  FOREIGN KEY (administracao_id, casa_id) REFERENCES administracao (id, casa_id)
);

ALTER TABLE segunda_validacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE segunda_validacao FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON segunda_validacao
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON segunda_validacao FROM ilpi_app;
CREATE TRIGGER segunda_validacao_imutavel
  BEFORE UPDATE OR DELETE ON segunda_validacao
  FOR EACH ROW EXECUTE FUNCTION registro_imutavel();

CREATE FUNCTION segunda_validacao_outra_pessoa() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM administracao WHERE id = NEW.administracao_id AND usuario_id = NEW.validador_id) THEN
    RAISE EXCEPTION 'A segunda validação precisa ser de outra pessoa.'
      USING ERRCODE = '23514', CONSTRAINT = 'segunda_validacao_outra_pessoa';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER segunda_validacao_outra_pessoa
  BEFORE INSERT ON segunda_validacao
  FOR EACH ROW EXECUTE FUNCTION segunda_validacao_outra_pessoa();
