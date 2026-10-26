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
export {
  dataLocalDe,
  deslocamentoMs,
  fusoValido,
  horaLocalDe,
  instanteLocal,
} from "./dominio/tempo";
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
export {
  RESULTADOS,
  conferirDose,
  problemaNoAdiamento,
  regraDeHorario,
  usaMedicamento,
  type Bloqueio,
  type CodigoDeBloqueio,
  type EntradaDaConferencia,
  type LeituraDaPulseira,
  type LeituraDoLote,
  type LoteParaConferir,
  type PrescricaoParaConferir,
  type RegraDeHorario,
  type RegistroAnterior,
  type ResultadoDaAdministracao,
  type ResultadoDaConferencia,
} from "./dominio/conferencia";
export {
  MOTIVOS_DE_EXCECAO,
  type ExcecaoDeConferencia,
  type FalhaDeConfirmacao,
  type MotivoDaExcecao,
  type PinDeOutraPessoa,
} from "./dados/comum";
export {
  conferirDoseAgendada,
  lotesDaDose,
  obterDose,
  registrarDose,
  type ConferenciaDaDose,
  type LoteDisponivel,
  type PedidoDeConferencia,
  type RegistroDaDose,
  type RegistroDeDose,
  type ResultadoDoRegistro,
} from "./dados/registro";
export {
  listarSosDoIdoso,
  registrarSos,
  type FalhaDeLimiteSos,
  type RegistroSos,
  type ResultadoDoSos,
  type SosDoIdoso,
} from "./dados/sos";
export {
  PRAZO_DO_REGISTRO_TARDIO_DIAS,
  registrarTardio,
  type RegistroTardio,
  type ResultadoDoTardio,
} from "./dados/tardio";
export { LIMITES_DA_JANELA, configurarJanela, obterJanela } from "./dados/configuracao";
