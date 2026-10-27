// Módulo relatorios: consultas de gestão que atravessam módulos (trilha de auditoria, exceções de
// conferência) e a exportação dos dados de um residente (LGPD).
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export {
  LIMITE_DA_CONSULTA,
  LIMITE_DA_EXPORTACAO,
  consultarAuditoria,
  exportarAuditoria,
  verificarAuditoria,
  type ExportacaoDeAuditoria,
  type FiltroDeAuditoria,
  type RegistroDeAuditoria,
} from "./dados/auditoria";
export { csvDaAuditoria, descricaoDoFiltro, pdfDaAuditoria } from "./dominio/auditoria-export";
export {
  ROTULOS_DE_EXCECAO,
  relatorioDeExcecoes,
  type ItemDeExcecao,
  type RelatorioDeExcecoes,
} from "./dados/excecoes";
export { csvDeExcecoes, pdfDeExcecoes } from "./dominio/excecoes-export";
export { exportarDadosDoIdoso, type ExportacaoDoIdoso } from "./dados/exportacao-idoso";
export { dataDeCalendarioValida, problemasDoPeriodo } from "./dominio/periodo";
