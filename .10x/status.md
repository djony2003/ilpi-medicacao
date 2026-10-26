# Status do projeto

**Projeto:** Sistema de medicação para casas de idosos (ILPI)
**Feature atual:** medicacao-ilpi (V1)
**Fase atual:** Fase 4 — Implementação. M1 concluído; próximo: M2
**Atualizado em:** 2026-10-25

## Fases
| Fase | Estado |
|---|---|
| 0. Brainstorming | Concluída. Spec aprovada |
| 1. Estratégia | Concluída |
| 2. Design | Concluída. ADR-001 aceito |
| 3. Planejamento | Concluída. 62 tarefas em 9 marcos |
| 4. Implementação | Em andamento. M0 e M1 concluídos (T01 a T16). Próxima tarefa: T17 |
| 5. Verificação | Não iniciada |
| 6. Entrega | Não iniciada |

## Tarefas
Plano completo: `.10x/decisions/engineering-manager/medicacao-ilpi.md`

| Marco | Tarefas | Estado |
|---|---|---|
| M0 Fundação | T01 a T06 | **Concluído** |
| M1 Identidade e auditoria | T07 a T16 | **Concluído** |
| M2 Idosos e prescrições | T17 a T23 | Pendente (próximo) |
| M3 Escala de doses | T24 a T28 | Pendente |
| M4 Estoque | T29 a T34 | Pendente |
| M5 Administração | T35 a T46 | Pendente |
| M6 Alertas | T47 a T52 | Pendente |
| M7 Gestão e auditoria | T53 a T56 | Pendente |
| M8 Verificação e prontidão | T57 a T62 | Pendente |

## Qualidade em M1
307 testes passando (18 arquivos, PostgreSQL real), tipos, lint, formatação e build de produção limpos, `npm audit` sem vulnerabilidades. Oito testes de mutação (RLS aberta, sem trava de concorrência, sem proteção de repetição do TOTP, PIN não conferido, etc.) confirmaram que os testes detectam o defeito. A malha de vazamento percorre todas as rotas da API automaticamente.

## Bloqueios
Nenhum.

## Pendências
- A CI ainda não foi vista rodando no GitHub (o push do M1 é o primeiro com os novos jobs); confirmar.
- Reavaliar a migração do ESLint 9 para o 10.
- Limite de tentativas por IP no login, âncora externa da auditoria, limpeza de sessões (todos para M8; detalhes em `decisions/sde`).
- Telas de login, tablet e administração ainda não existem (o motor e a API estão prontos); entram junto com as telas de cada marco.
- Consulta regulatória (Anvisa, COREN, vigilância sanitária).
- Revisão jurídica (contratos, privacidade, retenção da auditoria).
- Validação de mercado com 2 ou 3 casas (sugerida após M3).
- Escolha do fornecedor de hospedagem e de e-mail (antes de M8).
