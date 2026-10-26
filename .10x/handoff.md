# Handoff

**De:** Implementação, marco M1 concluído
**Para:** Implementação, marco M2 (idosos e prescrições), começando pelo Arquiteto e DBA
**Data:** 2026-10-25

## Onde estamos
Código em `/home/claude/ilpi` (repositório git próprio, com o histórico do `.10x`; remoto privado `djony2003/ilpi-medicacao`). M0 e M1 prontos: fundação, identidade (login com senha e TOTP, PIN no tablet aprovado, sessões, permissões, gestão de usuários), auditoria encadeada e API HTTP com malha de vazamento. Detalhes em `.10x/decisions/sde/medicacao-ilpi.md` e `.10x/decisions/dba/medicacao-ilpi.md`; decisões em `.10x/adrs/` (001 monólito modular com RLS, 002 busca por chave secreta sob RLS).

Para rodar: `docker compose up -d` (ou um PostgreSQL 16 local), `cp .env.example .env`, `npm install`, `npm run db:setup && npm run db:migrar`, `npm run verificar`.

## Como acrescentar o que vem agora (padrões que M1 estabeleceu)
- **Tabela nova:** `casa_id` + RLS habilitado e forçado + política `isolamento`; o teste `rls-em-todas-as-tabelas` barra a esquecida.
- **Toda ação que muda dado:** dentro de `comContexto`, com `registrarAuditoria` na MESMA transação. Nunca registrar senha, PIN, token, segredo ou código (a função recusa).
- **Rota nova:** entrar em `ROTAS` de `src/web/api.ts` declarando `acesso` e, se administrativa, `permissao`. A malha `tests/vazamento/api-sem-vazamento.test.ts` a pega sozinha (401 sem credencial, 403 por perfil, 404 para id de outra casa, origem estranha). Se for rota pública, o teste de inventário falha de propósito: exige decisão consciente.
- **Permissão nova:** acrescentar em `ACOES` e na matriz; o teste de permissões obriga atualizar a tabela da spec também.
- **Módulos só se conhecem pelo `index.ts`** (regra de lint). Funções do módulo recebem `Servico` (`pool`, `chaveCampos`, `agora` injetável para testar prazos).
- **Teste de mutação:** em regra de segurança nova, quebre o código de propósito e confirme que algum teste falha. Duas vezes isso mostrou lacuna nos testes.

## Próximas tarefas
M2: T17 a T23 (idosos e prescrições), na ordem do plano. Antes de T17, Arquiteto + DBA: modelo de `idoso`, `prescricao`, `medicamento`, catálogo e histórico (nada é apagado; edição vira nova versão), com RLS e auditoria desde a primeira linha. Dados de saúde: manter fora de logs (a lista de chaves proibidas do log cresce junto com o esquema).

## Limitações herdadas (não esquecer)
Sem limite de tentativas por IP; IP de `X-Forwarded-For` serve só de rastro; PIN errado trava também o login web da mesma pessoa; e-mail único no sistema; sessões vencidas não são apagadas; auditoria sem âncora externa; telas ainda não existem. Lista completa em `decisions/sde`.

## Pontos de decisão com o usuário
Após M3 (validação de mercado), após M5 (demonstração do registro com QR) e antes de M8 (casa-piloto e fornecedores).
