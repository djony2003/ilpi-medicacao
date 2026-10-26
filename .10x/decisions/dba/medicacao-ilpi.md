# DBA — medicacao-ilpi

## Estado em M3 (2026-10-26)

### Migração 0006_escala
- **`dose_agendada`:** `casa_id`, `prescricao_id` e `idoso_id` com chaves estrangeiras compostas com `casa_id`; `data_local` (date) e `hora_local` (time) no fuso da casa; `prevista_em` (timestamptz) calculado na geração; `cancelada_em` e `motivo_cancelamento` (enum) com CHECK de coerência. RLS habilitado e forçado.
- **Índices:** único parcial `dose_horario_unico (prescricao_id, data_local, hora_local) WHERE cancelada_em IS NULL` (idempotência e corrida); `dose_casa_prevista (casa_id, prevista_em)` e `dose_idoso_prevista` parciais nas não canceladas (escala do tablet).
- **Gatilhos:** `dose_agendada_so_cancela` (só os campos de cancelamento mudam, uma vez); `prescricao_cancela_doses` (ativa → encerrada/substituída cancela as doses depois de `encerrada_em`); `idoso_afastado_cancela_doses` (ativo → outro status cancela as doses depois de `status_alterado_em`). A referência é o horário gravado pela aplicação, não o `now()` do banco.
- **`execucao_agendador`:** batimento por (casa, tarefa), com última execução, duração, resultado em JSON e último erro. RLS pela casa.
- **Papel novo `ilpi_agendador`:** herda `ilpi_app` e ganha uma única ampliação, a política `agendador_lista_casas` (SELECT em `casa` onde `ativa`). Sem contexto de casa não lê dose, prescrição, idoso, usuário nem batimento (testado), e continua sem DELETE.
- `prescricao.criado_em` passou a ser gravado pela aplicação (relógio injetável); o default do banco continua como rede de segurança.

### Pendências
- Purga de doses antigas (retenção) e partição por data só se o volume pedir; hoje o volume é de dezenas de milhares de linhas por casa por ano.
- Painel/alerta do batimento do agendador em M6.

## Estado em M2 (2026-10-26)

### Tabelas (migrações 0004 e 0005), todas com RLS habilitado e forçado
Filhos usam chave estrangeira composta `(pai_id, casa_id)`: um filho nunca aponta para um pai de outra casa, mesmo com erro de código (testado).

| Tabela | Observações |
|---|---|
| `idoso` | `codigo_pulseira` único com checagem de formato; CPF cifrado; nunca apagada (status) |
| `pulseira_revogada` | Códigos aposentados, para distinguir "substituída" de "desconhecida" |
| `alergia`, `contato_emergencia` | Desativação em vez de exclusão; telefone cifrado |
| `medicamento` | Índice único por casa ignorando caixa e espaços; `alto_risco_padrao` |
| `prescricao` | Versionada (`grupo_id`, `versao`, `substitui_id`); só o estado muda depois de criada |
| `horario_prescricao` | Só INSERT (UPDATE revogado); dias 1..7 (ISO); hora no fuso da casa |
| `receita_prescricao` | Só INSERT; chave do objeto única; tipo, tamanho (até 10 MB) e SHA-256 |

### Garantias no banco (valem mesmo se a aplicação errar)
- Gatilho `prescricao_conteudo_imutavel`: qualquer UPDATE no conteúdo clínico falha; encerrada ou substituída não reabre.
- Índice parcial `prescricao_uma_ativa_por_grupo`: no máximo uma versão ativa por prescrição.
- Checagens: SOS exige indicação, limite e intervalo (regular não os tem); fim >= início; versão 2+ exige justificativa e `substitui_id`; estado coerente com encerramento.
- Sem DELETE para a aplicação em nenhuma tabela; sem UPDATE em horários e receitas.

### Índices
`idoso (casa_id, status)`, `alergia (idoso_id) WHERE ativa`, `contato (idoso_id) WHERE ativo`, `prescricao (idoso_id) WHERE ativa`, `prescricao (medicamento_id) WHERE ativa`, `receita_prescricao (prescricao_id)`.

### Pendências
- Doses por horário diferentes dentro de uma prescrição (hoje uma dose para todos os horários).
- Fuso: `casa.fuso_horario` é usado para "hoje"; horário de verão e geração de doses entram em M3.
- A tabela de doses agendadas (`dose_agendada`) e o estoque entram em M3 e M4 seguindo o mesmo padrão (composta com `casa_id`).

## Estado em M1 (2026-10-25)

### Tabelas (migrações 0002 e 0003), todas com RLS habilitado e forçado
| Tabela | Política de isolamento | Observações |
|---|---|---|
| `casa` | `id = app_casa_id()` | `ativa` desliga a casa inteira |
| `usuario` | `casa_id = app_casa_id()` + `busca_login` (SELECT por `app.login_email`) | e-mail em minúsculas e único no sistema (índice parcial); obrigatório exceto cuidador; enum `perfil_usuario`; contadores de falha e bloqueio na própria linha |
| `dispositivo` | `casa_id = app_casa_id()` + `busca_por_chave` (SELECT por `app.dispositivo_hash` ou `app.ativacao_hash`) | só hashes de token e de código; código é apagado ao ativar |
| `sessao` | `casa_id = app_casa_id()` + `busca_por_token` (SELECT por `app.sessao_hash`) | `token_hash` único; CHECK: tablet exige `dispositivo_id` |
| `auditoria` | só `SELECT` e `INSERT` | ver abaixo |

As políticas `busca_*` (ADR-002) só valem para `SELECT` e só liberam a linha cuja chave secreta (hash de 256 bits) coincide com a variável local da transação. A aplicação só as usa dentro de `comBusca`, que abre transação `READ ONLY`.

### Auditoria
- Hash encadeado POR CASA, calculado no gatilho `BEFORE INSERT` sob `pg_advisory_xact_lock(casa)`; `seq` atribuído sob o mesmo bloqueio (sem lacunas nem corrida). Campos codificados com tamanho na frente (sem ambiguidade `ab`+`c` × `a`+`bc`).
- Quatro camadas: `REVOKE UPDATE` do `ilpi_app`; políticas só para SELECT e INSERT; gatilhos que recusam UPDATE, DELETE e TRUNCATE até para superusuário; verificação da cadeia por `auditoria_verificar()` (`inicio_ausente`, `lacuna`, `encadeamento_quebrado`, `conteudo_adulterado`).
- Testado adulterando como superusuário com os gatilhos desligados: conteúdo alterado, linha do meio apagada, primeira linha apagada, linha reescrita sem corrigir a seguinte — todos detectados.
- **Limite:** apagar as ÚLTIMAS linhas não quebra a cadeia; precisa de âncora externa (M8).

### Índices
`usuario(email)` único parcial, `usuario(casa_id)`, `dispositivo(casa_id)`, `dispositivo(codigo_ativacao_hash)` e `(token_hash)` únicos, `sessao(token_hash)` único, `sessao(usuario_id)`, `sessao(casa_id)`. Acompanhar o plano de execução quando a auditoria passar de milhões de linhas (índice por `casa_id, seq` já existe pela chave da cadeia).

### Pendências
- Rotina de limpeza de sessões vencidas.
- Retenção e arquivamento da auditoria (definir com o jurídico).
- Ancorar o hash mais recente fora do banco (M8).

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
