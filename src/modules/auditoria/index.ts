// Módulo auditoria: registro imutável de todas as ações, com hash encadeado por casa.
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export { registrarAuditoria, type EventoDeAuditoria } from "./dados/registrar";
export { verificarCadeiaDeAuditoria, type ProblemaDeCadeia } from "./dados/verificar";
export { acharSegredo } from "./dominio/segredos";
