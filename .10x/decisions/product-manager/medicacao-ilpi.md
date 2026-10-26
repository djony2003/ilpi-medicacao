# Product Manager — medicacao-ilpi

**Data:** 2026-10-25
**Estado:** Confirmado (spec aprovada pelo usuário)

## Problema
Casas de idosos controlam medicação com papel e processos manuais, o que gera risco de erro de dose, horário ou paciente, estoque que acaba sem aviso e falta de rastreabilidade.

## Usuários
- **Cuidador:** registra administrações no tablet do posto.
- **Enfermeiro:** cadastra prescrições, gerencia estoque, libera exceções.
- **Gestor:** configura a casa, acompanha exceções e auditoria.
- **Família:** fora da V1 (portal na V3).

## Escopo da V1
Cadastro de casas, usuários e idosos (alergias, contatos, pulseira QR), prescrições versionadas, escala por plantão, registro com conferência por QR, segunda validação para alto risco, doses SOS, estoque com etiquetas QR, alertas por painel e e-mail, auditoria imutável, folha de contingência e onboarding de etiquetas e pulseiras.

## Histórias principais
- Como cuidador, quero registrar uma dose lendo a pulseira e a etiqueta, para ter certeza de que o remédio e o idoso estão certos.
- Como enfermeiro, quero cadastrar a prescrição a partir da receita, para que a escala seja gerada automaticamente.
- Como enfermeiro, quero ser avisado antes de o remédio acabar, a tempo de repor.
- Como gestor, quero ver exceções e histórico completo, para auditar a operação.

## Critérios de sucesso da piloto
- Doses com registro acima de meta combinada com a casa (sugestão: 98% das doses previstas).
- Poucas exceções de conferência.
- Nenhum incidente de isolamento de dados entre casas.
- Feedback positivo da equipe sobre o tempo por registro.

## Fora da V1
Relatório diário de saúde, agenda de exames, portal da família, comunicação interna, WhatsApp ou SMS (V1.1), app nativo, integrações com farmácias.
