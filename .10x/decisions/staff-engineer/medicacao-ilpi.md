# Staff Engineer — medicacao-ilpi

**Data:** 2026-10-25
**Contexto:** projeto novo, sem código existente. Estas são convenções a seguir, não descobertas.

## Estrutura do repositório
```
/
├── src/
│   ├── app/                  # rotas e telas do Next.js (finas, sem regra de negócio)
│   ├── modules/
│   │   ├── identidade/
│   │   ├── casas-idosos/
│   │   ├── prescricoes/
│   │   ├── administracao/
│   │   ├── estoque/
│   │   └── auditoria/
│   │       ├── index.ts      # única interface pública do módulo
│   │       ├── dominio/      # regras puras, sem acesso a banco
│   │       ├── dados/        # consultas e escrita no banco
│   │       └── api/          # ações do servidor e rotas
│   ├── worker/               # agendador e jobs
│   └── compartilhado/        # utilitários sem regra de negócio (datas, ids, erros)
├── db/
│   ├── migracoes/            # SQL versionado
│   └── seeds/                # casa fictícia para desenvolvimento e testes
├── tests/
│   ├── integracao/
│   ├── vazamento/            # testes de isolamento entre casas
│   └── e2e/
└── .10x/
```

## Ferramentas
| Necessidade | Escolha | Motivo |
|---|---|---|
| Linguagem | TypeScript em modo estrito | Segurança de tipos nas regras de medicação |
| Acesso ao banco | Drizzle ORM com SQL de migração escrito à mão para RLS e auditoria | Tipos fortes sem esconder o SQL que o RLS exige |
| Fila de jobs | pg-boss | Usa o PostgreSQL existente |
| Validação de entrada | Zod | Esquema único para API e tipos |
| Testes unitários e de integração | Vitest, com PostgreSQL real em contêiner de teste | RLS e concorrência não são testáveis com banco simulado |
| Testes ponta a ponta | Playwright | Fluxos do tablet |
| Análise estática | ESLint com regra de fronteira de módulos, Prettier | Faz valer a arquitetura |
| Segredos | Variáveis de ambiente validadas na inicialização, cofre em produção | Nada de segredo no repositório |

## Regras de código
1. **Fronteiras:** importar de outro módulo somente pelo `index.ts`. Regra de lint falha o build se violada.
2. **Regras de negócio puras:** a conferência de administração é uma função pura que recebe dados já carregados e devolve "liberado" ou um motivo de bloqueio tipado. O acesso ao banco só acontece antes e depois dela.
3. **Erros tipados:** bloqueios de medicação são resultados esperados (`Resultado<Ok, Bloqueio>`), não exceções. Exceções ficam para falhas inesperadas.
4. **Dinheiro e quantidades:** quantidades de estoque são inteiros na menor fração administrável. Nenhum ponto flutuante.
5. **Datas:** guardadas em UTC; conversão para o fuso da casa só na borda de exibição. O horário de referência é sempre o do servidor.
6. **Nada é apagado:** funções de remoção física não existem para entidades de negócio. Existem desativar e corrigir com justificativa.
7. **Logs:** biblioteca de log com lista de campos proibidos (nome, medicamento, documento, telefone). Identificadores opacos apenas.
8. **Toda tabela de negócio** nasce com `casa_id`, política de RLS e teste de vazamento. Uma verificação automática lista as tabelas sem RLS e falha.
9. **Migrações:** compatíveis com a versão anterior do código (adicionar antes de remover), revisadas junto com o código.

## Padrões transversais
- **Autorização:** uma função central `exigirPermissao(perfil, ação)`; telas e ações do servidor nunca comparam perfis diretamente.
- **Auditoria:** chamada obrigatória em toda ação de escrita, dentro da mesma transação. Ações do servidor passam por um envoltório que garante isso.
- **Tratamento de erros na tela do tablet:** mensagens de bloqueio vêm de uma tabela única de textos (spec, seção 5.4), para manter linguagem consistente.
- **Acessibilidade:** componentes do tablet com alvo de toque mínimo de 48 px, contraste mínimo AA, estado sempre com texto e ícone.

## Integração contínua (mínimo exigido)
Tipos, lint (incluindo fronteiras), testes unitários, testes de integração com banco, testes de vazamento, verificação de RLS em todas as tabelas, auditoria de dependências, busca de segredos.

## Dívida técnica conhecida desde o início
- Saldo de estoque por view pode precisar de materialização com o crescimento.
- Cadeia de auditoria serializada por casa limita a taxa de escrita por casa; suficiente para a escala de uma casa de idosos.
