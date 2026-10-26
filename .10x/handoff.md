# Handoff

**De:** Design (Arquiteto + Staff Engineer)
**Para:** Planejamento (Engineering Manager + Senior Engineer)
**Data:** 2026-10-25

## Contexto
Design fechado. ADR-001 aceito (monolito modular em Next.js + PostgreSQL com RLS). Projeto novo, sem código.

## Entradas para o plano
- Componentes, fluxo de requisição com RLS, transação do registro de administração, idempotência, agendador e modos de falha: `.10x/decisions/architect/medicacao-ilpi.md`
- Estrutura do repositório, ferramentas, regras de código e CI: `.10x/decisions/staff-engineer/medicacao-ilpi.md`
- Escopo e critérios: spec e `.10x/decisions/product-manager/medicacao-ilpi.md`

## O que o Engineering Manager deve entregar
Lista ordenada de tarefas de no máximo meio dia, com dependências, agrupadas em marcos que entreguem valor verificável.

## O que o Senior Engineer deve entregar
Abordagem de implementação por grupo de tarefas e os pontos difíceis (RLS, concorrência, auditoria encadeada, agendador, leitura de QR no tablet).

## Atenção
Os testes de regras de conferência, isolamento entre casas e auditoria são portões de qualidade: nenhuma tarefa de implementação os dispensa.
