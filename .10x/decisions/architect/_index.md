# Arquiteto — Princípios e features ativas

## Princípios
- Toda decisão de segurança do paciente é tomada no servidor, dentro de uma transação.
- O banco é a última linha de defesa: RLS para isolamento entre casas e auditoria só de inserção.
- Módulos conversam por interfaces públicas, nunca pelas tabelas uns dos outros.
- Estados derivados (saldo de estoque) são calculados a partir de eventos, não editados.

## ADRs
- [ADR-001](../../adrs/001-monolito-modular-rls.md) — Monolito modular com RLS (Accepted)

## Features ativas
- [medicacao-ilpi](medicacao-ilpi.md)
