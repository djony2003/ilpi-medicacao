# SDE — medicacao-ilpi

## M3 Escala de doses — concluído em 2026-10-26 (T24 a T28)

### O que foi construído
- **Domínio puro** (`src/modules/administracao/dominio`): `instanteLocal` (hora de parede + fuso → instante), `dosesDoPeriodo` (vigência, dias da semana, horários), `estadoDaDose` e `classificarRegistro` (janela de tolerância e limite maior, usados também pelo registro em M5), `compararParaEscala`.
- **Geração idempotente** (`gerarDosesDaCasa`): doses de ontem a 7 dias à frente para prescrições regulares ativas de idosos ativos; `INSERT ... ON CONFLICT DO NOTHING` sobre o índice único (prescrição, dia, hora) das doses não canceladas; ordem fixa das linhas para execuções paralelas não travarem umas às outras. Batimento por casa em `execucao_agendador`.
- **Agendador** (`npm run agendador`, `scripts/agendador.ts` + `src/agendador/laco.ts`): laço a cada 15 min (configurável de 1 a 60), falha de uma casa registrada sem parar as outras, parada limpa por SIGINT e SIGTERM, log só com tipo do erro. Sem trava entre cópias: duas rodando juntas são inofensivas (testado).
- **Escala do plantão** (`escalaDoPlantao`, `GET /escala`): atrasadas no topo, depois a janela atual e o que vem; alergias com as graves primeiro; padrão de 12 h atrás a 8 h à frente, teto de 48 h; até 3000 doses (indica `truncada`).
- **Folha de contingência** (`POST /escala/folha-de-contingencia`): PDF A4 paisagem, ordem de ronda (horário, quarto numérico, nome), colunas de hora real, rubrica e 2ª assinatura (alto risco), nome longo em duas linhas, alergias graves em vermelho, paginação e aviso se cortada. Cada emissão é auditada (`escala.folha_emitida`, só período e quantidade). Conferida visualmente e por `pdftotext`.
- **Geração imediata:** depois de prescrever, nova versão e alta do idoso (volta a "ativo"), a rota gera as doses na hora; falha ali só vai para o log (o agendador completa), nunca vira erro para quem prescreveu.

### Regras decididas (e testadas)
| Regra | Motivo |
|---|---|
| Só nasce dose com horário igual ou posterior à criação da versão da prescrição | Sem "dose fantasma": nova versão às 12h não ganha o horário das 8h que a antiga já cumpriu. Por isso `prescricao.criado_em` agora vem do relógio da aplicação, não do banco |
| Horário que não existe (salto do horário de verão) vira o instante da virada; horário repetido vale a primeira ocorrência | Ordem monotônica entre 02:30 e 03:00; ninguém recebe dose duas vezes |
| Só prescrição `regular` gera dose; SOS é sob demanda | Defesa testada mesmo com horário inserido direto no banco |
| Dose cancelada cujo horário já passou não renasce; a futura renasce | Idoso internado das 10h às 14h não "deve" a dose das 12h, mas volta a ter as de depois |
| Cancelamento por gatilho do banco, com horário de referência gravado pela aplicação | Vale para qualquer caminho de escrita e deixa o relógio injetável nos testes |
| Escala não mostra dose cancelada nem de idoso fora de "ativo" | Dose passada de quem foi internado não aparece como "sem registro" |

### Verificação
530 testes (30 arquivos, PostgreSQL real), tipos, lint, formatação, build com variáveis ausentes e `npm audit` limpos. Dezessete testes de mutação, todos detectados (guarda de ressurreição, regra da criação, dia anterior, filtros SOS e idoso ativo, gatilhos de prescrição e idoso, imutabilidade e cancelamento único, teto de 48 h, ordem numérica de quarto, auditoria, ordem de alergias, geração imediata em nova versão e alta, falha silenciosa). Um mutante equivalente (`ON CONFLICT DO NOTHING` sem alvo) foi descartado. A malha de vazamento ganhou escala e folha: a casa B tem doses reais e nada dela aparece em JSON nem no texto do PDF da casa A.

### Dívida técnica e limitações conhecidas
- Registro de administração (M5) ainda não existe: a escala mostra nenhuma dose como `concluida`; o ponto de ligação está comentado em `dados/escala.ts`.
- A geração roda por casa inteira a cada prescrição (uma consulta); aceitável para dezenas de idosos, rever se houver casas grandes.
- Agendador sem painel: o batimento está em `execucao_agendador`; o alerta de "agendador parado" entra com os alertas (M6).
- `ilpi_agendador` exige `ILPI_AGENDADOR_PASSWORD` em `db:setup`; em produção precisa de segredo próprio e processo próprio.
- Telas ainda não existem (escala do tablet é API).

## M2 Idosos e prescrições — concluído em 2026-10-26 (T17 a T23)

### O que foi construído
- **Idosos (`src/modules/idosos`):** cadastro com alergias e contatos de emergência; editar só os campos enviados (a auditoria guarda NOMES de campos); situação (ativo, hospitalizado, desligado) com antes e depois; listagem com filtro e contagem de alergias; CPF e telefone cifrados (AES-256-GCM) com versões mascaradas nas telas, e `revelarDadosSensiveis` como ação própria e auditada (POST, não GET). Nada é apagado.
- **Pulseira QR (T18/T19):** código opaco de 20 caracteres sem 0/O/1/I/L; o QR carrega `ILPI:I:<código>` (o de lote será `ILPI:L:`), nunca dados da pessoa. O tablet lê o QR, o código agrupado (`XXXXX-XXXXX-...`) ou em minúsculas (`localizarPorPulseira`, permissão `escala.ver`). Trocar a pulseira exige motivo, aposenta a antiga (leitura devolve "pulseira substituída", não "desconhecida") e emite a nova. `POST /idosos/:id/pulseira/emitir` devolve o PDF (tira de 190x25 mm e cartão de 85,6x54 mm, QR em vetor); cada emissão é auditada. O código nunca aparece em JSON nem na auditoria.
- **Prescrições (`src/modules/prescricoes`):** catálogo por casa (princípio ativo, concentração, forma, alto risco padrão, sugerido por lista de alta vigilância), prescrição regular ou SOS com horários por dia da semana, vigência, alto risco e prescritor. **Versionamento:** mudar dose, via ou horário substitui a versão atual e cria a seguinte, com justificativa obrigatória e lista dos campos alterados na auditoria. Encerrar exige motivo. Conferência de alergia (mesma substância, sinônimos populares e famílias como penicilinas e anti-inflamatórios) antes de gravar: conflito devolve 409 com as alergias, e só grava com justificativa de 10+ caracteres, guardada na própria prescrição.
- **Domínio puro (T21):** validação, vigência (fim inclusivo), `diferencasClinicas`, `verificarLimiteSos` (janela móvel de 24 h, informa quando libera), `conflitosComAlergia`, `sugerirAltoRisco`, `horariosNoDia`, `datas.ts` compartilhado.
- **Receita (T22/T23):** upload binário (JPEG, PNG ou PDF, até 10 MB) com tipo detectado pelos primeiros bytes, cifrado pela aplicação com o contexto (a chave do objeto) como dado autenticado, gravado em armazenamento privado (`Armazenamento`: disco local para desenvolvimento, memória para testes; provedor de nuvem em M8). Sem link público: o download passa pela API com sessão, permissão e registro na trilha, com `nosniff`, `no-store` e CSP `sandbox`. Integridade conferida por SHA-256 na leitura.
- **API:** `rota.ts` (tipos e ajudantes comuns), `rotas-idosos.ts`, `rotas-prescricoes.ts`; `respostaDeFalha` traduz o motivo em HTTP (409 conflito, 422 regra, 413/415 arquivo). A malha de vazamento ganhou canários da casa B (idoso, alergia, contato, pulseira, medicamento, prescrição, receita) e um teste que obriga toda rota com sessão a declarar `permissao` (lista de exceções fechada: `/auth/eu`, reautenticar, trocar senha e PIN).

### Verificação
471 testes (25 arquivos) contra PostgreSQL real; tipos, lint, formatação e build limpos; `npm audit` sem vulnerabilidades. O QR do PDF é lido de volta: o teste rasteriza o PDF e decodifica os dois QR com `jsQR`.
**Testes de mutação (todos pegos):** sem conferência de alergia; nova versão aceitando versão não ativa; sem `FOR UPDATE` na nova versão; receita sem dado autenticado; tipo de arquivo não conferido; leitura de receita de outra prescrição; leitura sem auditoria; "hoje" em UTC em vez do fuso da casa; duplicata permitida; alto risco ignorado; sem gatilho de imutabilidade; horário atualizável; sem índice de uma versão ativa; rota sem permissão declarada (esta revelou lacuna, corrigida).

### Desvios do plano
| Desvio | Motivo |
|---|---|
| Receita servida pela API, sem link temporário assinado | Com armazenamento local não há URL pública; passar pela API dá sessão, permissão e auditoria a cada leitura. Com provedor de nuvem, avaliar URL assinada de vida curta em M8 |
| Cifra do arquivo na aplicação (não só no provedor) | O provedor guarda só bytes cifrados; a troca de arquivo entre registros é detectada |
| `justificativa` da versão 1 guarda a confirmação de alergia | Evita nova coluna; a auditoria guarda só os ids das alergias |
| Janela móvel de 24 h para o limite diário de SOS | Leitura clínica segura: o dia do calendário permitiria dobrar a dose em torno da meia-noite |

### Dívida técnica e limitações conhecidas
- **Provedor de armazenamento e chaves (KMS):** hoje disco local e `CHAVE_CAMPOS` única (M8). Sem rotação de chave.
- **Conferência de alergia por nome:** tabela curta de sinônimos e famílias; falso negativo é possível (nome comercial desconhecido). O aviso é uma ajuda, não substitui a conferência humana; a conferência por lote/medicamento no registro (M5) repete a verificação.
- **Prescrição ativa depois do fim:** o sistema mostra "vencida", mas só encerra por ação humana; os alertas de vencimento chegam em M6.
- **Receita sem varredura de vírus** (só tipo e tamanho); o arquivo nunca é executado nem servido sem CSP `sandbox`.
- **Duas prescrições do mesmo medicamento com doses diferentes** (ex.: manhã e noite) exigem hoje uma única prescrição com a mesma dose em todos os horários; esquema com doses diferentes por horário fica para depois do piloto.
- Telas de idosos, prescrições e receitas ainda não existem (motor e API prontos).

## M1 Identidade e auditoria — concluído em 2026-10-25 (T07 a T16)

### O que foi construído
- **Login antes de haver casa (ADR-002):** `comBusca` roda em transação SOMENTE LEITURA e libera, por política de `SELECT`, apenas a linha cuja chave secreta (hash) coincide com a variável local. Depois disso tudo segue em `comContexto`.
- **Auditoria (`src/modules/auditoria`):** `registrarAuditoria` na MESMA transação da ação (se desfaz, o rastro desfaz), recusa segredos (`acharSegredo`), formato `dominio.verbo`. `verificarCadeiaDeAuditoria` aponta a primeira linha com problema.
- **Permissões:** matriz de 12 ações × 3 perfis (`podeExecutar`, `exigirPermissao`), testada contra uma tabela escrita à mão da spec 7.1, com checagem de que nenhuma ação fica sem teste.
- **Login na web (`dados/login.ts`):** e-mail e senha (Argon2id, 19 MiB, t=2), depois TOTP (RFC 6238 própria, vetores oficiais, proteção contra repetição por `totp_ultimo_passo`, segredo cifrado com AES-256-GCM). A sessão só vale após o segundo fator. Resposta única `credenciais_invalidas` para qualquer motivo (e-mail inexistente, senha errada, conta bloqueada, usuário inativo), com tempo igualado por hash falso. O motivo exato vai só para a auditoria.
- **Contador de falhas único** (`dados/tentativas.ts`) para senha, segundo fator, PIN e reautenticação, com a linha do usuário travada (`FOR UPDATE`): 12 tentativas simultâneas resultam em exatamente 5 conferidas. Só zera no login COMPLETO (entrar com a senha certa não zera, senão quem tem a senha ganharia chutes ilimitados no código). 5 falhas bloqueiam por 15 min e derrubam as sessões.
- **Sessões no banco** (`dados/sessao.ts`): token aleatório, só o hash fica guardado; expira por inatividade (web 30 min, tablet 2 min) e por duração máxima (12 h); desativar o usuário, a casa ou revogar o aparelho invalida na hora.
- **Aparelhos (`dados/dispositivo.ts`):** gestor gera código de 10 caracteres, uso único, 30 min, só o hash guardado; o tablet o troca por um token próprio (cookie de 1 ano); revogação derruba as sessões do aparelho. Um tablet, uma sessão: quem assume o posto encerra a anterior.
- **PIN no tablet (`dados/login-pin.ts`):** só com o token do aparelho; lista de quem pode entrar traz apenas id, nome e perfil; PINs óbvios recusados (sequências, repetições, espelhados, lista dos mais usados).
- **Reautenticação** (`dados/reautenticar.ts`): senha na web, PIN no tablet; vale 5 min; exigida para criar/revogar aparelho e toda a gestão de usuários.
- **Gestão de usuários (`dados/usuarios.ts`):** criar (senha/PIN provisórios obrigam troca), desativar (nunca o último gestor, nunca a si mesmo, travando os gestores para a corrida de dois gestores se desativando), reativar (não ressuscita sessões), desbloquear, redefinir senha, PIN e segundo fator (derrubam sessões), trocar a própria senha ou PIN.
- **API HTTP (`src/web`):** despachante que recebe `Request` e devolve `Response` (testável sem servidor), com Origin/Sec-Fetch-Site contra CSRF, limite de corpo de 16 KB, corpo validado com Zod `.strict()`, cookies HttpOnly + SameSite=Lax (`__Host-` e Secure em produção), `Cache-Control: no-store`, erro interno genérico (log só com tipo e código do Postgres). Cada rota declara `acesso` e, nas de administração, a `permissao`, conferida ANTES de ler o corpo. Credencial provisória bloqueia todas as rotas, exceto as de troca. Entrada Next fina em `src/app/api/[...rota]/route.ts`, criada na primeira requisição para o build não exigir variáveis de ambiente.
- **Malha de vazamento (T16):** `tests/vazamento/api-sem-vazamento.test.ts` percorre TODAS as rotas do inventário (`listarRotas()`): sem credencial → 401; origem estranha → 403; perfil sem permissão → 403; id da casa B → 404 sem efeito colateral; respostas e trilha de auditoria sem os "canários" da casa B. Rota nova entra na malha sem ninguém lembrar.

### Verificação
307 testes (18 arquivos) passando contra PostgreSQL real; tipos, lint, formatação e build de produção limpos; `npm audit` sem vulnerabilidades.
**Testes de mutação** (código quebrado de propósito; o teste TEM de falhar): sem `FOR UPDATE` no login; sem proteção de repetição do TOTP; ativação de aparelho sem guarda de uso único; PIN não conferido; sem travar gestores; desativar sem derrubar sessões; RLS aberta em `usuario`; sem checagem antecipada de permissão. Duas mutações revelaram lacunas dos testes, que foram corrigidas (sessão antiga "ressuscitando" na reativação; corrida do último gestor, agora repetida em 15 casas).
**Defeito de produto achado pelos testes de API:** uma rota protegida apagava o cookie da sessão ainda incompleta quando a tela do 2º fator a consultava, obrigando a digitar a senha de novo. Corrigido (401 não apaga cookie).

### Desvios do plano
| Desvio | Motivo |
|---|---|
| `pg` puro, sem Drizzle ORM | O RLS, a busca por chave e a auditoria pedem SQL explícito; o ganho do ORM não compensa a camada extra agora. Reavaliar se o volume de consultas crescer |
| TOTP implementado em vez de biblioteca | ~100 linhas, sem dependência nova, validado com os vetores da RFC 6238 |
| Contador de falhas compartilhado entre métodos | Mais estrito que um contador por método; custo: PIN errado no tablet também trava o login web da mesma pessoa |
| Despachante único em vez de um `route.ts` por rota | Permite testar todas as rotas e montar o inventário automaticamente |

### Dívida técnica e limitações conhecidas
- **Sem limite de tentativas por IP** no login (hoje só por conta). Falhas com e-mail inexistente não são auditadas (não há casa). Tratar em M8 (limitador na borda).
- **IP vem de `X-Forwarded-For` (primeiro valor):** serve de rastro para auditoria, não de segurança; o proxy da hospedagem precisa sobrescrever o cabeçalho.
- **Negação de serviço por PIN:** um colega mal-intencionado pode bloquear outro errando o PIN 5 vezes. Mitigações: gestor desbloqueia; folha de contingência em papel. Observar no piloto.
- **E-mail único no sistema inteiro** (limitação da V1, ADR-002): criar usuário com e-mail de outra casa revela que ele existe. Exige gestor com senha confirmada.
- **Sessões antigas não são apagadas** (só revogadas/expiradas): criar rotina de limpeza.
- **Âncora externa do hash da auditoria** continua pendente (M8): apagar as últimas linhas não quebra a cadeia.
- **CI ainda não vista rodando no GitHub** (o push de M1 é o primeiro com os novos jobs); `docker-compose.yml` não executado; ESLint 9; `CHAVE_CAMPOS` de desenvolvimento no `.env.example` (produção usa cofre de segredos; sem rotação de chave).
- Telas (login, tablet, administração) ainda não existem: M1 entrega o motor e a API.

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

## M4 — Estoque (concluído em 2026-10-26)
- Migração `0007_estoque.sql`: `lote_estoque`, `movimento_estoque` (seq, sinais por tipo, motivo obrigatório, par de fracionamento), view `saldo_lote` (security_invoker), `inventario` (um aberto por casa), `inventario_item` (esperado capturado na contagem), `impressao_etiqueta`. Tudo com RLS, FKs compostas e imutabilidade por gatilho.
- Saldo não negativo garantido por gatilho com advisory lock por lote; testado sob concorrência.
- Previsão por simulação FEFO; reposição = demanda que o estoque utilizável não cobre em 30 dias.
- Pendências para M5: FK `administracao_id`, consumo respeitando validade, conversão de unidade, média SOS real, localizar lote por QR.

## M5 — Administração (concluído em 2026-10-26)
- Migração `0008_administracao.sql`: `administracao` (chave de idempotência, uma final por dose em índice parcial, imutável, gatilho de coerência), `excecao_conferencia`, `segunda_validacao` (gatilho: outra pessoa), FK do consumo de estoque, `prescricao.alergias_confirmadas`.
- Decisões: alergia confirmada conscientemente ao prescrever avisa e não bloqueia; alergia nova bloqueia sempre, sem exceção. "Não administrada" dispensa a pulseira (paciente fora da casa); recusa e adiamento exigem. "Adiada" não é final e só vai até o limite maior contado do horário original. SOS só registra administração (com o sintoma), com limite em janela móvel de 24 h por grupo de versões. Registro tardio: reautenticação, motivo, até 7 dias, validade conferida na data da dose, prescrição valendo no momento da dose. Unidade do lote diferente da prescrita bloqueia (sem conversão).
- Janela de tolerância configurável pelo gestor (`/admin/configuracoes/janela`), com reautenticação e auditoria.
- Telas do tablet em `/tablet`; `npm run demo` e `npm run e2e:tablet`.

## M6 — Alertas (concluído em 2026-10-26)
- Migração `0009_alertas.sql`: `alerta` (chave da condição, um aberto por chave, só evolui, resolvido não reabre), `alerta_leitura`, `envio_alerta` (fila), novas tarefas do agendador.
- Decisões: aviso de estoque = maior entre o limite e o prazo de reposição; dose atrasada (aviso) → sem registro (urgente, enfermagem) → gestão no fim do plantão (padrão 07:00 e 19:00) ou se não lida em 2 h; e-mail só para urgentes, salvo configuração; exceções: resumo de ontem (informativo) e 3 ou mais da mesma pessoa em 7 dias (urgente); SOS além do limite: aviso informativo a partir da trilha; permissão `alertas.ver` (enfermagem e gestão), também na tabela 7.1 da spec.
- Painel `/painel` (com `/entrar`: senha, autenticador com QR no primeiro acesso, troca de senha provisória) e alertas no tablet para enfermagem e gestão.
