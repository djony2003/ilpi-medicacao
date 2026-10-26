# ADR-002: Busca por chave secreta antes de existir contexto de casa

**Status:** Accepted
**Date:** 2026-10-25
**Feature:** medicacao-ilpi
**Author:** 10x-Team (Architect + DBA)

## Context
Com `FORCE ROW LEVEL SECURITY`, toda consulta só enxerga linhas da casa definida em `app.casa_id`. Mas quatro operações precisam localizar uma linha **antes** de saber a casa:

1. **Login por e-mail:** achar o usuário pelo e-mail.
2. **Validação de sessão:** achar a sessão pelo token do cookie.
3. **Reconhecer o tablet:** achar o dispositivo pelo token do cookie do aparelho.
4. **Ativar um tablet:** achar o dispositivo pelo código de ativação.

Funções `SECURITY DEFINER` não resolvem: com FORCE, a política vale também para o dono. Um papel com BYPASSRLS contrariaria a regra de que ninguém ignora o isolamento.

## Decision
Cada uma dessas tabelas ganha uma **segunda política, apenas de SELECT**, que libera exatamente a linha cuja chave secreta coincide com uma variável local da transação:

| Tabela | Variável | Coluna comparada |
|---|---|---|
| `usuario` | `app.login_email` | `email` |
| `sessao` | `app.sessao_hash` | `token_hash` |
| `dispositivo` | `app.dispositivo_hash` | `token_hash` |
| `dispositivo` | `app.ativacao_hash` | `codigo_ativacao_hash` |

Regras de uso:
- A busca passa por um único utilitário, `comBusca`, que abre uma transação **`READ ONLY`**, define uma variável e executa a consulta. Gravar nessa transação falha no próprio banco.
- Tokens e códigos são guardados **só como hash SHA-256**. A busca compara hashes.
- Achada a linha, a casa passa a ser conhecida e todo o resto roda em `comContexto`, com o isolamento normal.
- A política é por igualdade com valor fornecido pela aplicação: devolve no máximo uma linha, sem listagem e sem busca parcial.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not |
|-------------|------|------|---------|
| Papel separado com BYPASSRLS para login | Simples | Um segundo papel que ignora o isolamento, com credencial a proteger | Cria exatamente o tipo de exceção que o design quer evitar |
| Tabela de identidade separada, sem RLS | Direto | Duplica dados de usuário e sessão, e a tabela sem RLS quebra o portão "toda tabela tem RLS" | Enfraquece a verificação automática |
| `SECURITY DEFINER` | Padrão conhecido | Não funciona com FORCE RLS | Inviável |
| Desligar FORCE nas tabelas de busca | Resolve o login | O dono (migrações) deixa de ser limitado pela política | Reduz a proteção em tabelas sensíveis |

## Consequences

### Positive
- Um único papel de aplicação, sem exceções de privilégio.
- A busca por segredo só encontra a linha de quem conhece o segredo, o que equivale ao que a aplicação já poderia fazer sem RLS.
- A transação somente leitura impede que uma busca vire escrita por engano.
- Os testes de vazamento cobrem o mecanismo: uma chave de uma casa nunca revela linha de outra.

### Negative
- Quatro políticas extras para manter e testar.
- A linha de `usuario` retornada no login inclui o hash da senha (necessário para verificar), então o código do login deve selecionar só as colunas necessárias.
- O e-mail passa a ser único em todo o sistema: uma pessoa não pode ter o mesmo e-mail em duas casas (limitação da V1).

### Risks
- **Comparar o valor errado:** um erro na política abriria linhas. Mitigado por testes que tentam chaves de outras casas, chaves vazias e ausentes.
- **Uso indevido de `comBusca` para outra coisa:** mitigado por ser somente leitura e por revisão. Qualquer nova busca sem contexto exige novo ADR.

## Dependencies
- Depende de `0001_base` (`app_casa_id`) e do padrão de RLS do DBA.
- Restringe a futuros fluxos sem contexto (por exemplo, portal da família na V3) a seguir o mesmo mecanismo.
