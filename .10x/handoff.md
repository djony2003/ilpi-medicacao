# Handoff

**De:** Implementação, marco M3 concluído
**Para:** Decisão do usuário (validação de mercado); depois, M4 (estoque)
**Data:** 2026-10-26

## Onde estamos
Código em `/home/claude/ilpi` (repositório git próprio, com o histórico do `.10x`; remoto privado `djony2003/ilpi-medicacao`). M0 a M3 prontos: fundação, identidade (login com senha e TOTP, PIN no tablet aprovado, sessões, permissões, gestão de usuários), auditoria encadeada, API HTTP com malha de vazamento, idosos com pulseira QR e PDF, prescrições versionadas com receita cifrada, e escala de doses (geração idempotente com fuso e horário de verão, agendador, escala do plantão e folha de contingência em PDF). Detalhes em `.10x/decisions/sde/medicacao-ilpi.md` e `.10x/decisions/dba/medicacao-ilpi.md`; decisões em `.10x/adrs/` (001 monólito modular com RLS, 002 busca por chave secreta sob RLS).

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

## Padrões que M3 acrescentou
- **Doses:** `dose_agendada` nasce da geração (`gerarDosesDaCasa`), nunca à mão; cancelamento é por gatilho. M5 (registro) deve ligar o estado `concluida` em `dados/escala.ts` (hoje `registrada: false`) e usar `classificarRegistro` para as regras de janela.
- **Agendador:** `npm run agendador` com `AGENDADOR_DATABASE_URL` (papel `ilpi_agendador`); `db:setup` exige `ILPI_AGENDADOR_PASSWORD`. Tarefa nova do agendador: acrescentar em `execucao_agendador.tarefa` (CHECK) e no laço.
- **Relógio:** tudo que grava horário de negócio usa `Servico.agora` (inclusive `prescricao.criado_em`); gatilhos usam o horário gravado, não `now()`.
- **Orquestração entre módulos** fica na camada web (`gerarEscalaAposMudanca`), não módulo chamando módulo.
- **Mutação:** ao testar o gatilho no SQL, altere `db/migracoes/0006_escala.sql`: o banco de teste é refeito a cada execução.

## Próximas tarefas
Decisão do usuário: validar com 2 ou 3 casas antes de seguir. Depois, M4 (estoque, T29 a T34): lotes e validade, entrada, saldo por medicamento, baixa na administração (M5), alerta de estoque baixo e vencimento, etiqueta com QR do lote (`desenharQr` já existe em `compartilhado/pdf.ts`).

## Limitações herdadas (não esquecer)
Armazenamento de receitas em disco local e chave única (M8); alergia conferida por nome, com tabela curta de sinônimos; sem limite de tentativas por IP; IP de `X-Forwarded-For` serve só de rastro; PIN errado trava também o login web da mesma pessoa; e-mail único no sistema; sessões vencidas não são apagadas; auditoria sem âncora externa; telas ainda não existem. Lista completa em `decisions/sde`.

## Pontos de decisão com o usuário
**Agora (após M3): validação de mercado.** Depois, após M5 (demonstração do registro com QR) e antes de M8 (casa-piloto e fornecedores).
