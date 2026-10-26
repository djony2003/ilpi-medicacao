# Handoff

**De:** Brainstorming (todos os papéis)
**Para:** Estratégia (CTO + PM), depois Design (Arquiteto + Staff Engineer)
**Data:** 2026-10-25

## Contexto
O usuário quer um sistema de medicação para várias casas de idosos. O escopo completo (medicação, relatórios diários, família, comunicação da equipe, agenda de exames) foi decomposto em etapas. A V1 é o núcleo de medicação.

## Decisões já tomadas com o usuário
Multicasa, web para gestão e família, tablet fixo para a equipe, conferência por QR (pulseira + etiqueta), sempre online com folha de contingência, portal da família com resumo aprovado (fase posterior), V1 só de medicação, equipe pequena, monolito modular em Next.js + PostgreSQL em São Paulo.

## Documentos de referência
- Spec: `.10x/specs/2026-10-25-medicacao-ilpi-design.md`
- ADR: `.10x/adrs/001-monolito-modular-rls.md`
- Decisões: `.10x/decisions/cto/medicacao-ilpi.md`, `.10x/decisions/product-manager/medicacao-ilpi.md`

## Próximo passo
O usuário revisa a spec. Com a aprovação, confirmar as decisões de estratégia, aceitar o ADR-001, preencher as decisões de arquiteto e Staff Engineer e seguir para o planejamento (tarefas de no máximo meio dia).

## Atenção
Nenhum código deve ser escrito antes da aprovação da spec e da existência do ADR aceito.
