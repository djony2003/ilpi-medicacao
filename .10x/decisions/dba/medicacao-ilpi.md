# DBA — medicacao-ilpi

## Estado em M0 (2026-10-25)

### Papéis
| Papel | Uso | Atributos |
|---|---|---|
| `ilpi_migrador` | Dono do schema `public`; executa as migrações | LOGIN, sem superusuário, sem BYPASSRLS, sem CREATEDB e CREATEROLE |
| `ilpi_app` | Aplicação | LOGIN, sem superusuário, sem BYPASSRLS, sem CREATEDB e CREATEROLE, sem CREATE no schema |

Ambos conferidos por teste automatizado contra o catálogo `pg_roles`.

### Schemas
- `public`: tabelas de negócio. `PUBLIC` sem privilégios, `ilpi_app` com USAGE.
- `controle`: `controle.migracoes` (id, checksum, aplicada_em). A aplicação não tem acesso (testado).

### Funções de contexto (migração 0001)
- `app_casa_id()` e `app_usuario_id()`: leem `app.casa_id` e `app.usuario_id` definidos por `set_config(..., true)` dentro da transação. Valor vazio ou ausente devolve NULL, e nenhuma política libera linhas. Valor que não seja UUID causa erro (falha fechada, testado).

### Privilégios padrão para tabelas novas (do papel `ilpi_migrador`, schema `public`)
`ilpi_app` recebe SELECT, INSERT e UPDATE. Não recebe DELETE nem TRUNCATE (testado). Sequências: USAGE e SELECT.

### Padrão obrigatório para toda tabela de negócio
```sql
CREATE TABLE exemplo (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casa_id uuid NOT NULL,
  -- demais colunas
);
ALTER TABLE exemplo ENABLE ROW LEVEL SECURITY;
ALTER TABLE exemplo FORCE ROW LEVEL SECURITY;
CREATE POLICY isolamento ON exemplo
  USING (casa_id = app_casa_id())
  WITH CHECK (casa_id = app_casa_id());
```
A tabela `casa` usa `id = app_casa_id()` no lugar de `casa_id`. O teste `rls-em-todas-as-tabelas` reprova a migração que criar tabela sem RLS habilitado e forçado.

### Runner de migrações
Arquivos `db/migracoes/NNNN_nome.sql`, aplicados em ordem, cada um em uma transação, com bloqueio consultivo contra execução simultânea e checksum SHA-256. Alterar uma migração já aplicada faz o runner falhar. Rodar de novo é seguro (testado).

### Pendências para M1
- **Login antes de haver casa no contexto:** o login precisa localizar o usuário por e-mail antes de saber a casa, e `FORCE ROW LEVEL SECURITY` vale até para funções `SECURITY DEFINER` do dono. Decisão de arquitetura necessária em M1 (ver handoff).
- **Auditoria:** a tabela precisa de `REVOKE UPDATE` para `ilpi_app` (o padrão concede UPDATE) e de política que só permita INSERT e SELECT.
- Índices: ainda não há tabelas de negócio.
