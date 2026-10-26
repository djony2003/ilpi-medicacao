# Handoff

**De:** Implementação, marco M2 concluído
**Para:** Implementação, marco M3 (escala de doses); ao final de M3, ponto de decisão com o usuário (validação de mercado)
**Data:** 2026-10-26

## Onde estamos
Código em `/home/claude/ilpi` (repositório git próprio, com o histórico do `.10x`; remoto privado `djony2003/ilpi-medicacao`). M0, M1 e M2 prontos: fundação, identidade (login com senha e TOTP, PIN no tablet aprovado, sessões, permissões, gestão de usuários), auditoria encadeada, API HTTP com malha de vazamento, idosos com pulseira QR e PDF, e prescrições versionadas com receita cifrada. Detalhes em `.10x/decisions/sde/medicacao-ilpi.md` e `.10x/decisions/dba/medicacao-ilpi.md`; decisões em `.10x/adrs/` (001 monólito modular com RLS, 002 busca por chave secreta sob RLS).

Para rodar: `docker compose up -d` (ou um PostgreSQL 16 local), `cp .env.example .env`, `npm install`, `npm run db:setup && npm run db:migrar`, `npm run verificar`.

## Como acrescentar o que vem agora (padrões que M1 estabeleceu)
- **Tabela nova:** `casa_id` + RLS habilitado e forçado + política `isolamento`; o teste `rls-em-todas-as-tabelas` barra a esquecida.
- **Toda ação que muda dado:** dentro de `comContexto`, com `registrarAuditoria` na MESMA transação. Nunca registrar senha, PIN, token, segredo ou código (a função recusa).
- **Rota nova:** entrar em `ROTAS` de `src/web/api.ts` declarando `acesso` e, se administrativa, `permissao`. A malha `tests/vazamento/api-sem-vazamento.test.ts` a pega sozinha (401 sem credencial, 403 por perfil, 404 para id de outra casa, origem estranha). Se for rota pública, o teste de inventário falha de propósito: exige decisão consciente.
- **Permissão nova:** acrescentar em `ACOES` e na matriz; o teste de permissões obriga atualizar a tabela da spec também.
- **Módulos só se conhecem pelo `index.ts`** (regra de lint). Funções do módulo recebem `Servico` (`pool`, `chaveCampos`, `agora` injetável para testar prazos).
- **Teste de mutação:** em regra de segurança nova, quebre o código de propósito e confirme que algum teste falha. Duas vezes isso mostrou lacuna nos testes.

## Padrões que M2 acrescentou
- **Rotas por arquivo:** `src/web/rotas-<módulo>.ts` exporta um `Rota[]` e `api.ts` o inclui; tipos e ajudantes comuns em `src/web/rota.ts` (`sessaoDe`, `uuidDaRota`, `respostaDeFalha`). Falha de regra é valor (`Falha`), traduzida por `respostaDeFalha`; permissão e reautenticação continuam exceções.
- **Toda rota com sessão declara `permissao`** (teste com lista de exceções fechada). Rota de arquivo: `Navegador` dos testes aceita `binario` e devolve `bytes`.
- **Malha de vazamento:** ao criar rota com id, dê ao teste os canários da casa B (ids por prefixo de rota em `api-sem-vazamento.test.ts`) e um corpo válido em `CORPOS_VALIDOS`, para o 404 vir do isolamento e não da validação.
- **Filho de tabela com casa:** chave estrangeira composta `(pai_id, casa_id)`; conteúdo que não pode mudar fica protegido por gatilho no banco, além do código.
- **Datas de calendário** são texto `AAAA-MM-DD` (`src/compartilhado/datas.ts`); "hoje" vem do banco no fuso da casa (`hojeNaCasa`). O relógio injetável (`Servico.agora`) vale para os dois.
- **Arquivos:** `Servico.armazenamento` (interface `Armazenamento`); cifrar com `cifrarBytes(bytes, chave, contexto = chave do objeto)`; tipo pelo conteúdo; leitura só pela API, com auditoria.
- **Conferência de alergia** é `conflitosComAlergia` (domínio puro); o registro da dose em M5 deve repetir a conferência no momento da administração.

## Próximas tarefas
M3: T24 a T28 (escala de doses). Antes de T24, Arquiteto + DBA: `dose_agendada` (prescrição, idoso, data e hora previstas no fuso da casa, estado), gerador idempotente por dia (horário de verão e fusos), janela de horário da dose, regras para prescrição nova/encerrada/vencida no meio do dia, e a visão de escala por plantão para o tablet (`escala.ver`). Usar `horariosNoDia` e `situacaoDeVigencia` do módulo `prescricoes` (interface pública). Ao concluir M3: ponto de decisão com o usuário.

## Limitações herdadas (não esquecer)
Armazenamento de receitas em disco local e chave única (M8); alergia conferida por nome, com tabela curta de sinônimos; sem limite de tentativas por IP; IP de `X-Forwarded-For` serve só de rastro; PIN errado trava também o login web da mesma pessoa; e-mail único no sistema; sessões vencidas não são apagadas; auditoria sem âncora externa; telas ainda não existem. Lista completa em `decisions/sde`.

## Pontos de decisão com o usuário
Após M3 (validação de mercado), após M5 (demonstração do registro com QR) e antes de M8 (casa-piloto e fornecedores).
