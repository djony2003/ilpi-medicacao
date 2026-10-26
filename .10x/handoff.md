# Handoff

**De:** Planejamento (Engineering Manager + Senior Engineer)
**Para:** Implementação (SDE + Senior Engineer + DBA)
**Data:** 2026-10-25

## Contexto
Plano pronto: 62 tarefas de até meio dia em 9 marcos. ADR-001 aceito. Projeto novo, sem código.

## Lista ordenada para o SDE
Seguir `.10x/decisions/engineering-manager/medicacao-ilpi.md`, começando por **M0 (T01 a T06)**. Abordagem e pontos difíceis em `.10x/decisions/senior-engineer/medicacao-ilpi.md`. Convenções em `.10x/decisions/staff-engineer/medicacao-ilpi.md`.

## Regras da implementação
- Uma tarefa por vez, commit pequeno por tarefa.
- Escrever o teste da regra de segurança antes do código.
- Ao fim de cada marco: atualizar `status.md`, escrever `decisions/sde/medicacao-ilpi.md` (o que foi construído, desvios, dívida técnica) e `decisions/dba/medicacao-ilpi.md` (schema, índices, migrações).
- Antes de cada marco que toca o banco, conferir que as tabelas novas têm RLS e teste de vazamento.

## Pontos de decisão com o usuário
Após M3 (validação de mercado), após M5 (demonstração do registro com QR) e antes de M8 (casa-piloto e fornecedores).

## Atenção
Os portões de qualidade (conferência, isolamento entre casas, auditoria) não podem ser dispensados por prazo.
