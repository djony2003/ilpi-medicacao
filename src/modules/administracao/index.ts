// Módulo administracao: escala do plantão, leitura de QR, conferência e registro.
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export {
  MAX_DIAS_DE_GERACAO,
  dosesDoPeriodo,
  type DoseGerada,
  type PrescricaoParaGerar,
} from "./dominio/geracao";
export {
  JANELA_PADRAO,
  classificarRegistro,
  compararParaEscala,
  estadoDaDose,
  janelaDaCasa,
  minutosDesde,
  type ClasseDoRegistro,
  type EstadoDaDose,
  type JanelaDaCasa,
} from "./dominio/estado";
export { dataLocalDe, deslocamentoMs, fusoValido, instanteLocal } from "./dominio/tempo";
export {
  DIAS_PADRAO_DE_GERACAO,
  gerarDosesDaCasa,
  gerarEscalaDeTodasAsCasas,
  type ResultadoDaGeracao,
  type ResultadoDoAgendador,
  type ServicoDeGeracao,
} from "./dados/geracao";
export {
  JANELA_MAXIMA_DA_ESCALA_H,
  dadosDaFolhaDeContingencia,
  escalaDoPlantao,
  type AlergiaNaEscala,
  type DadosDaFolha,
  type DoseDaEscala,
  type EscalaDoPlantao,
  type PeriodoDaEscala,
} from "./dados/escala";
export { gerarPdfDaFolha, type DadosParaFolha } from "./dominio/folha-pdf";
