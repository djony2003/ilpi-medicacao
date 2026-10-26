# ADR-001: Monolito modular em Next.js + PostgreSQL com isolamento por Row Level Security

**Status:** Accepted
**Date:** 2026-10-25
**Feature:** medicacao-ilpi
**Author:** 10x-Team (Architect + Staff Engineer)

## Context
O produto é um sistema de medicação para várias casas de idosos (multicasa), operado por equipe pequena. Trata dados de saúde (dados pessoais sensíveis na LGPD), exige trilha de auditoria imutável e regras de segurança no registro de medicação (conferência por QR, bloqueios, segunda validação). Usuários: gestor e enfermeiro no navegador, cuidador em tablet fixo. O sistema é sempre online. É preciso entregar uma V1 enxuta para uma casa-piloto, mantendo a opção de evoluir para API e app nativo.

## Decision
- **Monolito modular** em Next.js (TypeScript), com módulos de identidade, casas e idosos, prescrições, administração, estoque e auditoria, comunicando-se por interfaces definidas.
- **PostgreSQL gerenciado**, em região de São Paulo, com **Row Level Security** em toda tabela de negócio, a partir de `casa_id` derivado do usuário autenticado.
- **Regras de medicação exclusivamente no servidor.** O tablet exibe resultados.
- **Auditoria só de inserção**, com hash encadeado.
- **Agendador** para geração de doses, alertas e verificações, com monitoramento de batimento.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not |
|-------------|------|------|---------|
| API separada (NestJS) + front-end React | API pronta para app nativo e integrações | Dois projetos para manter e implantar, mais trabalho inicial | Benefício ainda não necessário para a V1 |
| Backend como serviço (Supabase ou Firebase) | Protótipo mais rápido | Regras críticas espalhadas entre banco e front-end, dependência do fornecedor, menos controle sobre dados de saúde | Risco inadequado para um sistema de saúde |
| Banco ou instância por casa | Isolamento físico forte | Custo e operação crescem com cada casa, migrações multiplicadas | Complexidade desproporcional para a escala inicial |

## Consequences

### Positive
- Menor custo e menor complexidade operacional, um deploy e uma linguagem.
- Isolamento entre casas garantido pelo banco, mesmo se o código esquecer um filtro.
- Módulos com fronteiras claras permitem extrair uma API depois sem reescrever.

### Negative
- Extrair uma API para app nativo exigirá trabalho futuro.
- RLS exige disciplina: toda tabela nova precisa de política e de teste de vazamento.
- Um único processo concentra o risco de falha.

### Risks
- **Política de RLS ausente em tabela nova:** mitigar com teste automatizado que falha se uma tabela de negócio não tiver RLS.
- **Agendador parado em silêncio:** mitigar com alerta de batimento.
- **Acoplamento entre módulos com o tempo:** mitigar com regras de importação verificadas na análise estática.

## Dependencies
- Depende de PostgreSQL gerenciado com RLS e região no Brasil.
- Restringe a escolha de autenticação a uma solução que entregue a identidade da casa ao banco em cada requisição.
- Reabrir esta decisão se a V3 (portal da família) ou um app nativo exigirem API pública.
