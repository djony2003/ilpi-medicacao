// Módulo estoque: entrada com etiqueta QR, saldo, validade, consumo e alertas.
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export {
  emitirEtiqueta,
  fracionarLote,
  listarLotes,
  obterLote,
  registrarEntrada,
  type DetalheDoLote,
  type FalhaDeEntrada,
  type FalhaDeFracionamento,
  type FiltroDeLotes,
  type LoteDoEstoque,
  type MovimentoDoLote,
} from "./dados/lotes";
export { lancarSaida, type ResultadoDaSaida, type SaidaManual } from "./dados/movimentos";
export {
  cancelarInventario,
  concluirInventario,
  iniciarInventario,
  listarInventarios,
  obterInventario,
  registrarContagem,
  type DetalheDoInventario,
  type FalhaDeConclusao,
  type ItemDoInventario,
} from "./dados/inventario";
export {
  COBERTURA_PADRAO_DIAS,
  DIAS_PARA_REPOR_PADRAO,
  listaDeReposicao,
  listarSobras,
  situacaoDoEstoque,
  type FiltroDeSituacao,
  type ItemDeReposicao,
  type ListaDeReposicao,
  type MotivoDeSobra,
  type ReservaDeEstoque,
  type SobraDeEstoque,
} from "./dados/situacao";
export { ehSaldoInsuficiente } from "./dados/saldo";
export {
  consumirParaAdministracao,
  lerLote,
  loteParaConferencia,
  lotesParaUso,
  type LeituraDeLote,
  type LoteNaConferencia,
} from "./dados/consumo";
export { gerarPdfDaEtiqueta, type DadosParaEtiqueta } from "./dominio/etiqueta-pdf";
export {
  HORIZONTE_PADRAO_DIAS,
  SOS_MINIMO_DOSES_POR_DIA,
  consumoDiarioMedio,
  faltaParaCobrir,
  preverEstoque,
  type Demanda,
  type DemandaRegular,
  type DemandaSos,
  type EntradaDaPrevisao,
  type LoteParaPrever,
  type LoteQueVenceSemUso,
  type Previsao,
} from "./dominio/previsao";
export {
  QUANTIDADE_MAXIMA,
  arredondarParaCima,
  deMilesimos,
  emMilesimos,
  passoDaUnidade,
  problemaDeQuantidade,
  somar,
  subtrair,
} from "./dominio/quantidade";
export { gerarPdfDaReposicao, type DadosParaReposicao } from "./dominio/reposicao-pdf";
export { demandaDaPrescricao, montarReservas, type Reserva } from "./dominio/reservas";
export {
  LIMITES_DE_ESTOQUE_PADRAO,
  LIMITES_DE_VALIDADE_PADRAO,
  diasParaVencer,
  loteVencido,
  situacaoDeEstoque,
  situacaoDeValidade,
  type SituacaoDeEstoque,
  type SituacaoDeValidade,
} from "./dominio/validade";
export {
  MOTIVOS_DE_SAIDA,
  VALIDADE_MAXIMA_ANOS,
  problemaDeMotivo,
  validarEntradaDeLote,
  type EntradaDeLote,
  type TipoDeSaidaManual,
} from "./dominio/validacao";
