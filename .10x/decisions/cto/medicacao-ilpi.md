# CTO — medicacao-ilpi

**Data:** 2026-10-25
**Estado:** Confirmado (spec aprovada pelo usuário)

## Veredito
Construir, condicionado à validação de mercado. Existem sistemas de gestão para casas de idosos (ILPIs) no Brasil. O diferencial proposto é a **conferência por QR code na medicação, pensada para o tablet do posto**. Validar com 2 ou 3 casas antes de investir pesado.

## Direção tecnológica
- Monolito modular em Next.js (TypeScript) + PostgreSQL gerenciado, hospedado em São Paulo (ver ADR-001).
- Hospedagem com backups automáticos, criptografia em trânsito e em repouso, ambientes separados.

## Modelo de produto
Produto para várias casas (multicasa). A casa é controladora dos dados e o produto é operador (LGPD).

## Riscos e pendências
- Enquadramento regulatório (Anvisa para software de saúde, COREN, vigilância sanitária): consultar especialista.
- Revisão jurídica de contratos, política de privacidade e prazos de retenção.
- Teste de invasão por terceiros antes do uso real.
- Dependência de internet (decisão "sempre online"): reabrir se a piloto mostrar quedas frequentes.

## Build vs buy
Serviços gerenciados para banco, e-mail, armazenamento e chaves. Regras de negócio da medicação são desenvolvidas internamente, por serem o diferencial e o ponto de maior risco.
