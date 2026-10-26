-- 0002_identidade: casa, usuario, dispositivo e sessao, com RLS.
-- As políticas "busca_*" são o mecanismo do ADR-002: liberam, só para SELECT, a linha cuja
-- chave secreta coincide com a variável local da transação (ver comBusca).

-- ---------------------------------------------------------------------------------------------
-- casa
-- ---------------------------------------------------------------------------------------------
CREATE TABLE casa (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  cnpj          text,
  fuso_horario  text NOT NULL DEFAULT 'America/Sao_Paulo',
  configuracoes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ativa         boolean NOT NULL DEFAULT true,
  criada_em     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE casa ENABLE ROW LEVEL SECURITY;
ALTER TABLE casa FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON casa
  USING (id = app_casa_id())
  WITH CHECK (id = app_casa_id());

-- ---------------------------------------------------------------------------------------------
-- usuario
-- ---------------------------------------------------------------------------------------------
CREATE TYPE perfil_usuario AS ENUM ('gestor', 'enfermeiro', 'cuidador');

CREATE TABLE usuario (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id               uuid NOT NULL REFERENCES casa (id),
  nome                  text NOT NULL,
  email                 text,
  perfil                perfil_usuario NOT NULL,
  registro_profissional text,
  senha_hash            text,
  senha_trocar          boolean NOT NULL DEFAULT false,
  totp_segredo_cifrado  text,
  totp_ativo            boolean NOT NULL DEFAULT false,
  totp_ultimo_passo     bigint,
  pin_hash              text,
  pin_trocar            boolean NOT NULL DEFAULT false,
  tentativas_falhas     integer NOT NULL DEFAULT 0,
  bloqueado_ate         timestamptz,
  ativo                 boolean NOT NULL DEFAULT true,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  desativado_em         timestamptz,
  -- Gestor e enfermeiro entram por e-mail; cuidador entra só por PIN no tablet.
  CONSTRAINT usuario_email_obrigatorio CHECK (perfil = 'cuidador' OR email IS NOT NULL),
  -- E-mail sempre em minúsculas, para a busca por igualdade ser confiável.
  CONSTRAINT usuario_email_minusculo CHECK (email IS NULL OR email = lower(email))
);

-- E-mail único em todo o sistema (limitação da V1, ver ADR-002).
CREATE UNIQUE INDEX usuario_email_unico ON usuario (email) WHERE email IS NOT NULL;
CREATE INDEX usuario_casa ON usuario (casa_id);

ALTER TABLE usuario ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON usuario
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
CREATE POLICY busca_login ON usuario FOR SELECT
  USING (email IS NOT NULL AND email = NULLIF(current_setting('app.login_email', true), ''));

-- ---------------------------------------------------------------------------------------------
-- dispositivo (tablet do posto de enfermagem)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE dispositivo (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id              uuid NOT NULL REFERENCES casa (id),
  nome                 text NOT NULL,
  codigo_ativacao_hash text UNIQUE,
  codigo_expira_em     timestamptz,
  token_hash           text UNIQUE,
  ativado_em           timestamptz,
  ultimo_uso_em        timestamptz,
  revogado_em          timestamptz,
  criado_por           uuid REFERENCES usuario (id),
  criado_em            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dispositivo_casa ON dispositivo (casa_id);

ALTER TABLE dispositivo ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispositivo FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON dispositivo
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
CREATE POLICY busca_por_chave ON dispositivo FOR SELECT
  USING (
    (token_hash IS NOT NULL AND token_hash = NULLIF(current_setting('app.dispositivo_hash', true), ''))
    OR
    (codigo_ativacao_hash IS NOT NULL
      AND codigo_ativacao_hash = NULLIF(current_setting('app.ativacao_hash', true), ''))
  );

-- ---------------------------------------------------------------------------------------------
-- sessao
-- ---------------------------------------------------------------------------------------------
CREATE TYPE tipo_sessao AS ENUM ('web', 'tablet');

CREATE TABLE sessao (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id              uuid NOT NULL REFERENCES casa (id),
  usuario_id           uuid NOT NULL REFERENCES usuario (id),
  dispositivo_id       uuid REFERENCES dispositivo (id),
  tipo                 tipo_sessao NOT NULL,
  token_hash           text NOT NULL UNIQUE,
  mfa_ok               boolean NOT NULL DEFAULT false,
  criada_em            timestamptz NOT NULL DEFAULT now(),
  ultimo_uso_em        timestamptz NOT NULL DEFAULT now(),
  expira_em            timestamptz NOT NULL,
  inatividade_segundos integer NOT NULL CHECK (inatividade_segundos > 0),
  reautenticado_em     timestamptz,
  revogada_em          timestamptz,
  ip                   text,
  CONSTRAINT sessao_tablet_tem_dispositivo CHECK (tipo <> 'tablet' OR dispositivo_id IS NOT NULL)
);

CREATE INDEX sessao_usuario ON sessao (usuario_id);
CREATE INDEX sessao_casa ON sessao (casa_id);

ALTER TABLE sessao ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessao FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON sessao
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
CREATE POLICY busca_por_token ON sessao FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.sessao_hash', true), ''));
