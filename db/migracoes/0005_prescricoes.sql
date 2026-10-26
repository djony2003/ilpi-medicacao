-- 0005_prescricoes: catálogo de medicamentos, prescrições versionadas, horários e receitas.
--
-- O sistema não prescreve: o enfermeiro ou gestor transcreve a receita médica. Uma prescrição
-- NUNCA é alterada depois de criada. Mudar dose, via ou horário encerra a versão atual e cria uma
-- nova (mesmo grupo_id, versão + 1). O gatilho abaixo garante isso no banco, mesmo que o código da
-- aplicação erre: só o estado (ativa -> encerrada/substituída) pode mudar.

CREATE TYPE forma_farmaceutica AS ENUM (
  'comprimido', 'capsula', 'gotas', 'xarope', 'solucao', 'suspensao', 'injetavel',
  'pomada', 'creme', 'adesivo', 'spray', 'supositorio', 'po', 'outro'
);
CREATE TYPE unidade_dose AS ENUM (
  'comprimido', 'capsula', 'gotas', 'ml', 'mg', 'g', 'mcg', 'ui', 'aplicacao', 'jato', 'adesivo'
);
CREATE TYPE via_administracao AS ENUM (
  'oral', 'sublingual', 'topica', 'oftalmica', 'otica', 'nasal', 'inalatoria', 'retal',
  'subcutanea', 'intramuscular', 'intravenosa', 'transdermica'
);
CREATE TYPE tipo_prescricao AS ENUM ('regular', 'sos');
CREATE TYPE status_prescricao AS ENUM ('ativa', 'encerrada', 'substituida');

-- Catálogo da casa. O princípio ativo é o que a conferência de alergia compara.
CREATE TABLE medicamento (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id          uuid NOT NULL REFERENCES casa (id),
  nome_comercial   text NOT NULL CHECK (length(btrim(nome_comercial)) BETWEEN 2 AND 200),
  principio_ativo  text NOT NULL CHECK (length(btrim(principio_ativo)) BETWEEN 2 AND 200),
  concentracao     text CHECK (concentracao IS NULL OR length(btrim(concentracao)) BETWEEN 1 AND 60),
  forma            forma_farmaceutica NOT NULL,
  -- Sugestão para novas prescrições; a decisão final é de quem prescreve.
  alto_risco_padrao boolean NOT NULL DEFAULT false,
  ativo            boolean NOT NULL DEFAULT true,
  criado_por       uuid REFERENCES usuario (id),
  criado_em        timestamptz NOT NULL DEFAULT now(),
  desativado_em    timestamptz,
  UNIQUE (id, casa_id),
  CONSTRAINT medicamento_desativado_coerente CHECK (ativo OR desativado_em IS NOT NULL)
);

-- Impede o mesmo medicamento duas vezes no catálogo (ignorando maiúsculas e espaços nas pontas).
CREATE UNIQUE INDEX medicamento_unico ON medicamento (
  casa_id, lower(btrim(nome_comercial)), lower(btrim(principio_ativo)),
  lower(coalesce(btrim(concentracao), '')), forma
);

ALTER TABLE medicamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicamento FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON medicamento
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

CREATE TABLE prescricao (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id             uuid NOT NULL REFERENCES casa (id),
  idoso_id            uuid NOT NULL,
  medicamento_id      uuid NOT NULL,
  -- Todas as versões da mesma prescrição compartilham o grupo.
  grupo_id            uuid NOT NULL,
  versao              integer NOT NULL CHECK (versao >= 1),
  substitui_id        uuid,
  tipo                tipo_prescricao NOT NULL,
  dose                numeric(10, 3) NOT NULL CHECK (dose > 0),
  unidade             unidade_dose NOT NULL,
  via                 via_administracao NOT NULL,
  instrucoes          text CHECK (instrucoes IS NULL OR length(instrucoes) <= 500),
  inicio              date NOT NULL,
  -- NULL = uso contínuo.
  fim                 date,
  alto_risco          boolean NOT NULL DEFAULT false,
  -- Só para SOS: indicação, limite por dia e intervalo mínimo entre doses.
  sos_indicacao       text CHECK (sos_indicacao IS NULL OR length(btrim(sos_indicacao)) BETWEEN 3 AND 200),
  sos_limite_diario   integer CHECK (sos_limite_diario IS NULL OR sos_limite_diario BETWEEN 1 AND 24),
  sos_intervalo_min   integer CHECK (sos_intervalo_min IS NULL OR sos_intervalo_min BETWEEN 1 AND 1440),
  -- Quem receitou, como está na receita (texto livre, sem vínculo com usuário do sistema).
  prescritor          text CHECK (prescritor IS NULL OR length(btrim(prescritor)) BETWEEN 2 AND 200),
  -- Por que esta versão existe (obrigatório a partir da versão 2: correção sem justificativa não vale).
  justificativa       text CHECK (justificativa IS NULL OR length(btrim(justificativa)) BETWEEN 3 AND 500),
  status              status_prescricao NOT NULL DEFAULT 'ativa',
  encerrada_em        timestamptz,
  encerrada_por       uuid REFERENCES usuario (id),
  motivo_encerramento text CHECK (motivo_encerramento IS NULL OR length(btrim(motivo_encerramento)) BETWEEN 3 AND 500),
  criado_por          uuid REFERENCES usuario (id),
  criado_em           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, casa_id),
  UNIQUE (grupo_id, versao),
  FOREIGN KEY (idoso_id, casa_id) REFERENCES idoso (id, casa_id),
  FOREIGN KEY (medicamento_id, casa_id) REFERENCES medicamento (id, casa_id),
  FOREIGN KEY (substitui_id, casa_id) REFERENCES prescricao (id, casa_id),
  CONSTRAINT prescricao_fim_depois_do_inicio CHECK (fim IS NULL OR fim >= inicio),
  CONSTRAINT prescricao_sos_completa CHECK (
    (tipo = 'sos' AND sos_indicacao IS NOT NULL AND sos_limite_diario IS NOT NULL AND sos_intervalo_min IS NOT NULL)
    OR (tipo = 'regular' AND sos_indicacao IS NULL AND sos_limite_diario IS NULL AND sos_intervalo_min IS NULL)
  ),
  CONSTRAINT prescricao_versao_justificada CHECK (versao = 1 OR justificativa IS NOT NULL),
  CONSTRAINT prescricao_versao_encadeada CHECK ((versao = 1) = (substitui_id IS NULL)),
  CONSTRAINT prescricao_encerramento_coerente CHECK (
    (status = 'ativa' AND encerrada_em IS NULL AND encerrada_por IS NULL AND motivo_encerramento IS NULL)
    OR (status <> 'ativa' AND encerrada_em IS NOT NULL)
  )
);

-- No máximo uma versão ativa por prescrição.
CREATE UNIQUE INDEX prescricao_uma_ativa_por_grupo ON prescricao (grupo_id) WHERE status = 'ativa';
CREATE INDEX prescricao_idoso_ativa ON prescricao (idoso_id) WHERE status = 'ativa';
CREATE INDEX prescricao_medicamento ON prescricao (medicamento_id) WHERE status = 'ativa';

ALTER TABLE prescricao ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescricao FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON prescricao
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());

-- Só o estado da prescrição pode mudar depois de criada. Todo o resto é conteúdo clínico: para
-- mudar, cria-se uma nova versão.
CREATE FUNCTION prescricao_conteudo_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.casa_id, OLD.idoso_id, OLD.medicamento_id, OLD.grupo_id, OLD.versao,
      OLD.substitui_id, OLD.tipo, OLD.dose, OLD.unidade, OLD.via, OLD.instrucoes, OLD.inicio,
      OLD.fim, OLD.alto_risco, OLD.sos_indicacao, OLD.sos_limite_diario, OLD.sos_intervalo_min,
      OLD.prescritor, OLD.justificativa, OLD.criado_por, OLD.criado_em)
     IS DISTINCT FROM
     (NEW.id, NEW.casa_id, NEW.idoso_id, NEW.medicamento_id, NEW.grupo_id, NEW.versao,
      NEW.substitui_id, NEW.tipo, NEW.dose, NEW.unidade, NEW.via, NEW.instrucoes, NEW.inicio,
      NEW.fim, NEW.alto_risco, NEW.sos_indicacao, NEW.sos_limite_diario, NEW.sos_intervalo_min,
      NEW.prescritor, NEW.justificativa, NEW.criado_por, NEW.criado_em)
  THEN
    RAISE EXCEPTION 'O conteúdo de uma prescrição não pode ser alterado: crie uma nova versão.';
  END IF;
  -- Uma prescrição encerrada ou substituída nunca volta a ficar ativa.
  IF OLD.status <> 'ativa' AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.encerrada_em IS DISTINCT FROM OLD.encerrada_em
      OR NEW.encerrada_por IS DISTINCT FROM OLD.encerrada_por
      OR NEW.motivo_encerramento IS DISTINCT FROM OLD.motivo_encerramento) THEN
    RAISE EXCEPTION 'Prescrição encerrada não pode ser reaberta.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER prescricao_sem_alterar_conteudo
  BEFORE UPDATE ON prescricao
  FOR EACH ROW EXECUTE FUNCTION prescricao_conteudo_imutavel();

-- Horários de uma versão. Dias: 1 = segunda ... 7 = domingo (ISO).
CREATE TABLE horario_prescricao (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id       uuid NOT NULL REFERENCES casa (id),
  prescricao_id uuid NOT NULL,
  -- Hora de parede no fuso da casa.
  hora          time(0) NOT NULL,
  dias_semana   smallint[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[],
  FOREIGN KEY (prescricao_id, casa_id) REFERENCES prescricao (id, casa_id),
  UNIQUE (prescricao_id, hora),
  CONSTRAINT horario_dias_validos CHECK (
    cardinality(dias_semana) BETWEEN 1 AND 7
    AND dias_semana <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
  )
);

ALTER TABLE horario_prescricao ENABLE ROW LEVEL SECURITY;
ALTER TABLE horario_prescricao FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON horario_prescricao
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
-- Os horários pertencem a uma versão imutável: a aplicação só insere.
REVOKE UPDATE ON horario_prescricao FROM ilpi_app;

-- Foto ou PDF da receita, guardado em armazenamento privado. Aqui fica só a referência.
CREATE TABLE receita_prescricao (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id       uuid NOT NULL REFERENCES casa (id),
  prescricao_id uuid NOT NULL,
  -- Chave do objeto no armazenamento (aleatória, sem relação com o paciente).
  chave         text NOT NULL UNIQUE CHECK (chave ~ '^[a-z0-9/_-]{20,200}$'),
  tipo_mime     text NOT NULL CHECK (tipo_mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  tamanho_bytes integer NOT NULL CHECK (tamanho_bytes BETWEEN 1 AND 10485760),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  enviado_por   uuid REFERENCES usuario (id),
  enviado_em    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (prescricao_id, casa_id) REFERENCES prescricao (id, casa_id)
);

CREATE INDEX receita_prescricao_idx ON receita_prescricao (prescricao_id);

ALTER TABLE receita_prescricao ENABLE ROW LEVEL SECURITY;
ALTER TABLE receita_prescricao FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON receita_prescricao
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
REVOKE UPDATE ON receita_prescricao FROM ilpi_app;
