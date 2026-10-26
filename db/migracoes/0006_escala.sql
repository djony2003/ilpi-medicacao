-- 0006_escala: doses agendadas, batimento do agendador e acesso do agendador à lista de casas.
--
-- Uma dose agendada é um horário previsto de uma prescrição regular, num dia, no fuso da casa.
-- Nada é apagado: uma dose que deixa de valer (prescrição encerrada ou substituída, idoso
-- internado ou desligado) recebe a marca de cancelamento, por gatilho do banco, no mesmo instante
-- em que a causa acontece. O horário de referência é o gravado pela aplicação (encerrada_em,
-- status_alterado_em), nunca o relógio do servidor de banco, para que o tempo seja injetável nos testes.

CREATE TYPE motivo_cancelamento_dose AS ENUM (
  'prescricao_encerrada', 'prescricao_substituida', 'idoso_afastado'
);

CREATE TABLE dose_agendada (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id             uuid NOT NULL REFERENCES casa (id),
  prescricao_id       uuid NOT NULL,
  idoso_id            uuid NOT NULL,
  -- Dia e hora de parede no fuso da casa (o que a equipe vê e o que a prescrição define).
  data_local          date NOT NULL,
  hora_local          time(0) NOT NULL,
  -- O mesmo instante, absoluto. Calculado com o fuso da casa no momento da geração.
  prevista_em         timestamptz NOT NULL,
  gerada_em           timestamptz NOT NULL DEFAULT now(),
  cancelada_em        timestamptz,
  motivo_cancelamento motivo_cancelamento_dose,
  UNIQUE (id, casa_id),
  FOREIGN KEY (prescricao_id, casa_id) REFERENCES prescricao (id, casa_id),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id),
  CONSTRAINT dose_cancelamento_coerente CHECK ((cancelada_em IS NULL) = (motivo_cancelamento IS NULL))
);

-- Idempotência: um único horário ativo por prescrição, dia e hora. Cancelada libera o lugar.
CREATE UNIQUE INDEX dose_horario_unico
  ON dose_agendada (prescricao_id, data_local, hora_local) WHERE cancelada_em IS NULL;
CREATE INDEX dose_casa_prevista ON dose_agendada (casa_id, prevista_em) WHERE cancelada_em IS NULL;
CREATE INDEX dose_idoso_prevista ON dose_agendada (idoso_id, prevista_em) WHERE cancelada_em IS NULL;

ALTER TABLE dose_agendada ENABLE ROW LEVEL SECURITY;
ALTER TABLE dose_agendada FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON dose_agendada
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- Só o cancelamento pode mudar (uma vez); o resto da dose é fato gerado e fica como nasceu.
CREATE FUNCTION dose_agendada_so_cancela() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.casa_id, OLD.prescricao_id, OLD.idoso_id, OLD.data_local, OLD.hora_local,
      OLD.prevista_em, OLD.gerada_em)
     IS DISTINCT FROM
     (NEW.id, NEW.casa_id, NEW.prescricao_id, NEW.idoso_id, NEW.data_local, NEW.hora_local,
      NEW.prevista_em, NEW.gerada_em) THEN
    RAISE EXCEPTION 'Uma dose agendada não pode ser alterada: só cancelada.';
  END IF;
  IF OLD.cancelada_em IS NOT NULL AND
     (NEW.cancelada_em IS DISTINCT FROM OLD.cancelada_em
      OR NEW.motivo_cancelamento IS DISTINCT FROM OLD.motivo_cancelamento) THEN
    RAISE EXCEPTION 'Dose cancelada não pode voltar atrás.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER dose_agendada_so_cancela
  BEFORE UPDATE ON dose_agendada
  FOR EACH ROW EXECUTE FUNCTION dose_agendada_so_cancela();

-- Prescrição encerrada ou substituída: as doses futuras dela deixam de valer na hora, na mesma
-- transação. As que já passaram continuam (a equipe precisa vê-las e registrá-las).
CREATE FUNCTION cancelar_doses_da_prescricao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE dose_agendada
     SET cancelada_em = NEW.encerrada_em,
         motivo_cancelamento = CASE NEW.status
           WHEN 'encerrada' THEN 'prescricao_encerrada'::motivo_cancelamento_dose
           ELSE 'prescricao_substituida'::motivo_cancelamento_dose END
   WHERE prescricao_id = NEW.id
     AND cancelada_em IS NULL
     AND prevista_em > NEW.encerrada_em;
  RETURN NULL;
END $$;

CREATE TRIGGER prescricao_cancela_doses
  AFTER UPDATE OF status ON prescricao
  FOR EACH ROW
  WHEN (OLD.status = 'ativa' AND NEW.status <> 'ativa')
  EXECUTE FUNCTION cancelar_doses_da_prescricao();

-- Idoso internado ou desligado: ninguém administra remédio; as doses futuras são canceladas. Ao
-- voltar a "ativo", o agendador gera de novo as que ainda não passaram.
CREATE FUNCTION cancelar_doses_do_idoso() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE dose_agendada
     SET cancelada_em = coalesce(NEW.status_alterado_em, now()),
         motivo_cancelamento = 'idoso_afastado'
   WHERE idoso_id = NEW.id
     AND cancelada_em IS NULL
     AND prevista_em > coalesce(NEW.status_alterado_em, now());
  RETURN NULL;
END $$;

CREATE TRIGGER idoso_afastado_cancela_doses
  AFTER UPDATE OF status ON idoso
  FOR EACH ROW
  WHEN (OLD.status = 'ativo' AND NEW.status <> 'ativo')
  EXECUTE FUNCTION cancelar_doses_do_idoso();

-- Batimento do agendador: a última vez que cada tarefa rodou para cada casa, e como terminou.
CREATE TABLE execucao_agendador (
  casa_id            uuid NOT NULL REFERENCES casa (id),
  tarefa             text NOT NULL CHECK (tarefa IN ('gerar_doses')),
  ultima_execucao_em timestamptz NOT NULL,
  ultima_duracao_ms  integer,
  ultimo_resultado   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ultimo_erro_em     timestamptz,
  PRIMARY KEY (casa_id, tarefa)
);

ALTER TABLE execucao_agendador ENABLE ROW LEVEL SECURITY;
ALTER TABLE execucao_agendador FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON execucao_agendador
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- O agendador precisa saber QUAIS casas existem antes de entrar no contexto de cada uma. Esta é a
-- única ampliação de leitura que ele tem, e só em `casa`: o resto continua isolado por casa.
CREATE POLICY agendador_lista_casas ON casa
  FOR SELECT TO ilpi_agendador
  USING (ativa);
