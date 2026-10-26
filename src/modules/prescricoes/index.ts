// Módulo prescricoes: medicamento, dose, via, horários, vigência e foto da receita.
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export {
  cadastrarMedicamento,
  definirAltoRiscoDoMedicamento,
  desativarMedicamento,
  listarMedicamentos,
  type MedicamentoDoCatalogo,
  type NovoMedicamento,
} from "./dados/medicamentos";
export {
  encerrarPrescricao,
  listarPrescricoes,
  novaVersao,
  obterPrescricao,
  prescrever,
  prescricoesDoIdoso,
  prescricoesRegularesAtivas,
  type FalhaDeAlergia,
  type NovaPrescricao,
  type PrescricaoDetalhada,
  type PrescricaoRegularAtiva,
} from "./dados/prescricoes";
export {
  TAMANHO_MAXIMO_RECEITA,
  anexarReceita,
  detectarTipoDeReceita,
  lerReceita,
  listarReceitas,
  type ReceitaDaPrescricao,
  type TipoDeReceita,
} from "./dados/receitas";
export {
  conflitosComAlergia,
  normalizarNome,
  type AlergiaParaConferir,
  type ConflitoDeAlergia,
} from "./dominio/alergia";
export { sugerirAltoRisco } from "./dominio/alto-risco";
export { verificarLimiteSos, type LimiteSos, type ResultadoSos } from "./dominio/sos";
export * from "./dominio/tipos";
export {
  MAX_HORARIOS_POR_DIA,
  normalizarDias,
  normalizarHora,
  validarPrescricao,
} from "./dominio/validacao";
export { diferencasClinicas, type CampoClinico } from "./dominio/versao";
export {
  diasParaVencer,
  estaVigente,
  horariosNoDia,
  situacaoDeVigencia,
  type SituacaoDeVigencia,
} from "./dominio/vigencia";
