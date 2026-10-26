# SDE — medicacao-ilpi

## M0 Fundação — concluído em 2026-10-25 (T01 a T06)

### O que foi construído
- **Projeto** Next.js 16 com TypeScript estrito (`noUncheckedIndexedAccess`), Prettier, estrutura de pastas da decisão do Staff Engineer, cabeçalhos de segurança no `next.config.ts`. Projeto em `/home/claude/ilpi`.
- **Fronteiras de módulo:** regra local de ESLint (`eslint-rules/fronteiras-de-modulo.mjs`) que só permite importar outro módulo pelo `index`. Cobre alias `@/`, imports relativos, `export ... from` e `import()` dinâmico. 13 testes da regra e verificação com lint real.
- **CI** (`.github/workflows/ci.yml`): tipos, lint, formatação, banco PostgreSQL de serviço, testes, build, `npm audit` e gitleaks.
- **Banco:** `scripts/db-setup.mjs` (papéis e banco, idempotente), `scripts/migrar.mjs` (migrações com checksum e bloqueio consultivo), `db/migracoes/0001_base.sql`, `docker-compose.yml`, `.env.example`.
- **Contexto de casa:** `src/compartilhado/banco/transacao.ts` (`comContexto`), único caminho para consultar dados de uma casa.
- **Verificação de RLS:** `src/compartilhado/banco/verificar-rls.ts` (`tabelasSemRls`).
- **Log:** `src/compartilhado/log.ts`, com chaves proibidas por palavra, chaves terminadas em `Id` liberadas, máscara de e-mail e CPF, modo estrito fora de produção.
- **Ambiente:** `src/compartilhado/ambiente.ts`, com validação por Zod, mensagens sem valores e recusa de superusuário em produção.

### Verificação
66 testes passando (13 da regra de fronteiras, 30+ contra PostgreSQL real, 23 de log e ambiente), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades.
**Teste de mutação:** trocar a política de RLS por `USING (true)` derrubou 7 dos 9 testes de isolamento, o que confirma que os testes detectam um RLS quebrado.

### Desvios do plano
| Desvio | Motivo |
|---|---|
| Regra de fronteira própria em vez de `eslint-plugin-import` | O plugin não instalou junto com ESLint 10 (conflito de peer). A regra própria é pequena, testada e resolve alias e caminhos relativos |
| ESLint fixado na linha 9 | Consequência do conflito acima. Não reavaliei o ESLint 10 depois de remover o plugin |
| Runner de migrações próprio em vez de Drizzle Kit | O RLS e a auditoria exigem SQL escrito à mão; o Drizzle ORM entra em M1 para as consultas |
| Schema `controle` para o registro de migrações | Mantém a tabela fora do `public`, invisível à aplicação |
| Banco de teste fixo `ilpi_test` | Os testes criam e removem tabelas; nunca devem tocar o banco de desenvolvimento |
| Privilégios padrão sem DELETE e sem TRUNCATE | Reforça "nada é apagado" desde a primeira tabela |

### Dívida técnica e limitações conhecidas
- **A CI não foi executada de verdade:** só validei o YAML e rodei localmente cada passo. O gitleaks-action pode exigir licença em organizações.
- **`docker-compose.yml` não foi executado:** neste ambiente usei o PostgreSQL 16 local; só confirmei que o cliente do Docker existe.
- **ESLint 9** aparece como sem suporte no npm: reavaliar a migração para o 10.
- A lista de chaves proibidas do log precisa crescer junto com o esquema do banco.
- Sem `pg_hba` ou TLS configurados no banco local: apenas para desenvolvimento.
- O módulo de ambiente ainda não é usado por nenhum código de aplicação (entra com o login em M1).
