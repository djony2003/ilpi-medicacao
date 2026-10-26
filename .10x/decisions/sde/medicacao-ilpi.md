# SDE — medicacao-ilpi

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
