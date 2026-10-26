-- 0009_alertas: alertas da casa (spec 6.4 e 6.5), leituras e a fila de e-mails.
--
-- Um alerta é uma CONDIÇÃO aberta ("o estoque da Losartana do Seu Benedito acaba em 3 dias"),
-- identificada por uma chave estável. Só existe um alerta aberto por condição: a verificação
-- periódica reconcilia (abre o que surgiu, agrava, fecha o que se resolveu) em vez de empilhar
-- avisos repetidos. Alerta fechado nunca reabre: se a condição voltar, nasce outro.
--
-- O título e o detalhe (com nome de residente e de remédio) ficam aqui, dentro do sistema, sob RLS.
-- A mensagem externa (e-mail) é montada à parte e não leva nada disso.

CREATE TYPE tipo_alerta AS ENUM (
  'estoque_acabando', 'validade_proxima', 'lote_vencido', 'dose_atrasada', 'dose_sem_registro',
  'prescricao_vencendo', 'excecoes_do_dia', 'excecoes_repetidas', 'sos_bloqueado'
);
CREATE TYPE gravidade_alerta AS ENUM ('aviso', 'urgente');
CREATE TYPE destino_alerta AS ENUM ('enfermeiro', 'gestor');
CREATE TYPE estado_alerta AS ENUM ('aberto', 'resolvido');
-- automatica: a condição deixou de existir; lido: alerta informativo, fechado ao ser lido;
-- manual: alguém da enfermagem ou da gestão fechou, com justificativa.
CREATE TYPE resolucao_alerta AS ENUM ('automatica', 'lido', 'manual');

CREATE TABLE alerta (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  casa_id         uuid NOT NULL REFERENCES casa (id),
  chave           text NOT NULL CHECK (length(chave) BETWEEN 3 AND 200),
  tipo            tipo_alerta NOT NULL,
  gravidade       gravidade_alerta NOT NULL,
  destino         destino_alerta NOT NULL,
  titulo          text NOT NULL CHECK (length(titulo) BETWEEN 3 AND 300),
  detalhe         text CHECK (detalhe IS NULL OR length(detalhe) <= 1000),
  entidade        text,
  entidade_id     uuid,
  estado          estado_alerta NOT NULL DEFAULT 'aberto',
  aberto_em       timestamptz NOT NULL,
  -- Desde quando está na gravidade atual (o escalonamento conta a partir de virar urgente).
  gravidade_desde timestamptz NOT NULL,
  notificado_em   timestamptz,
  escalado_em     timestamptz,
  resolvido_em    timestamptz,
  resolucao       resolucao_alerta,
  resolvido_por   uuid REFERENCES usuario (id),
  justificativa   text CHECK (justificativa IS NULL OR length(btrim(justificativa)) BETWEEN 5 AND 500),
  UNIQUE (id, casa_id),
  CONSTRAINT alerta_resolucao_coerente CHECK (
    (estado = 'aberto' AND resolvido_em IS NULL AND resolucao IS NULL)
    OR (estado = 'resolvido' AND resolvido_em IS NOT NULL AND resolucao IS NOT NULL)
  ),
  CONSTRAINT alerta_manual_justificado CHECK (
    resolucao IS DISTINCT FROM 'manual' OR (justificativa IS NOT NULL AND resolvido_por IS NOT NULL)
  )
);

-- Um alerta aberto por condição.
CREATE UNIQUE INDEX alerta_um_aberto_por_condicao ON alerta (casa_id, chave) WHERE estado = 'aberto';
CREATE INDEX alerta_abertos ON alerta (casa_id, gravidade, aberto_em) WHERE estado = 'aberto';
CREATE INDEX alerta_recentes ON alerta (casa_id, seq DESC);

ALTER TABLE alerta ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerta FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON alerta
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- O que identifica a condição não muda; resolvido não volta a abrir. Sem DELETE (privilégio).
CREATE FUNCTION alerta_so_evolui() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.casa_id, OLD.chave, OLD.tipo, OLD.aberto_em, OLD.seq)
     IS DISTINCT FROM (NEW.id, NEW.casa_id, NEW.chave, NEW.tipo, NEW.aberto_em, NEW.seq) THEN
    RAISE EXCEPTION 'A identidade de um alerta não muda.';
  END IF;
  IF OLD.estado = 'resolvido' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Alerta resolvido não muda nem reabre.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER alerta_so_evolui
  BEFORE UPDATE ON alerta
  FOR EACH ROW EXECUTE FUNCTION alerta_so_evolui();

-- Quem leu cada alerta, e quando (a primeira leitura de cada pessoa).
CREATE TABLE alerta_leitura (
  alerta_id  uuid NOT NULL,
  casa_id    uuid NOT NULL REFERENCES casa (id),
  usuario_id uuid NOT NULL REFERENCES usuario (id),
  lido_em    timestamptz NOT NULL,
  PRIMARY KEY (alerta_id, usuario_id),
  FOREIGN KEY (alerta_id, casa_id) REFERENCES alerta (id, casa_id)
);

ALTER TABLE alerta_leitura ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerta_leitura FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON alerta_leitura
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON alerta_leitura FROM ilpi_app;

-- Fila de e-mails. O endereço é lido do cadastro na hora do envio (não fica copiado aqui), e o
-- texto é montado sem dados de saúde.
CREATE TYPE motivo_envio AS ENUM ('novo', 'agravado', 'reaviso', 'escalonamento');
CREATE TYPE estado_envio AS ENUM ('pendente', 'enviado', 'falhou', 'descartado');

CREATE TABLE envio_alerta (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  casa_id     uuid NOT NULL REFERENCES casa (id),
  alerta_id   uuid NOT NULL,
  usuario_id  uuid NOT NULL REFERENCES usuario (id),
  motivo      motivo_envio NOT NULL,
  estado      estado_envio NOT NULL DEFAULT 'pendente',
  tentativas  integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  proxima_em  timestamptz NOT NULL,
  ultimo_erro text CHECK (ultimo_erro IS NULL OR length(ultimo_erro) <= 200),
  enviado_em  timestamptz,
  criado_em   timestamptz NOT NULL,
  FOREIGN KEY (alerta_id, casa_id) REFERENCES alerta (id, casa_id)
);

CREATE INDEX envio_pendente ON envio_alerta (casa_id, proxima_em) WHERE estado = 'pendente';
CREATE INDEX envio_do_alerta ON envio_alerta (alerta_id, seq);

ALTER TABLE envio_alerta ENABLE ROW LEVEL SECURITY;
ALTER TABLE envio_alerta FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON envio_alerta
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- Novas tarefas do agendador.
ALTER TABLE execucao_agendador DROP CONSTRAINT execucao_agendador_tarefa_check;
ALTER TABLE execucao_agendador ADD CONSTRAINT execucao_agendador_tarefa_check
  CHECK (tarefa IN ('gerar_doses', 'verificar_alertas', 'enviar_alertas'));
