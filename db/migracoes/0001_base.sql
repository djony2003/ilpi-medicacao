-- 0001_base: contexto da requisição e privilégios padrão.
-- Executada pelo papel ilpi_migrador.

-- O contexto da casa e do usuário vem de variáveis locais à transação, definidas pela
-- aplicação (ver src/compartilhado/banco/transacao.ts). Sem contexto, a função devolve NULL
-- e nenhuma política de RLS libera linhas. Um valor que não seja UUID gera erro (falha fechada).
CREATE FUNCTION public.app_casa_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.casa_id', true), '')::uuid $$;

CREATE FUNCTION public.app_usuario_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.usuario_id', true), '')::uuid $$;

-- A aplicação lê, insere e atualiza. Não existe DELETE por padrão: nada de negócio é apagado.
-- Tabelas que precisem de regras mais restritas (como a auditoria) ajustam seus privilégios.
ALTER DEFAULT PRIVILEGES FOR ROLE ilpi_migrador IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ilpi_app;

ALTER DEFAULT PRIVILEGES FOR ROLE ilpi_migrador IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ilpi_app;
