# Status do projeto

**Projeto:** Sistema de medicação para casas de idosos (ILPI)
**Feature atual:** medicacao-ilpi (V1)
**Fase atual:** Fase 4 — Implementação. M7 concluído; próximo: M8 (verificação e prontidão), com aval do usuário
**Atualizado em:** 2026-10-26

## Fases
| Fase | Estado |
|---|---|
| 0. Brainstorming | Concluída. Spec aprovada |
| 1. Estratégia | Concluída |
| 2. Design | Concluída. ADR-001 aceito |
| 3. Planejamento | Concluída. 62 tarefas em 9 marcos |
| 4. Implementação | Em andamento. M0 a M7 concluídos (T01 a T56). Próxima tarefa: T57 |
| 5. Verificação | Não iniciada |
| 6. Entrega | Não iniciada |

## Tarefas
Plano completo: `.10x/decisions/engineering-manager/medicacao-ilpi.md`

| Marco | Tarefas | Estado |
|---|---|---|
| M0 Fundação | T01 a T06 | **Concluído** |
| M1 Identidade e auditoria | T07 a T16 | **Concluído** |
| M2 Idosos e prescrições | T17 a T23 | **Concluído** |
| M3 Escala de doses | T24 a T28 | **Concluído** (usuário optou por seguir sem validação prévia) |
| M4 Estoque | T29 a T34 | **Concluído** |
| M5 Administração | T35 a T46 | **Concluído** (usuário seguiu; testes em tablet real depois) |
| M6 Alertas | T47 a T52 | **Concluído** |
| M7 Gestão e auditoria | T53 a T56 | **Concluído** (telas de remédios, prescrições, estoque e equipe no computador ficam para depois) |
| M8 Verificação e prontidão | T57 a T62 | Pendente |

## Qualidade em M7
836 testes passando (46 arquivos), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades. Três testes de mutação detectados (reautenticação da exportação LGPD, escape do curinga no filtro de ação, proteção contra fórmula no CSV). Isolamento: a casa B tem exceção e trilha próprias, e nenhum relatório da casa A as mostra; a malha de vazamento cobre as rotas novas (inclusive `/admin/idosos/:id/exportacao` com id da casa B). Ponta a ponta no Chromium (`npm run e2e:painel`, 12 telas): enfermeira vê só Alertas e Residentes e é barrada nas telas da gestão; gestor exporta planilha e PDF da trilha e das exceções, confere a integridade da cadeia, muda a janela e os limites (com a senha), e baixa os dados de um residente.

## Qualidade em M6
802 testes passando (45 arquivos), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades (nodemailer na versão 10, sem as falhas das antigas). Doze testes de mutação detectados (informativo, silêncio após tratado, escalonamento e reaviso só sem leitura, e-mail de aviso, prazo de reposição, fim do plantão, janela, dose registrada, descarte de e-mail, e-mail sem dado clínico, fechamento por leitura). Malha de vazamento com alerta canário da casa B. Ponta a ponta no Chromium: `npm run e2e:painel` (entrada com autenticador, troca de senha, painel, ler, encerrar, tablet da enfermeira) e `npm run e2e:tablet`.

## Qualidade em M5
760 testes passando (41 arquivos, PostgreSQL real), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades. Treze testes de mutação detectados (alergia, paciente errado, lote de outro paciente, lote vencido, motivo fora da janela, idempotência, segunda validação, quem libera, validador igual, limite SOS, reautenticação do tardio, validade na data da dose, perfil na confirmação). Concorrência testada: seis leituras simultâneas da mesma dose geram um registro; duas doses disputando a última unidade, uma baixa. Telas do tablet testadas de ponta a ponta no Chromium com câmera simulada (`npm run e2e:tablet`, 16 telas); o teste revelou e corrigiu um laço de releitura do QR recusado. **Falta testar num tablet real** (câmera, som, vibração, quiosque).

## Qualidade em M4
690 testes passando (37 arquivos, PostgreSQL real), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades. Cinco testes de mutação detectados (ordem FEFO e lote vencido na previsão, reautenticação na saída e no fechamento do inventário, gatilho de saldo não negativo). PDFs da etiqueta e da reposição renderizados e conferidos; o QR da etiqueta é lido de volta pela API. Malha de vazamento estendida com lote e inventário da casa B.

## Qualidade em M3
530 testes passando (30 arquivos, PostgreSQL real), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades. Dezessete testes de mutação detectados (geração, gatilhos, escala, folha, geração imediata). A folha de contingência foi renderizada e conferida visualmente; o agendador foi executado como processo de verdade (rodada, batimento e parada limpa).

## Qualidade em M2
471 testes passando (25 arquivos, PostgreSQL real), tipos, lint, formatação e build de produção limpos, `npm audit` sem vulnerabilidades. Catorze testes de mutação (alergia, versionamento, cifra e tipo da receita, fuso da casa, gatilhos do banco, permissão declarada na rota) confirmaram que os testes detectam o defeito; um deles revelou lacuna na malha de vazamento, já corrigida. O QR do PDF da pulseira é lido de volta a partir do PDF renderizado.

## Qualidade em M1
307 testes passando, oito testes de mutação, malha de vazamento percorrendo todas as rotas (ver `decisions/sde`).

## Bloqueios
Nenhum.

## Pendências
- **A CI do GitHub não inicia:** os jobs falham em segundos com "conta bloqueada por problema de cobrança" (confirmado nas execuções de M0, M1 e M2). Não é falha do código: precisa o dono da conta resolver a cobrança no GitHub. Enquanto isso, a verificação roda localmente (`npm run verificar`).
- Reavaliar a migração do ESLint 9 para o 10.
- Limite de tentativas por IP no login, âncora externa da auditoria, limpeza de sessões (todos para M8; detalhes em `decisions/sde`).
- Telas no computador que ainda não existem (API pronta): cadastro de remédios e prescrições, estoque (entrada, etiquetas, reposição, inventário) e equipe/tablets. Existem: alertas, residentes, exceções, auditoria e configurações.
- Provedor de armazenamento de receitas e serviço de chaves (hoje disco local e chave única); decidir com o fornecedor de hospedagem antes de M8.
- Consulta regulatória (Anvisa, COREN, vigilância sanitária).
- Revisão jurídica (contratos, privacidade, retenção da auditoria).
- **Validação de mercado com 2 ou 3 casas: agora** (decisão do usuário após M3). Já existe o que mostrar: escala do plantão (API), folha de contingência em PDF, pulseira com QR; faltam as telas.
- Escolha do fornecedor de hospedagem e de e-mail (antes de M8).
