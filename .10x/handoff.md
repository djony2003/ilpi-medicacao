# Handoff

**De:** Implementação, marco M0 concluído
**Para:** Implementação, marco M1 (identidade e auditoria), começando pelo Arquiteto
**Data:** 2026-10-25

## Onde estamos
Código em `/home/claude/ilpi` (repositório git próprio, com o histórico do `.10x`). M0 pronto: projeto, CI, banco com papéis corretos, contexto de casa por transação, verificação de RLS, log e ambiente. Detalhes em `.10x/decisions/sde/medicacao-ilpi.md` e `.10x/decisions/dba/medicacao-ilpi.md`.

Para rodar: `docker compose up -d` (ou um PostgreSQL 16 local), `cp .env.example .env`, `npm install`, `npm run db:setup && npm run db:migrar`, `npm run verificar`.

## Decisão a tomar ANTES de T07 (Arquiteto + DBA)
**Como o login localiza o usuário antes de haver casa no contexto.** Com `FORCE ROW LEVEL SECURITY`, nem uma função `SECURITY DEFINER` do dono escapa da política, e `app_casa_id()` ainda é NULL na hora do login. Opções:
1. **Política de leitura por e-mail de login:** `usuario` ganha uma política `SELECT` adicional que libera a linha cujo e-mail é igual a `current_setting('app.login_email')`, definido por um utilitário `comContextoDeLogin`. A aplicação só enxerga o usuário que ela mesma nomeou.
2. **Tabela de identidade separada**, sem dados da casa, consultada antes do contexto.
3. **Papel separado só para login**, com permissão mínima.

Recomendação: opção 1, por manter um único papel de aplicação e o mesmo mecanismo de RLS. Registrar como **ADR-002** e testar com o harness de isolamento (um e-mail não pode revelar usuário de outra casa por nenhum outro caminho). O PIN de tablet resolve a casa pelo dispositivo aprovado, o que evita o problema nesse fluxo.

## Próximas tarefas
M1: T07 a T16, na ordem do plano. Fazer a auditoria (T08) antes do login, para que tudo que vier depois já nasça auditado. A tabela de auditoria precisa de `REVOKE UPDATE` para `ilpi_app`, porque o padrão do banco concede UPDATE.

## Regras
- Uma tarefa por vez, commit pequeno, teste da regra de segurança junto.
- Ao fim do marco: atualizar `status.md`, `decisions/sde` e `decisions/dba`.
- Tabela nova: RLS habilitado e forçado, política `isolamento`, teste de vazamento. O teste `rls-em-todas-as-tabelas` barra a esquecida.

## Pontos de decisão com o usuário
Após M3 (validação de mercado), após M5 (demonstração do registro com QR) e antes de M8 (casa-piloto e fornecedores).
