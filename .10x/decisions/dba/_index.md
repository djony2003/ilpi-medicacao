# DBA — Princípios e features ativas

## Princípios
- Toda tabela do schema `public` tem RLS habilitado e forçado. Um teste automático falha se alguma não tiver.
- A aplicação nunca é dona de objeto, superusuária nem ignora RLS.
- Nada de negócio é apagado: o papel da aplicação não recebe DELETE nem TRUNCATE por padrão.
- Migrações são imutáveis depois de aplicadas (checksum) e compatíveis com a versão anterior do código.

## Features ativas
- [medicacao-ilpi](medicacao-ilpi.md)
