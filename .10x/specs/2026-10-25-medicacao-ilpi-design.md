# Design: Sistema de Medicação para Casas de Idosos (ILPI) — V1

**Data:** 2026-10-25
**Feature:** medicacao-ilpi
**Status:** Aprovada pelo usuário em 2026-10-25
**Origem:** Brainstorming (Fase 0) com o usuário

---

## 1. Contexto e objetivo

O usuário quer um aplicativo completo de apoio a casas de idosos: cadastro de medicamentos, horários e dosagens, comunicação da equipe, relatórios diários de saúde, acesso da família, alerta de fim de remédio e agenda de exames.

Por ser um conjunto de módulos independentes, o escopo foi decomposto em etapas. **Este documento especifica a V1: o núcleo de medicação.** Os demais módulos têm espaço reservado no design e ciclo próprio de brainstorm, design e implementação.

### Decisões tomadas no brainstorming

| # | Decisão | Escolha |
|---|---|---|
| 1 | Público | Produto para várias casas de idosos (multicasa, dados isolados) |
| 2 | Plataforma | Web para gestão e família; tablet fixo no posto de enfermagem para a equipe |
| 3 | Rigor no registro | Conferência por QR code (pulseira do idoso + etiqueta do medicamento) |
| 4 | Conectividade | Sempre online, com folha de contingência em papel |
| 5 | Portal da família | Leitura resumida, com aprovação do enfermeiro antes de publicar (fase posterior à V1) |
| 6 | Escopo da V1 | Núcleo de medicação |
| 7 | Equipe e tecnologia | Equipe pequena, tecnologia simples e barata de manter |
| 8 | Abordagem | Monolito modular em Next.js (TypeScript) + PostgreSQL gerenciado, hospedado em São Paulo |

## 2. Escopo da V1

**Dentro:**
- Cadastro de casas, usuários e perfis de acesso
- Cadastro de idosos, com alergias, contatos de emergência e pulseira QR
- Medicamentos e prescrições versionadas, com foto da receita
- Escala de doses por plantão e registro da administração com conferência por QR
- Segunda validação para medicamentos de alto risco
- Doses "se necessário" (SOS) com limite diário e intervalo mínimo
- Estoque com entrada, etiquetas QR, consumo automático, perdas, descartes e inventário por contagem manual
- Alertas de estoque baixo, validade, dose atrasada e dose sem registro (painel e e-mail)
- Trilha de auditoria imutável
- Folha de contingência em papel e fluxo de registro tardio
- Onboarding de etiquetas e pulseiras

**Fora da V1 (espaço reservado no design):**
- Relatório diário de saúde por idoso, agenda de exames e consultas
- Portal da família e comunicação interna da equipe
- Alertas por WhatsApp ou SMS (V1.1)
- App nativo, integrações com farmácias, alertas de sinais vitais, registro de quedas

**O sistema não prescreve.** O enfermeiro ou gestor cadastra a prescrição a partir da receita médica e anexa a foto como comprovante.

## 3. Arquitetura

Um único projeto, organizado em módulos com fronteiras claras:

| Módulo | Responsabilidade |
|---|---|
| Identidade e acesso | Login, perfis, PIN no tablet, sessões, aparelhos cadastrados |
| Casas e idosos | Cadastro da casa, idosos, alergias, contatos, pulseira QR |
| Prescrições | Medicamento, dose, via, horários, vigência, foto da receita |
| Administração | Escala do plantão, leitura de QR, conferência e registro |
| Estoque | Entrada com etiqueta QR, saldo, validade, consumo, alertas |
| Auditoria | Registro imutável de todas as ações |

**Regras de arquitetura:**
- Cada módulo se comunica com os outros por interface definida, sem acessar tabelas alheias. Isso permite extrair o módulo de administração como API no futuro.
- As regras de medicação ficam no servidor. O tablet apenas exibe o resultado.
- O isolamento entre casas é aplicado no banco com Row Level Security (RLS).
- Um agendador roda a geração das doses, a verificação de estoque e validade e o envio de alertas.
- A tabela de auditoria só aceita inserção.
- Aplicação e banco em região de São Paulo, backups automáticos diários, criptografia em trânsito e em repouso, ambientes separados de desenvolvimento, homologação e produção.

## 4. Modelo de dados

Toda tabela de negócio tem `casa_id` e RLS. Identificadores são UUIDs. Datas em UTC, exibidas no fuso da casa.

**Identidade e casas**
- `casa`: nome, CNPJ, fuso horário, configurações (janela de tolerância, antecedência dos alertas, prazo de reposição)
- `usuario`: casa_id, nome, e-mail, perfil (gestor, enfermeiro, cuidador), hash do PIN, registro profissional (COREN, quando houver), ativo
- `dispositivo`: casa_id, identificação do tablet, aprovado_por, ativo

**Idosos**
- `idoso`: casa_id, nome, data de nascimento, foto, código da pulseira QR, status (ativo, hospitalizado, desligado)
- `alergia`: idoso_id, substância, gravidade, observação
- `contato_emergencia`: idoso_id, nome, parentesco, telefone, responsável legal (sim/não)

**Prescrições**
- `medicamento`: casa_id, nome comercial, princípio ativo, concentração, forma
- `prescricao`: idoso_id, medicamento_id, dose, unidade, via, instruções, início, fim (ou uso contínuo), alto risco, foto da receita, cadastrada_por, status. **Versionada:** alterar uma dose encerra a prescrição anterior e cria uma nova.
- `horario_prescricao`: prescricao_id, hora do dia, dias da semana. Para SOS: limite diário e intervalo mínimo.

**Administração**
- `dose_agendada`: prescricao_id, idoso_id, data e hora prevista. Gerada pelo agendador.
- `administracao`: dose_agendada_id, resultado (administrada, recusada, não administrada, adiada), motivo, usuario_id, lote_id, horário real, dispositivo, método de leitura (QR ou exceção), marca de registro tardio
- `excecao_conferencia`: administracao_id, motivo, liberada_por, justificativa
- `segunda_validacao`: administracao_id, validador_id, horário

**Estoque**
- `lote_estoque`: casa_id, medicamento_id, idoso_id (estoque individual, quando aplicável), código QR da etiqueta, validade, quantidade inicial
- `movimento_estoque`: lote_id, tipo (entrada, consumo, perda, ajuste, descarte, devolução), quantidade, usuario_id, referência à administração quando for consumo

O saldo é calculado pela soma dos movimentos e não é editável.

**Alertas e auditoria**
- `alerta`: casa_id, tipo, destinatários, canal, status de envio, lido por, estado
- `auditoria`: casa_id, usuario_id, ação, entidade, valores antes e depois, dispositivo, IP, data e hora, hash do registro anterior. Só aceita inserção.

**Regras de integridade:**
- Uma dose agendada tem no máximo uma administração final. Leituras simultâneas do mesmo QR geram um único registro.
- Nada é apagado: idosos, prescrições e lotes são desativados. Exclusões por LGPD seguem procedimento próprio, com registro.
- Índice em (casa_id, data prevista) nas doses agendadas.
- Campos sensíveis criptografados. Fotos em armazenamento privado com link temporário.

## 5. Fluxo de medicação no tablet

### 5.1 Início do plantão
O cuidador toca no próprio nome e digita o PIN. A sessão expira por inatividade (padrão de 2 minutos). A tela inicial mostra a escala do plantão por horário, com estados: a fazer, em janela, atrasado, concluído. Doses atrasadas ficam no topo. Alergias ficam sempre visíveis no cartão do idoso.

### 5.2 Janela de tolerância
Configurável por casa (sugestão: 30 minutos antes e depois).
- Dentro da janela: registro normal.
- Fora da janela, até 2 horas depois do horário previsto: exige motivo.
- Mais de 2 horas depois do horário previsto (limite maior, configurável): alerta o enfermeiro, e a dose, se ainda não registrada, passa a "sem registro".
- Adiantado além da janela, até 2 horas antes: exige motivo.
- Mais de 2 horas antes do horário previsto: bloqueado. Apenas o enfermeiro libera.

### 5.3 Passo a passo do registro
1. O cuidador escolhe o cartão do horário e toca em "Iniciar".
2. Lê a pulseira do idoso. Pulseira de outro idoso bloqueia.
3. A tela mostra medicamento, dose, via, instruções e alergias. O cuidador lê a etiqueta QR do medicamento.
4. O servidor valida: o medicamento é o prescrito para esse idoso e horário; o lote pertence ao estoque correto, não está vencido e tem saldo; a prescrição está vigente; a dose ainda não foi registrada; não há alergia cadastrada que coincida com o princípio ativo do medicamento.
5. Se tudo confere, o cuidador escolhe o resultado: administrada, recusada (com motivo), não administrada (com motivo) ou adiada (com novo horário).
6. Ao confirmar, o registro é gravado com autor, horário, dispositivo e lote, o estoque é baixado e o cartão vira "concluído".

### 5.4 Bloqueios

| Situação | Mensagem | Ação possível |
|---|---|---|
| Pulseira de outro idoso | "Esta pulseira é de outro paciente" | Tentar com o idoso certo |
| Remédio errado | "Este medicamento não está prescrito para este horário" | Procurar o correto ou chamar o enfermeiro |
| Lote vencido | "Lote vencido em dd/mm" | Separar o lote e avisar o enfermeiro |
| Alergia cadastrada | "Alerta: alergia registrada" | Bloqueio total, o enfermeiro avalia |
| Dose já registrada | "Já registrada por [nome] às [hora]" | Nenhuma |
| Prescrição encerrada | "Prescrição não está mais vigente" | Chamar o enfermeiro |
| Divergência de estoque | "Saldo do lote não confere" | O enfermeiro faz ajuste com justificativa |

### 5.5 Exceção auditada
Apenas para etiqueta ilegível ou danificada, o enfermeiro libera o registro sem QR, identificando-se com o PIN, justificando e conferindo manualmente. O registro recebe a marca "exceção de conferência" e entra no relatório de exceções da gestão. Alergia, lote vencido e idoso errado nunca têm exceção.

### 5.6 Alto risco
Para prescrições de alto risco, após a conferência do primeiro profissional, um segundo usuário (diferente do primeiro) se identifica com o PIN e confirma. O registro só conclui com as duas identificações.

### 5.7 Doses "se necessário" (SOS)
O cuidador informa o motivo (sintoma) e segue a mesma conferência por QR. O sistema respeita o limite diário e o intervalo mínimo da prescrição. Se ultrapassar, bloqueia e avisa o enfermeiro.

### 5.8 Doses sem registro e falta de internet
- Dose não registrada 2 horas após o horário previsto fica como "sem registro" e alerta o enfermeiro. O sistema nunca assume que foi dada.
- Sem internet, o tablet avisa e impede novos registros. A equipe usa a folha de contingência impressa no início do plantão e lança depois como "registro tardio", com o horário real informado e marca na auditoria.

### 5.9 Interface do tablet
Botões grandes, 4 a 5 toques no fluxo normal, estados com ícone e texto (não apenas cor), modo quiosque, leitura de QR pela câmera com retorno sonoro e vibração, letra grande e alto contraste.

## 6. Estoque e alertas

### 6.1 Entrada
O enfermeiro ou gestor informa medicamento, lote, validade, quantidade e destino (estoque individual do idoso ou comum da casa). O sistema gera a etiqueta QR da embalagem. Blisters recortados, frascos abertos e manipulados recebem etiqueta própria com a quantidade registrada. A unidade de controle é a menor fração administrável.

### 6.2 Consumo
Toda administração confirmada baixa o lote lido. Se o saldo do lote estiver zerado mas houver o remédio fisicamente, o sistema bloqueia e o enfermeiro faz ajuste com justificativa.

### 6.3 Previsão de término
- Consumo diário previsto = soma das doses diárias das prescrições ativas do medicamento para o idoso.
- Dias restantes = saldo disponível (lotes não vencidos) ÷ consumo diário previsto.
- Prescrições com data de fim limitam o cálculo.
- SOS usa a média dos últimos 14 dias, com valor mínimo conservador sem histórico.
- Lotes que vencem antes do consumo deixam de contar a partir do vencimento.

### 6.4 Alertas (padrões configuráveis por casa)

| Alerta | Aviso | Urgente |
|---|---|---|
| Estoque acabando | 7 dias ou menos | 3 dias ou menos |
| Validade próxima | 30 dias | 7 dias |
| Lote vencido em estoque | imediato | imediato |
| Dose atrasada | passou da janela | passou de 2 horas (limite maior) |
| Dose sem registro | 2 horas após o horário previsto, alerta ao enfermeiro | fim do plantão ainda sem registro, alerta ao gestor |
| Exceção de conferência | resumo diário ao gestor | exceções repetidas pelo mesmo usuário |
| Prescrição prestes a vencer | 5 dias antes | no dia |

O alerta de estoque considera o prazo médio de reposição informado pela casa.

**Para evitar ruído:** um alerta por condição, reaviso em intervalos definidos, escalonamento ao gestor se um urgente não for lido em 2 horas (configurável), fechamento automático ao resolver e registro de quem leu.

### 6.5 Canais
- V1: painel e tela do tablet, e-mail.
- V1.1: WhatsApp ou SMS (exige conta comercial aprovada e modelos de mensagem).
- Mensagens externas nunca contêm dados de saúde, apenas a indicação de que há um alerta no sistema.

### 6.6 Perdas, descartes e inventário
Perda, quebra, descarte, devolução e ajuste exigem motivo e entram na auditoria. Ao fim de tratamento ou saída do idoso, o sistema lista as sobras para destinação. Na V1, o inventário é uma contagem manual por lote, com divergências apontadas e ajustes justificados. A leitura de QR para acelerar a contagem (inventário assistido) entra na V1.1. A reimpressão de etiqueta mantém o mesmo código e registra quem reimprimiu.

### 6.7 Telas
Visão por idoso, visão por medicamento, lista de reposição sugerida (exportável em PDF) e relatório de movimentações.

## 7. Segurança, LGPD e auditoria

### 7.1 Perfis e permissões

| Ação | Cuidador | Enfermeiro | Gestor |
|---|:-:|:-:|:-:|
| Ver escala e registrar administração | Sim | Sim | Sim |
| Segunda validação (alto risco) | Sim | Sim | Sim |
| Cadastrar ou alterar prescrição | Não | Sim | Sim |
| Liberar exceção de conferência | Não | Sim | Sim |
| Entrada, ajuste e descarte de estoque | Não | Sim | Sim |
| Cadastrar idoso, alergias e contatos | Não | Sim | Sim |
| Ver, ler e encerrar alertas | Não | Sim | Sim |
| Gerenciar usuários e configurações | Não | Não | Sim |
| Ver auditoria e relatório de exceções | Não | Não | Sim |
| Exportar os dados de um idoso (LGPD) | Não | Não | Sim |

Menor privilégio. Quem cadastra uma prescrição de alto risco não a valida sozinho. Usuário desligado perde o acesso imediatamente, mantendo o histórico. Ninguém apaga registros: correções exigem justificativa e entram na auditoria.

### 7.2 Autenticação
- Gestor e enfermeiro: e-mail e senha forte, com segundo fator no login em computador.
- Cuidador: PIN de 6 dígitos, aceito apenas em tablets cadastrados e aprovados pelo gestor. Bloqueio após tentativas erradas, bloqueio de PINs óbvios, troca obrigatória no primeiro uso.
- Ações sensíveis (exceção, segunda validação, ajuste de estoque) pedem o PIN novamente.
- O gestor revoga um tablet perdido ou roubado na hora.

### 7.3 Isolamento entre casas
RLS em todas as tabelas de negócio, com a casa derivada do usuário autenticado. Arquivos em armazenamento privado, separados por casa, com links temporários. Testes automatizados tentam acessar dados de outra casa em cada rota e precisam falhar. A equipe do produto não acessa dados de saúde dos clientes, salvo autorização da casa, com registro.

### 7.4 Proteção dos dados
Criptografia em trânsito e em repouso. Criptografia adicional na aplicação para documentos, telefones e fotos de receita, com chaves em serviço de chaves da nuvem. Segredos em cofre. Logs técnicos sem dados de saúde. Backups diários criptografados, em região do Brasil, com teste periódico de restauração. Validação de entradas, proteção contra injeção, XSS e CSRF, limite de tentativas de login, cabeçalhos de segurança, verificação automática de vulnerabilidades em dependências.

### 7.5 LGPD
- A casa é controladora dos dados; o produto é operador. Contrato de tratamento de dados com cada casa.
- Base legal principal: tutela da saúde. Consentimento específico para o portal da família, dado pelo responsável legal.
- Fluxos de exportação, correção e exclusão de dados de um idoso, tratados pela casa.
- Minimização: CPF opcional, coleta limitada ao necessário.
- Retenção configurável por casa, com padrão conservador. Os prazos definitivos dependem de revisão jurídica.
- Encarregado (DPO) do produto e de cada casa. Plano de resposta a incidentes. Relatório de impacto (RIPD) antes do lançamento.

### 7.6 Trilha de auditoria
Só inserção, com encadeamento por hash e verificação periódica da cadeia. Registra login e falhas, leitura de dados sensíveis, administrações, exceções, mudanças de prescrição, estoque, usuários e permissões, reimpressões e exportações, com autor, horário, dispositivo, IP e valores antes e depois. O horário vem do servidor. O gestor consulta com filtros e exporta em PDF ou planilha.

### 7.7 Ameaças e respostas

| Ameaça | Resposta |
|---|---|
| Uma casa vê dados de outra | RLS, arquivos isolados, testes de vazamento |
| Registro feito com o usuário de outra pessoa | PIN individual, reautenticação, sessão curta |
| Tablet roubado | Modo quiosque, revogação, nenhum dado salvo no aparelho |
| Funcionário tenta apagar o próprio erro | Sem exclusão, correção justificada, auditoria encadeada |
| Contornar a conferência por QR | Validação no servidor, exceção só por enfermeiro, relatório de exceções |
| Dados vazados por mensagem externa | Alertas sem dados de saúde |
| Credenciais de gestor comprometidas | Segundo fator, bloqueio por tentativas, alerta de login incomum |
| Falha do fornecedor ou erro humano | Backups testados e plano de restauração |

## 8. Testes, entrega e operação

### 8.1 Estratégia de testes

| Nível | Cobertura | Prioridade |
|---|---|---|
| Regras de conferência (unitários) | Todas as combinações da seção 5 | Máxima, cobertura próxima de 100% do módulo |
| Estoque (unitários) | Baixa automática, saldo por movimentos, previsão, fracionamento, vencimento | Alta |
| Integração com banco real | RLS, auditoria só de inserção, hash encadeado, concorrência | Alta |
| Vazamento entre casas | Acesso cruzado em cada rota deve falhar | Obrigatório a cada alteração |
| Ponta a ponta | Fluxos críticos no tablet, incluindo bloqueios, exceção, alto risco e contingência | Fluxos críticos |
| Alertas e agendador | Geração de doses, alertas, escalonamento, fusos e horário de verão | Alta |
| Acessibilidade e usabilidade | Contraste, toque, pouca luz, teste com cuidadores reais | Antes da piloto |

Dados de teste: casa fictícia com prescrições complexas e estoques variados. Nenhuma alteração vai para produção se falhar algum teste de regras de conferência, isolamento ou auditoria.

### 8.2 Entrega contínua
A cada alteração: verificação de tipos, análise estática, testes, verificação de vulnerabilidades e busca por segredos. Três ambientes, sem dados reais fora de produção. Migrações versionadas, testadas em homologação e compatíveis com a versão anterior. Deploy fora dos horários de medicação, com verificação automática e reversão rápida. Infraestrutura como código.

### 8.3 Monitoramento e confiabilidade
Metas iniciais: disponibilidade de 99,9% do fluxo de registro, resposta do registro abaixo de 1 segundo na maioria das vezes, alertas entregues no prazo em 99% dos casos.

Monitoramento de erros, latência e banco; "batimento cardíaco" do agendador, com alerta se ele deixar de rodar; verificação periódica da cadeia de auditoria; sinalização de tablets sem comunicação; alerta de falha de backup. Runbook para os cenários mais prováveis e canal de plantão. Relato escrito para cada incidente grave.

### 8.4 Implantação na casa-piloto
1. Preparação (1 a 2 semanas): checar internet, instalar conexão de backup, configurar tablets e impressora, assinar o contrato de tratamento de dados.
2. Cadastro inicial: idosos, alergias, contatos, prescrições e estoque, com impressão de etiquetas e pulseiras.
3. Treinamento por turno, incluindo bloqueios e queda de internet.
4. Operação em paralelo (2 a 4 semanas), comparando o sistema com o método atual.
5. Passagem para registro oficial, com acompanhamento na primeira semana e folha de contingência disponível.
6. Revisão após 30 dias.

Critérios de sucesso: doses com registro acima de meta combinada com a casa (sugestão: 98% das doses previstas), poucas exceções de conferência, nenhum incidente de isolamento de dados e feedback positivo da equipe sobre o tempo por registro.

## 9. Plano de fases do produto

| Fase | Conteúdo |
|---|---|
| V1 | Este documento |
| V1.1 | Alertas por WhatsApp ou SMS, relatórios de gestão (adesão, exceções, consumo), inventário assistido |
| V2 | Relatório diário de saúde por idoso, agenda de exames e consultas |
| V3 | Portal da família (resumo diário aprovado pelo enfermeiro, acesso por idoso e por familiar), comunicação interna e passagem de plantão |
| Futuro | App nativo, integração com farmácias, alertas de sinais vitais, registro de quedas e incidentes |

## 10. Riscos e pontos em aberto

- **Regulação:** confirmar com especialista se o software se enquadra nas regras da Anvisa para software de saúde e quais exigências do COREN e da vigilância sanitária local afetam o registro de medicação.
- **Jurídico:** contratos, política de privacidade e prazos de retenção de prontuário revisados por advogado especializado.
- **Adoção:** o maior risco costuma ser a equipe achar o sistema lento. Medir o tempo por registro e testar com cuidadores reais são requisitos.
- **Dependência de internet:** mitigada por chip de backup e folha de contingência. Se a piloto mostrar quedas frequentes, reabrir a decisão sobre modo offline.
- **Mercado:** validar com 2 ou 3 casas se a conferência por QR é um diferencial que justifica a troca do que usam hoje.
- **Segurança:** teste de invasão por terceiros antes do uso real.
