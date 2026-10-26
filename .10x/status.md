# Status do projeto

**Projeto:** Sistema de medicação para casas de idosos (ILPI)
**Feature atual:** medicacao-ilpi (V1)
**Fase atual:** Fase 4 — Implementação. M0 concluído; próximo: M1
**Atualizado em:** 2026-10-25

## Fases
| Fase | Estado |
|---|---|
| 0. Brainstorming | Concluída. Spec aprovada |
| 1. Estratégia | Concluída |
| 2. Design | Concluída. ADR-001 aceito |
| 3. Planejamento | Concluída. 62 tarefas em 9 marcos |
| 4. Implementação | Em andamento. M0 concluído (T01 a T06). Próxima tarefa: T07 |
| 5. Verificação | Não iniciada |
| 6. Entrega | Não iniciada |

## Tarefas
Plano completo: `.10x/decisions/engineering-manager/medicacao-ilpi.md`

| Marco | Tarefas | Estado |
|---|---|---|
| M0 Fundação | T01 a T06 | **Concluído** |
| M1 Identidade e auditoria | T07 a T16 | Pendente (próximo) |
| M2 Idosos e prescrições | T17 a T23 | Pendente |
| M3 Escala de doses | T24 a T28 | Pendente |
| M4 Estoque | T29 a T34 | Pendente |
| M5 Administração | T35 a T46 | Pendente |
| M6 Alertas | T47 a T52 | Pendente |
| M7 Gestão e auditoria | T53 a T56 | Pendente |
| M8 Verificação e prontidão | T57 a T62 | Pendente |

## Qualidade em M0
66 testes passando (regra de fronteiras, PostgreSQL real, log, ambiente), tipos, lint, formatação e build limpos, `npm audit` sem vulnerabilidades. Isolamento por RLS validado com teste de mutação.

## Bloqueios
Nenhum.

## Pendências
- Decisão de arquitetura para o login antes de haver casa no contexto (ver handoff), a resolver no início de M1.
- A CI não foi executada de verdade (só validada localmente); confirmar no primeiro push.
- Reavaliar a migração do ESLint 9 para o 10.
- Consulta regulatória (Anvisa, COREN, vigilância sanitária).
- Revisão jurídica (contratos, privacidade, retenção).
- Validação de mercado com 2 ou 3 casas (sugerida após M3).
- Escolha do fornecedor de hospedagem e de e-mail (antes de M8).
