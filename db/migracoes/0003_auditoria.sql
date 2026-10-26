-- 0003_auditoria: trilha de auditoria imutável, com hash encadeado por casa.
--
-- Garantias, em camadas:
--  1. A aplicação só tem INSERT e SELECT (UPDATE é revogado; DELETE e TRUNCATE nunca foram dados).
--  2. As políticas de RLS só existem para SELECT e INSERT: nem o dono consegue enxergar linhas
--     para alterá-las ou apagá-las.
--  3. Gatilhos recusam UPDATE, DELETE e TRUNCATE mesmo para quem ignora o RLS.
--  4. Cada linha guarda o hash da anterior. Alterar, apagar ou reordenar quebra a cadeia, e a
--     função auditoria_verificar() aponta a primeira linha com problema.
--
-- Limite conhecido: apagar as ÚLTIMAS linhas não quebra a cadeia. Para detectar isso é preciso
-- ancorar o hash mais recente fora do banco (planejado no marco M8).

-- Codifica um campo com tamanho na frente, para que "ab"+"c" e "a"+"bc" nunca gerem o mesmo texto.
-- NULL usa um marcador próprio ("~"), diferente de texto vazio ("0:").
CREATE FUNCTION auditoria_campo(valor text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT CASE WHEN valor IS NULL THEN '~' ELSE length(valor)::text || ':' || valor END $$;

CREATE FUNCTION auditoria_calcular_hash(
  p_anterior    text,
  p_casa        uuid,
  p_seq         bigint,
  p_usuario     uuid,
  p_acao        text,
  p_entidade    text,
  p_entidade_id text,
  p_antes       jsonb,
  p_depois      jsonb,
  p_dispositivo uuid,
  p_ip          text,
  p_ocorrido    timestamptz
) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT encode(
      sha256(convert_to(
        auditoria_campo(p_anterior)
        || auditoria_campo(p_casa::text)
        || auditoria_campo(p_seq::text)
        || auditoria_campo(p_usuario::text)
        || auditoria_campo(p_acao)
        || auditoria_campo(p_entidade)
        || auditoria_campo(p_entidade_id)
        || auditoria_campo(p_antes::text)
        || auditoria_campo(p_depois::text)
        || auditoria_campo(p_dispositivo::text)
        || auditoria_campo(p_ip)
        || auditoria_campo(extract(epoch FROM p_ocorrido)::text),
        'UTF8'
      )),
      'hex'
    )
  $$;

CREATE TABLE auditoria (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  casa_id        uuid NOT NULL REFERENCES casa (id),
  seq            bigint NOT NULL,
  usuario_id     uuid REFERENCES usuario (id),
  acao           text NOT NULL,
  entidade       text NOT NULL,
  entidade_id    text,
  antes          jsonb,
  depois         jsonb,
  dispositivo_id uuid REFERENCES dispositivo (id),
  ip             text,
  ocorrido_em    timestamptz NOT NULL,
  hash_anterior  text,
  hash           text NOT NULL,
  CONSTRAINT auditoria_seq_unica UNIQUE (casa_id, seq)
);

CREATE INDEX auditoria_por_data ON auditoria (casa_id, ocorrido_em DESC);
CREATE INDEX auditoria_por_entidade ON auditoria (casa_id, entidade, entidade_id);

-- Define a posição na cadeia e o hash. Os valores informados pelo chamador para seq, ocorrido_em,
-- hash_anterior e hash são sempre sobrescritos: quem insere não escolhe a própria posição.
-- O bloqueio consultivo serializa as escritas da mesma casa (e só dela) até o fim da transação.
CREATE FUNCTION auditoria_encadear() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_seq  bigint;
  v_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.casa_id::text, 7310002));

  SELECT a.seq, a.hash INTO v_seq, v_hash
    FROM auditoria a
   WHERE a.casa_id = NEW.casa_id
   ORDER BY a.seq DESC
   LIMIT 1;

  NEW.seq := coalesce(v_seq, 0) + 1;
  NEW.hash_anterior := v_hash;
  NEW.ocorrido_em := clock_timestamp();
  NEW.hash := auditoria_calcular_hash(
    NEW.hash_anterior, NEW.casa_id, NEW.seq, NEW.usuario_id, NEW.acao, NEW.entidade,
    NEW.entidade_id, NEW.antes, NEW.depois, NEW.dispositivo_id, NEW.ip, NEW.ocorrido_em
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER auditoria_encadeia
  BEFORE INSERT ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_encadear();

CREATE FUNCTION auditoria_imutavel() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'A trilha de auditoria é imutável (% em auditoria).', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER auditoria_sem_alteracao
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_imutavel();

CREATE TRIGGER auditoria_sem_truncate
  BEFORE TRUNCATE ON auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_imutavel();

-- Privilégios: o padrão do banco concede UPDATE; aqui ele é retirado.
REVOKE UPDATE ON auditoria FROM ilpi_app;

ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria FORCE ROW LEVEL SECURITY;
CREATE POLICY leitura ON auditoria FOR SELECT
  USING (casa_id = app_casa_id());
CREATE POLICY insercao ON auditoria FOR INSERT
  WITH CHECK (casa_id = app_casa_id());

-- Confere a cadeia da casa do contexto atual (o RLS limita as linhas lidas).
-- Devolve a primeira linha com problema, ou nenhuma linha se a cadeia está íntegra.
CREATE FUNCTION auditoria_verificar() RETURNS TABLE (seq_com_problema bigint, problema text)
  LANGUAGE sql STABLE
  AS $$
    WITH linhas AS (
      SELECT a.*,
             lag(a.hash) OVER janela AS hash_da_anterior,
             lag(a.seq)  OVER janela AS seq_da_anterior
        FROM auditoria a
      WINDOW janela AS (PARTITION BY a.casa_id ORDER BY a.seq)
    ),
    avaliadas AS (
      SELECT l.seq,
             CASE
               WHEN l.seq_da_anterior IS NULL AND l.seq <> 1 THEN 'inicio_ausente'
               WHEN l.seq_da_anterior IS NOT NULL AND l.seq <> l.seq_da_anterior + 1 THEN 'lacuna'
               WHEN l.hash_anterior IS DISTINCT FROM l.hash_da_anterior THEN 'encadeamento_quebrado'
               WHEN l.hash <> auditoria_calcular_hash(
                      l.hash_anterior, l.casa_id, l.seq, l.usuario_id, l.acao, l.entidade,
                      l.entidade_id, l.antes, l.depois, l.dispositivo_id, l.ip, l.ocorrido_em
                    ) THEN 'conteudo_adulterado'
             END AS problema
        FROM linhas l
    )
    SELECT e.seq, e.problema FROM avaliadas e WHERE e.problema IS NOT NULL ORDER BY e.seq LIMIT 1
  $$;
