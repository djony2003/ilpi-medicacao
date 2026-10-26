# Arquiteto — medicacao-ilpi

**Data:** 2026-10-25
**Referência:** ADR-001

## Componentes
Um processo Next.js com seis módulos (identidade, casas-idosos, prescrições, administração, estoque, auditoria) mais um **worker do agendador** que roda no mesmo código, em processo separado, consumindo uma fila no próprio PostgreSQL. Serviços externos: e-mail transacional, armazenamento de objetos privado e serviço de chaves da nuvem.

## Fronteiras entre módulos
Cada módulo expõe um arquivo `index.ts` com a interface pública (funções e tipos). Outros módulos importam somente desse arquivo.
- `administracao` consome interfaces de `prescricoes`, `estoque`, `casas-idosos` e `auditoria`.
- `estoque` consome `prescricoes` (consumo previsto) e `auditoria`.
- `auditoria` não depende de nenhum outro módulo de negócio.
- `identidade` é usada por todos para obter usuário, casa e dispositivo da requisição.

## Fluxo de uma requisição com isolamento por casa
1. A requisição chega com cookie de sessão. A sessão (guardada no banco) identifica usuário, casa e dispositivo.
2. A aplicação abre uma transação e executa `SET LOCAL app.casa_id = '<uuid>'` e `SET LOCAL app.usuario_id = '<uuid>'`.
3. As políticas de RLS usam `current_setting('app.casa_id')`. Sem essa variável definida, nenhuma linha é visível.
4. A aplicação conecta com um papel de banco **sem** privilégio de superusuário e **sem** `BYPASSRLS`. Migrações rodam com outro papel.

## Registro de administração (caminho crítico)
Tudo em uma única transação:
1. Bloquear a linha da `dose_agendada` (`SELECT ... FOR UPDATE`).
2. Conferir pulseira, medicamento, lote (validade e saldo), vigência da prescrição, alergia, janela de horário e unicidade da dose.
3. Para alto risco, exigir a segunda validação no mesmo fluxo antes de concluir.
4. Inserir `administracao`, inserir `movimento_estoque` de consumo e inserir a auditoria.
5. Confirmar a transação. Se qualquer passo falhar, nada é gravado.

**Idempotência:** o tablet envia um identificador de operação por tentativa. Reenvios com o mesmo identificador devolvem o resultado anterior em vez de gravar de novo. Uma restrição de unicidade em `administracao(dose_agendada_id)` para resultado final impede duplicidade mesmo sob concorrência.

## Estoque
Saldo = soma de `movimento_estoque` por lote. Para leitura rápida, uma visão (view) calcula o saldo. Se o desempenho exigir, passa a uma visão materializada atualizada pelo agendador, sem permitir edição manual do saldo.

## Auditoria
Tabela com inserção apenas, escrita na mesma transação da ação auditada. Cada registro guarda o hash do anterior **da mesma casa**. A cadeia é por casa para evitar contenção entre casas diferentes. Dentro de uma casa, a escrita é serializada com um bloqueio consultivo (`pg_advisory_xact_lock`) por casa. Um job periódico verifica a cadeia. O papel da aplicação tem apenas `INSERT` e `SELECT` nessa tabela.

## Agendador
Fila no PostgreSQL (pg-boss), sem nova infraestrutura. Jobs:
- Gerar `dose_agendada` para os próximos 7 dias, de forma idempotente.
- Marcar doses como "sem registro" após o limite.
- Calcular dias restantes de estoque e abrir ou fechar alertas.
- Enviar e-mails de alerta, com tentativas e registro de falhas.
- Verificar a cadeia de auditoria e a existência de backup recente.
- Emitir o batimento (heartbeat) que o monitoramento observa.

## Modos de falha e resposta
| Falha | Efeito | Resposta |
|---|---|---|
| Banco indisponível | Nenhum registro possível | Tablet mostra aviso, equipe usa a folha de contingência |
| Worker parado | Alertas e geração de doses param | Alerta de ausência de batimento ao responsável técnico |
| E-mail indisponível | Alertas por e-mail atrasam | Fila com novas tentativas, alerta continua no painel |
| Reenvio ou duplo toque no tablet | Risco de registro duplo | Idempotência e restrição de unicidade |
| Duas leituras simultâneas do mesmo QR | Disputa | Bloqueio de linha e unicidade, uma vence |
| Tabela nova sem RLS | Vazamento potencial | Teste automatizado que falha se tabela de negócio não tiver RLS |

## Decisões de tecnologia (alto nível)
- PostgreSQL 16 ou superior, gerenciado, região de São Paulo.
- Hospedagem da aplicação em região do Brasil, a confirmar fornecedor na fase de entrega.
- Sessões no banco com cookie `HttpOnly`, `Secure`, `SameSite=Lax`. Senhas com Argon2id. Segundo fator TOTP para gestor e enfermeiro.
- Leitura de QR pela câmera do navegador (API `BarcodeDetector` quando existir, com biblioteca como alternativa).

## Pontos deixados para a implementação
Escolha do fornecedor de e-mail e de hospedagem; formato exato da etiqueta QR (conteúdo é apenas um identificador opaco, nunca dados de saúde).
