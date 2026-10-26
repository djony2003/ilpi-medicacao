# Engineering Manager — medicacao-ilpi

**Data:** 2026-10-25
**Cada tarefa:** no máximo meio dia. Se uma tarefa crescer além disso durante a execução, ela é dividida antes de continuar.

## Marcos e sequência

```
M0 Fundação ─► M1 Identidade e auditoria ─┬─► M2 Idosos e prescrições ─► M3 Escala ─┐
                                          │                                        ├─► M5 Administração ─► M6 Alertas ─► M8 Verificação e prontidão
                                          ├─► M4 Estoque (após M2) ────────────────┘
                                          └─► M7 Gestão e auditoria (após M1, em paralelo)
```

## M0 — Fundação
Entrega: repositório com CI verde, banco com papéis corretos e prova automática de isolamento.
- T01 Criar projeto Next.js com TypeScript estrito, Prettier e estrutura de pastas da spec; ESLint com regra de fronteira de módulos.
- T02 CI: tipos, lint, testes, busca de segredos e auditoria de dependências.
- T03 PostgreSQL local em contêiner, papéis `app` (sem superusuário e sem `BYPASSRLS`) e `migrador`, runner de migrações.
- T04 Utilitário de transação com `SET LOCAL app.casa_id` e `app.usuario_id`; teste que prova que sem contexto nenhuma linha é visível.
- T05 Verificação automática que falha se houver tabela de negócio sem RLS.
- T06 Biblioteca de log com campos proibidos e validação das variáveis de ambiente na inicialização.

## M1 — Identidade e auditoria
Entrega: gestor e enfermeiro entram com segundo fator; cuidador entra por PIN em tablet aprovado; toda ação gera auditoria encadeada.
- T07 Migração de `casa`, `usuario`, `dispositivo`, `sessao` com RLS.
- T08 Módulo de auditoria: tabela só de inserção, papel sem `UPDATE` e `DELETE`, hash encadeado por casa com bloqueio consultivo.
- T09 Testes: auditoria rejeita alteração e exclusão; verificador de cadeia detecta adulteração.
- T10 Login por e-mail e senha (Argon2id), sessões no banco, cookies seguros.
- T11 Segundo fator TOTP.
- T12 Tabela de permissões da spec e função `exigirPermissao`.
- T13 Cadastro e aprovação de dispositivos (tablets) pelo gestor, com revogação.
- T14 Login por PIN: aparelho aprovado, bloqueio por tentativas, PINs óbvios recusados, troca no primeiro uso, expiração por inatividade, reautenticação em ações sensíveis.
- T15 Gestão de usuários pelo gestor: criar, desativar, derrubar sessões.
- T16 Harness de testes de vazamento: percorre as rotas e tenta acesso cruzado entre casas.

## M2 — Idosos e prescrições
Entrega: enfermeiro cadastra idoso com pulseira QR e prescreve medicamentos com horários.
- T17 Migração de `idoso`, `alergia`, `contato_emergencia` com RLS.
- T18 Cadastro de idoso, alergias e contatos; geração do código opaco da pulseira.
- T19 Geração de pulseira ou cartão QR em PDF para impressão.
- T20 Migração de `medicamento`, `prescricao`, `horario_prescricao` com RLS.
- T21 Domínio da prescrição: versionamento, vigência, alto risco, limites de SOS (função pura, testada).
- T22 Telas de prescrição e upload da foto da receita em armazenamento privado com link temporário.
- T23 Criptografia de campos sensíveis com chave do serviço de chaves.

## M3 — Escala de doses
Entrega: a escala do plantão aparece no tablet, gerada a partir das prescrições.
- T24 Migração de `dose_agendada` com índice (casa_id, data prevista).
- T25 Geração de doses a partir dos horários, com fuso e horário de verão (função pura, testada).
- T26 Job idempotente de geração (próximos 7 dias) e emissão do batimento.
- T27 Tela da escala do plantão no tablet: estados, atrasadas no topo, alergias visíveis.
- T28 Folha de contingência em PDF para o plantão.

## M4 — Estoque
Entrega: entrada com etiqueta QR, saldo por lote e previsão de dias restantes.
- T29 Migração de `lote_estoque`, `movimento_estoque` e view de saldo com RLS.
- T30 Domínio de estoque: saldo, fracionamento, dias restantes, lotes vencendo (função pura, testada).
- T31 Entrada de estoque e geração da etiqueta QR.
- T32 Perdas, descartes, ajustes e devoluções com justificativa obrigatória.
- T33 Telas de estoque por idoso e por medicamento; lista de reposição em PDF.
- T34 Inventário por contagem manual, com divergências e ajustes justificados.

## M5 — Administração (núcleo crítico)
Entrega: registro de dose no tablet com conferência por QR, bloqueios, exceção e alto risco.
- T35 Migração de `administracao`, `excecao_conferencia`, `segunda_validacao`, com unicidade de resultado final por dose.
- T36 Função pura de conferência com todos os bloqueios da tabela 5.4 e testes exaustivos.
- T37 Janela de tolerância e regras de horário, configuráveis por casa.
- T38 Caso de uso do registro em transação: bloqueio da dose, idempotência, consumo de estoque, auditoria.
- T39 Testes de concorrência (leituras simultâneas) e de idempotência (reenvio).
- T40 Leitura de QR pela câmera do tablet, retorno sonoro e vibração.
- T41 Fluxo de tela passo a passo e resultados: administrada, recusada, não administrada, adiada.
- T42 Exceção de conferência liberada por enfermeiro, só para etiqueta ilegível.
- T43 Segunda validação para alto risco.
- T44 Doses SOS no tablet, com limite diário e intervalo mínimo.
- T45 Registro tardio a partir da folha de contingência.
- T46 Modo quiosque e aviso claro de queda de conexão.

## M6 — Alertas
Entrega: avisos de estoque, validade, atraso e dose sem registro, com escalonamento e e-mail.
- T47 Migração de `alerta` e configuração de limites por casa.
- T48 Job de estoque acabando, validade próxima e prescrição prestes a vencer.
- T49 Job de dose atrasada e dose sem registro.
- T50 Escalonamento ao gestor, fechamento automático e marcação de leitura.
- T51 Envio de e-mail sem dados de saúde, com fila e novas tentativas.
- T52 Painel de alertas.

## M7 — Gestão e auditoria (em paralelo após M1)
- T53 Tela de auditoria com filtros e exportação em PDF e planilha.
- T54 Relatório de exceções de conferência.
- T55 Configurações da casa (janelas, limites, prazo de reposição).
- T56 Exportação dos dados de um idoso (LGPD).

## M8 — Verificação e prontidão
- T57 Testes ponta a ponta dos fluxos críticos com Playwright.
- T58 Revisão de acessibilidade e usabilidade do tablet.
- T59 Revisão de segurança interna e preparação do teste de invasão externo.
- T60 Fluxo de onboarding de etiquetas e pulseiras.
- T61 Monitoramento, alertas técnicos e runbooks.
- T62 Deploy, backups automáticos e restauração testada.

## Estimativa
62 tarefas de até meio dia, o que dá cerca de 31 dias de trabalho focado de uma pessoa. Com revisão, correções e imprevistos, a estimativa realista é de **8 a 12 semanas** para uma pessoa e **5 a 7 semanas** para duas. A incerteza maior está em M5 (leitura de QR no navegador de tablets reais) e em T22 e T62 (dependem de escolhas de fornecedor). Os prazos não incluem a consulta regulatória, a revisão jurídica nem o teste de invasão externo, que correm em paralelo e podem atrasar a piloto.

## Pontos de decisão com o usuário
- Após M3: mostrar a escala e o cadastro funcionando, e usar isso para a validação de mercado com 2 ou 3 casas.
- Após M5: demonstração do registro com QR, a peça central do produto.
- Antes de M8: definir a casa-piloto e o fornecedor de hospedagem.

## Riscos de entrega
- Câmeras e navegadores de tablets variam: testar em pelo menos um aparelho real antes de fechar T40.
- Fusos e horário de verão em T25: concentrar testes aqui.
- Escopo: pedidos de módulos fora da V1 voltam ao brainstorming e entram em outra fase.
