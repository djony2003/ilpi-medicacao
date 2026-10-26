# Handoff

**De:** Estratégia (CTO + PM)
**Para:** Design (Arquiteto + Staff Engineer)
**Data:** 2026-10-25

## Contexto
Spec aprovada pelo usuário. A V1 é o núcleo de medicação de um produto multicasa para casas de idosos. Estratégia confirmada: construir, condicionado à validação de mercado do diferencial (conferência por QR no tablet do posto).

## O que o Arquiteto deve fazer
- Aceitar ou ajustar o ADR-001 (`.10x/adrs/001-monolito-modular-rls.md`).
- Detalhar componentes, fronteiras entre módulos, fluxo de requisição com RLS e modos de falha.

## O que o Staff Engineer deve fazer
- Projeto novo, sem código existente: definir convenções, estrutura de pastas, ferramentas de teste e regras que mantêm as fronteiras entre módulos.

## Referências
- Spec: `.10x/specs/2026-10-25-medicacao-ilpi-design.md`
- Decisões: `.10x/decisions/cto/medicacao-ilpi.md`, `.10x/decisions/product-manager/medicacao-ilpi.md`

## Atenção
Nenhum código antes de ADR aceito e de planejamento concluído.
