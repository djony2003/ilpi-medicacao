-- 0007_estoque: lotes, movimentos, impressão de etiquetas e inventário.
--
-- O saldo de um lote NÃO é uma coluna: é a soma dos movimentos (view saldo_lote), então não há
-- número para alguém editar à mão. Lotes e movimentos nunca mudam depois de gravados (gatilhos
-- abaixo valem até para o dono do schema): corrigir é lançar um movimento novo, com motivo.
--
-- Convenção de sinal: a quantidade do movimento é o efeito no saldo. Entrada é positiva; consumo,
-- perda, descarte e devolução são negativos; ajuste pode ter qualquer sinal.

CREATE TYPE tipo_movimento_estoque AS ENUM (
  'entrada', 'consumo', 'perda', 'ajuste', 'descarte', 'devolucao',
  -- Separar um pedaço do lote (blister recortado, frasco aberto): sai de um lote e entra em
  -- outro. Os dois tipos próprios impedem que o fracionamento apareça como entrada nova nos
  -- relatórios.
  'fracionamento_saida', 'fracionamento_entrada'
);
CREATE TYPE status_inventario AS ENUM ('aberto', 'concluido', 'cancelado');

-- ---------------------------------------------------------------------------------------------
-- lote_estoque
-- ---------------------------------------------------------------------------------------------
CREATE TABLE lote_estoque (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id            uuid NOT NULL REFERENCES casa (id),
  medicamento_id     uuid NOT NULL,
  -- NULL = estoque comum da casa; preenchido = estoque individual daquele idoso.
  idoso_id           uuid,
  -- Código opaco do QR da etiqueta. Sem 0/O/1/I/L para não confundir na digitação.
  codigo_qr          text NOT NULL UNIQUE CHECK (codigo_qr ~ '^[A-HJKMNP-Z2-9]{20}$'),
  -- Número do lote impresso pelo fabricante na embalagem.
  numero_lote        text NOT NULL CHECK (length(btrim(numero_lote)) BETWEEN 1 AND 60),
  -- Último dia em que o lote pode ser usado (inclusive).
  validade           date NOT NULL,
  -- Unidade de controle: a menor fração que a equipe administra.
  unidade            unidade_dose NOT NULL,
  quantidade_inicial numeric(12, 3) NOT NULL CHECK (quantidade_inicial > 0),
  -- Lote criado por fracionamento aponta para o lote de onde saiu.
  origem_id          uuid,
  observacao         text CHECK (observacao IS NULL OR length(btrim(observacao)) BETWEEN 1 AND 300),
  criado_por         uuid REFERENCES usuario (id),
  criado_em          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, casa_id),
  FOREIGN KEY (medicamento_id, casa_id) REFERENCES medicamento (id, casa_id),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id),
  FOREIGN KEY (origem_id, casa_id) REFERENCES lote_estoque (id, casa_id)
);

CREATE INDEX lote_estoque_medicamento ON lote_estoque (casa_id, medicamento_id);
CREATE INDEX lote_estoque_idoso ON lote_estoque (casa_id, idoso_id) WHERE idoso_id IS NOT NULL;
CREATE INDEX lote_estoque_validade ON lote_estoque (casa_id, validade);

ALTER TABLE lote_estoque ENABLE ROW LEVEL SECURITY;
ALTER TABLE lote_estoque FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON lote_estoque
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON lote_estoque FROM ilpi_app;

CREATE FUNCTION lote_estoque_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Um lote de estoque não pode ser alterado nem apagado: lance um movimento.';
END $$;

CREATE TRIGGER lote_estoque_sem_alterar
  BEFORE UPDATE OR DELETE ON lote_estoque
  FOR EACH ROW EXECUTE FUNCTION lote_estoque_imutavel();

-- Um lote fracionado é do mesmo medicamento e na mesma unidade do lote de origem, e não pode
-- durar mais do que ele: o pedaço recortado não ganha validade.
CREATE FUNCTION lote_estoque_fracao_coerente() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o lote_estoque%ROWTYPE;
BEGIN
  IF NEW.origem_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO o FROM lote_estoque WHERE id = NEW.origem_id AND casa_id = NEW.casa_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote de origem do fracionamento não encontrado.';
  END IF;
  IF o.medicamento_id <> NEW.medicamento_id OR o.unidade <> NEW.unidade THEN
    RAISE EXCEPTION 'O lote fracionado precisa ter o mesmo medicamento e a mesma unidade da origem.';
  END IF;
  IF NEW.validade > o.validade THEN
    RAISE EXCEPTION 'O lote fracionado não pode vencer depois do lote de origem.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lote_estoque_fracao_confere
  BEFORE INSERT ON lote_estoque
  FOR EACH ROW EXECUTE FUNCTION lote_estoque_fracao_coerente();

-- ---------------------------------------------------------------------------------------------
-- inventario (contagem manual por lote)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventario (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id      uuid NOT NULL REFERENCES casa (id),
  status       status_inventario NOT NULL DEFAULT 'aberto',
  iniciado_por uuid REFERENCES usuario (id),
  iniciado_em  timestamptz NOT NULL DEFAULT now(),
  encerrado_por uuid REFERENCES usuario (id),
  encerrado_em timestamptz,
  UNIQUE (id, casa_id),
  CONSTRAINT inventario_encerramento_coerente CHECK (
    (status = 'aberto' AND encerrado_em IS NULL AND encerrado_por IS NULL)
    OR (status <> 'aberto' AND encerrado_em IS NOT NULL)
  )
);

-- Duas contagens ao mesmo tempo gerariam ajustes sobre ajustes: só um inventário aberto por casa.
CREATE UNIQUE INDEX inventario_um_aberto ON inventario (casa_id) WHERE status = 'aberto';

ALTER TABLE inventario ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON inventario
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- ---------------------------------------------------------------------------------------------
-- movimento_estoque
-- ---------------------------------------------------------------------------------------------
CREATE TABLE movimento_estoque (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordem real de gravação: o histórico do lote se lê por aqui, nunca pelo horário (dois
  -- movimentos no mesmo instante teriam ordem indefinida).
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  casa_id         uuid NOT NULL REFERENCES casa (id),
  lote_id         uuid NOT NULL,
  tipo            tipo_movimento_estoque NOT NULL,
  quantidade      numeric(12, 3) NOT NULL CHECK (quantidade <> 0),
  motivo          text CHECK (motivo IS NULL OR length(btrim(motivo)) BETWEEN 3 AND 500),
  usuario_id      uuid NOT NULL REFERENCES usuario (id),
  -- Consumo: a administração que baixou o lote (a chave estrangeira entra com a tabela, no M5).
  administracao_id uuid,
  -- Ajuste que veio de uma contagem de inventário.
  inventario_id   uuid,
  -- Fracionamento: as duas pontas (saída da origem e entrada no lote novo) compartilham o par.
  par_id          uuid,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, casa_id),
  FOREIGN KEY (lote_id, casa_id) REFERENCES lote_estoque (id, casa_id),
  FOREIGN KEY (inventario_id, casa_id) REFERENCES inventario (id, casa_id),
  CONSTRAINT movimento_sinal_do_tipo CHECK (
    (tipo IN ('entrada', 'fracionamento_entrada') AND quantidade > 0)
    OR (tipo IN ('consumo', 'perda', 'descarte', 'devolucao', 'fracionamento_saida') AND quantidade < 0)
    OR tipo = 'ajuste'
  ),
  -- Tirar ou corrigir estoque sem dizer por quê não vale.
  CONSTRAINT movimento_motivo_obrigatorio CHECK (
    tipo NOT IN ('perda', 'descarte', 'devolucao', 'ajuste') OR motivo IS NOT NULL
  ),
  CONSTRAINT movimento_consumo_tem_administracao CHECK (
    tipo <> 'consumo' OR administracao_id IS NOT NULL
  ),
  CONSTRAINT movimento_fracionamento_tem_par CHECK (
    tipo NOT IN ('fracionamento_saida', 'fracionamento_entrada') OR par_id IS NOT NULL
  )
);

CREATE INDEX movimento_estoque_lote ON movimento_estoque (lote_id, seq);
CREATE INDEX movimento_estoque_casa_data ON movimento_estoque (casa_id, criado_em DESC);

ALTER TABLE movimento_estoque ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimento_estoque FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON movimento_estoque
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON movimento_estoque FROM ilpi_app;

CREATE FUNCTION movimento_estoque_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Um movimento de estoque não pode ser alterado nem apagado: lance um ajuste.';
END $$;

CREATE TRIGGER movimento_estoque_sem_alterar
  BEFORE UPDATE OR DELETE ON movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION movimento_estoque_imutavel();

-- O saldo de um lote nunca fica negativo, mesmo com duas baixas simultâneas. O travamento é por
-- lote (advisory lock da transação), então movimentos de lotes diferentes não esperam um pelo
-- outro. Um lock de linha não serve: a aplicação não tem permissão de UPDATE em lote_estoque.
CREATE FUNCTION movimento_estoque_confere_saldo() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saldo numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lote_estoque:' || NEW.lote_id::text, 0));
  SELECT COALESCE(sum(quantidade), 0) INTO saldo
    FROM movimento_estoque WHERE lote_id = NEW.lote_id AND casa_id = NEW.casa_id;
  IF saldo + NEW.quantidade < 0 THEN
    RAISE EXCEPTION 'Saldo do lote insuficiente para este movimento.'
      USING ERRCODE = '23514', CONSTRAINT = 'saldo_do_lote_nao_negativo';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER movimento_estoque_saldo
  BEFORE INSERT ON movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION movimento_estoque_confere_saldo();

-- Saldo por lote. security_invoker faz a view obedecer o RLS de quem consulta.
CREATE VIEW saldo_lote WITH (security_invoker = true) AS
SELECT l.id AS lote_id,
       l.casa_id,
       COALESCE(sum(m.quantidade), 0)::numeric(12, 3) AS saldo
  FROM lote_estoque l
  LEFT JOIN movimento_estoque m ON m.lote_id = l.id AND m.casa_id = l.casa_id
 GROUP BY l.id, l.casa_id;

-- ---------------------------------------------------------------------------------------------
-- inventario_item
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventario_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id       uuid NOT NULL REFERENCES casa (id),
  inventario_id uuid NOT NULL,
  lote_id       uuid NOT NULL,
  -- Saldo do sistema no instante da contagem (não no da abertura): o consumo que acontece
  -- enquanto a equipe conta não vira divergência.
  esperado      numeric(12, 3) CHECK (esperado IS NULL OR esperado >= 0),
  contado       numeric(12, 3) CHECK (contado IS NULL OR contado >= 0),
  contado_por   uuid REFERENCES usuario (id),
  contado_em    timestamptz,
  justificativa text CHECK (justificativa IS NULL OR length(btrim(justificativa)) BETWEEN 3 AND 500),
  -- O ajuste lançado ao concluir, quando houve divergência.
  ajuste_id     uuid,
  UNIQUE (inventario_id, lote_id),
  FOREIGN KEY (inventario_id, casa_id) REFERENCES inventario (id, casa_id),
  FOREIGN KEY (lote_id, casa_id) REFERENCES lote_estoque (id, casa_id),
  FOREIGN KEY (ajuste_id, casa_id) REFERENCES movimento_estoque (id, casa_id),
  CONSTRAINT inventario_item_contagem_coerente CHECK (
    (contado IS NULL AND esperado IS NULL AND contado_em IS NULL AND contado_por IS NULL)
    OR (contado IS NOT NULL AND esperado IS NOT NULL AND contado_em IS NOT NULL)
  )
);

CREATE INDEX inventario_item_inventario ON inventario_item (inventario_id);

ALTER TABLE inventario_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario_item FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON inventario_item
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- ---------------------------------------------------------------------------------------------
-- impressao_etiqueta: quem imprimiu e quem reimprimiu a etiqueta de cada lote
-- ---------------------------------------------------------------------------------------------
CREATE TABLE impressao_etiqueta (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  casa_id     uuid NOT NULL REFERENCES casa (id),
  lote_id     uuid NOT NULL,
  usuario_id  uuid NOT NULL REFERENCES usuario (id),
  reimpressao boolean NOT NULL,
  impresso_em timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (lote_id, casa_id) REFERENCES lote_estoque (id, casa_id)
);

CREATE INDEX impressao_etiqueta_lote ON impressao_etiqueta (lote_id);

ALTER TABLE impressao_etiqueta ENABLE ROW LEVEL SECURITY;
ALTER TABLE impressao_etiqueta FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON impressao_etiqueta
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON impressao_etiqueta FROM ilpi_app;
