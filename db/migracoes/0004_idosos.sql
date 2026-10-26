-- 0004_idosos: idoso, alergia, contato de emergência e histórico de pulseiras.
--
-- Chave estrangeira composta (id, casa_id): um filho nunca aponta para um pai de outra casa,
-- mesmo que o código da aplicação erre. Nada é apagado: idoso muda de status; alergia e contato
-- são desativados.

CREATE TYPE status_idoso AS ENUM ('ativo', 'hospitalizado', 'desligado');
CREATE TYPE gravidade_alergia AS ENUM ('leve', 'moderada', 'grave');

CREATE TABLE idoso (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id            uuid NOT NULL REFERENCES casa (id),
  nome               text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 200),
  data_nascimento    date NOT NULL CHECK (data_nascimento > DATE '1880-01-01'),
  -- CPF é opcional (minimização) e fica cifrado pela aplicação.
  cpf_cifrado        text,
  quarto             text CHECK (quarto IS NULL OR length(quarto) <= 40),
  foto_chave         text,
  -- Código opaco do QR da pulseira. Sem 0/O/1/I/L para não confundir na digitação.
  codigo_pulseira    text NOT NULL UNIQUE CHECK (codigo_pulseira ~ '^[A-HJKMNP-Z2-9]{20}$'),
  status             status_idoso NOT NULL DEFAULT 'ativo',
  status_alterado_em timestamptz,
  criado_por         uuid REFERENCES usuario (id),
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, casa_id)
);

CREATE INDEX idoso_casa_status ON idoso (casa_id, status);

ALTER TABLE idoso ENABLE ROW LEVEL SECURITY;
ALTER TABLE idoso FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON idoso
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- Pulseiras substituídas: ler uma delas avisa "pulseira substituída" em vez de "desconhecida".
CREATE TABLE pulseira_revogada (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id      uuid NOT NULL REFERENCES casa (id),
  idoso_id     uuid NOT NULL,
  codigo       text NOT NULL UNIQUE,
  revogada_em  timestamptz NOT NULL DEFAULT now(),
  revogada_por uuid REFERENCES usuario (id),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id)
);

CREATE INDEX pulseira_revogada_idoso ON pulseira_revogada (idoso_id);

ALTER TABLE pulseira_revogada ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulseira_revogada FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON pulseira_revogada
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

CREATE TABLE alergia (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id        uuid NOT NULL REFERENCES casa (id),
  idoso_id       uuid NOT NULL,
  substancia     text NOT NULL CHECK (length(btrim(substancia)) BETWEEN 2 AND 120),
  gravidade      gravidade_alergia NOT NULL,
  observacao     text CHECK (observacao IS NULL OR length(observacao) <= 500),
  ativa          boolean NOT NULL DEFAULT true,
  criado_por     uuid REFERENCES usuario (id),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  desativada_em  timestamptz,
  desativada_por uuid REFERENCES usuario (id),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id),
  CONSTRAINT alergia_desativada_coerente CHECK (ativa OR desativada_em IS NOT NULL)
);

CREATE INDEX alergia_idoso ON alergia (idoso_id) WHERE ativa;

ALTER TABLE alergia ENABLE ROW LEVEL SECURITY;
ALTER TABLE alergia FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON alergia
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

CREATE TABLE contato_emergencia (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id            uuid NOT NULL REFERENCES casa (id),
  idoso_id           uuid NOT NULL,
  nome               text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 200),
  parentesco         text NOT NULL CHECK (length(btrim(parentesco)) BETWEEN 2 AND 60),
  -- Telefone cifrado pela aplicação (dado pessoal de terceiro).
  telefone_cifrado   text NOT NULL,
  responsavel_legal  boolean NOT NULL DEFAULT false,
  ativo              boolean NOT NULL DEFAULT true,
  criado_por         uuid REFERENCES usuario (id),
  criado_em          timestamptz NOT NULL DEFAULT now(),
  desativado_em      timestamptz,
  desativado_por     uuid REFERENCES usuario (id),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id),
  CONSTRAINT contato_desativado_coerente CHECK (ativo OR desativado_em IS NOT NULL)
);

CREATE INDEX contato_idoso ON contato_emergencia (idoso_id) WHERE ativo;

ALTER TABLE contato_emergencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE contato_emergencia FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON contato_emergencia
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
