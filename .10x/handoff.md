# Handoff

**De:** Implementação, marco M5 concluído
**Para:** Demonstração do registro com QR ao usuário; depois, M6 (alertas)
**Data:** 2026-10-26

## Onde estamos
Código em `/home/claude/ilpi` (repositório git próprio, com o histórico do `.10x`; remoto privado `djony2003/ilpi-medicacao`). M0 a M3 prontos: fundação, identidade (login com senha e TOTP, PIN no tablet aprovado, sessões, permissões, gestão de usuários), auditoria encadeada, API HTTP com malha de vazamento, idosos com pulseira QR e PDF, prescrições versionadas com receita cifrada, escala de doses (geração idempotente com fuso e horário de verão, agendador, escala do plantão e folha de contingência em PDF) estoque (lotes com etiqueta QR, fracionamento para o idoso, saídas com reautenticação, previsão de término, lista de reposição em PDF, sobras e inventário com ajustes justificados) e administração (registro com conferência por QR, exceção, segunda validação, SOS, registro tardio) com as telas do tablet em `/tablet`.

Demonstração: `npm run demo` cria uma casa com equipe, tablet, residentes, remédios e doses para os próximos minutos, e grava os PDFs de pulseiras e etiquetas em `./demo`. `npm run e2e:tablet` (com o servidor no ar) percorre as telas num Chromium com câmera simulada. Detalhes em `.10x/decisions/sde/medicacao-ilpi.md` e `.10x/decisions/dba/medicacao-ilpi.md`; decisões em `.10x/adrs/` (001 monólito modular com RLS, 002 busca por chave secreta sob RLS).

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

## Padrões que M4 acrescentou
- **Saldo nunca é coluna:** é soma de `movimento_estoque` (view `saldo_lote`). Movimentos e lotes são imutáveis (gatilho + REVOKE UPDATE). Corrigir = novo movimento (`ajuste`).
- **Saldo não negativo no banco:** gatilho com `pg_advisory_xact_lock` por lote; a corrida vira `saldo_insuficiente` via `traduzirSaldoInsuficiente`.
- **Ordem estável:** tabelas de histórico têm `seq` identity (o relógio injetável gera horários iguais).
- **Quantidades em milésimos inteiros** (`dominio/quantidade.ts`); passo 0,25 para unidades contáveis.
- **Previsão é simulação dose a dose** (`dominio/previsao.ts`), FEFO, ignorando lote vencido; as "reservas" decidem se a prescrição consome do estoque individual ou do comum.
- **STATUS_DE_FALHA** em `src/web/rota.ts`: falha nova precisa de status lá.

## Padrões que M5 acrescentou
- **Registro sem estado no servidor:** o tablet manda tudo o que leu a cada chamada; `registrarDose` trava a dose (`FOR UPDATE`) e refaz a conferência inteira (`conferirDose`, pura) dentro da transação que grava. A tela nunca decide sozinha.
- **Idempotência:** chave UUID gerada pelo tablet por abertura da dose; conferida DEPOIS da trava (o reenvio simultâneo enxerga o primeiro). Índice único parcial `administracao_final_unica` como última barreira.
- **PIN de outra pessoa** (`confirmarPinDeOutraPessoa`, identidade) roda na transação de quem registra, com o mesmo contador de erros do login; na falha, nada além do contador é gravado.
- **Coerência no banco:** gatilho `administracao_coerente` (dose, prescrição, idoso e lote batem) e consumo de estoque com FK para a administração.
- **Bloqueio é dado, não erro:** `conferencia_bloqueada` com a lista de bloqueios (mensagem e ação da tabela 5.4) e auditoria `administracao.bloqueada` (quase-erro).
- **Telas (`src/app/tablet`):** cliente puro, só `import type` do servidor; leitor de QR com `BarcodeDetector` e reserva no jsQR, câmera contínua com pausa durante a conferência e descarte do código recém-recusado ou já aceito. Batida de conexão numa rota do APARELHO (`/tablet/usuarios`), para não renovar a sessão.

## Próximas tarefas
Demonstração do registro com QR ao usuário (ponto de decisão). Depois, M6 (T47 a T52): alertas (dose sem registro avisa o enfermeiro, SOS bloqueado, estoque baixo, vencimento). Pendências do M5: testar num tablet real (câmera, som, vibração, quiosque, `BarcodeDetector`); exceção de conferência para SOS só pela API (a tela não oferece); conversão de unidade continua bloqueando (mg x comprimido); média SOS real na previsão de estoque; telas web de gestão (cadastros, estoque, relatório de exceções) ainda não existem.

## Limitações herdadas (não esquecer)
Armazenamento de receitas em disco local e chave única (M8); alergia conferida por nome, com tabela curta de sinônimos; sem limite de tentativas por IP; IP de `X-Forwarded-For` serve só de rastro; PIN errado trava também o login web da mesma pessoa; e-mail único no sistema; sessões vencidas não são apagadas; auditoria sem âncora externa; telas ainda não existem. Lista completa em `decisions/sde`.

## Pontos de decisão com o usuário
**Agora (após M5): demonstração do registro com QR.** Antes de M8, a casa-piloto e fornecedores).
