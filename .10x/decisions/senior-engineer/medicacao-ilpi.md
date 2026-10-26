# Senior Engineer — medicacao-ilpi

**Data:** 2026-10-25
**Referência:** plano de tarefas T01 a T62 em `.10x/decisions/engineering-manager/medicacao-ilpi.md`

## Abordagem por marco

**M0 Fundação.** Começar pelo banco, não pela tela. T03 e T04 definem o contrato de todo o resto: o papel `app` não pode ter `BYPASSRLS`, e o utilitário de transação é o único caminho para consultar dados. Um teste de integração cria duas casas e prova que cada uma só vê as próprias linhas, e que sem `SET LOCAL` nada aparece.

**M1 Identidade e auditoria.** Fazer a auditoria (T08) antes do login, para que todo código seguinte já nasça auditado. O hash encadeado por casa usa `pg_advisory_xact_lock(hashtext(casa_id))` para serializar escritas daquela casa e ler o último hash com segurança. O PIN do cuidador é um segredo curto, então a proteção está no aparelho aprovado, no limite de tentativas e na expiração rápida, e não na força do PIN.

**M2 Idosos e prescrições.** O versionamento de prescrição é uma única operação transacional: encerrar a vigente e criar a nova, ou nada. O código da pulseira e o da etiqueta são identificadores aleatórios opacos, sem nenhum dado do paciente, para que um QR perdido não vaze informação.

**M3 Escala.** A geração de doses é uma função pura (horários + período + fuso → lista de instantes UTC) e o job só a chama e grava, com `INSERT ... ON CONFLICT DO NOTHING` para ser idempotente. Testar horário de verão e virada de dia.

**M4 Estoque.** Saldo sempre derivado dos movimentos. Quantidades inteiras na menor fração. Dias restantes é função pura, o que facilita testar os casos de SOS sem histórico e de lote que vence antes do consumo.

**M5 Administração.** A conferência é uma função pura que recebe tudo já carregado e devolve liberado ou um bloqueio tipado, na ordem de prioridade: pulseira, prescrição vigente, medicamento, alergia, lote vencido, saldo, dose já registrada, janela. Os testes cobrem cada bloqueio e as combinações. O caso de uso abre a transação, bloqueia a dose com `FOR UPDATE`, chama a função, grava administração, movimento de estoque e auditoria, e confirma. Identificador de operação enviado pelo tablet garante idempotência.

**M6 Alertas.** Um alerta é identificado por (tipo, entidade): o job faz upsert, nunca insere repetido. Fechamento automático acontece no mesmo job quando a condição some.

**M7 e M8.** Exportações e relatórios consultam as mesmas tabelas sob RLS. Os testes ponta a ponta usam a casa fictícia do seed.

## Pontos difíceis e como tratar
| Ponto | Risco | Tratamento |
|---|---|---|
| RLS e pool de conexões | Variável de sessão vazar entre requisições | `SET LOCAL` dentro de transação, nunca `SET` de sessão; teste que reutiliza conexão |
| Concorrência no registro | Dose duplicada | Bloqueio de linha, unicidade e idempotência; teste com chamadas simultâneas |
| Auditoria encadeada | Contenção e ordem | Bloqueio consultivo por casa, escrita na mesma transação da ação |
| Fuso e horário de verão | Doses em horários errados | Função pura com testes de datas limite; horário da casa configurado explicitamente |
| Leitura de QR no navegador | Câmera ruim, luz baixa, aparelhos antigos | Testar em tablet real; tamanho e correção de erro do QR escolhidos para etiqueta pequena; campo de digitação do código como alternativa auditada |
| Etiqueta em embalagem fracionada | Código ilegível | Reimpressão com o mesmo código e exceção auditada |
| Agendador parado | Alertas silenciosos | Batimento monitorado, alerta de ausência |
| Fotos de receita | Vazamento de documento | Armazenamento privado, link temporário curto, criptografia |

## Critério de pronto de qualquer tarefa
Tipos e lint passando, testes da tarefa escritos e passando, teste de vazamento incluído se tocou tabela ou rota, auditoria presente se a ação escreve dados, nenhum dado de saúde em log, commit pequeno e descritivo.
