// Módulo alertas: condições de estoque, validade, doses, prescrições, exceções e SOS; painel,
// leitura, encerramento e e-mail sem dados de saúde.
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export {
  CONFIGURACAO_PADRAO,
  FAIXAS,
  configuracaoDeAlertas,
  problemasDaConfiguracao,
  type ConfiguracaoDeAlertas,
} from "./dominio/configuracao";
export {
  deveEnviarEmail,
  reconciliar,
  type AlertaAberto,
  type Condicao,
  type Destino,
  type Gravidade,
  type Plano,
  type TipoDeAlerta,
  type Tratado,
} from "./dominio/reconciliacao";
export {
  condicoesDeDoses,
  condicoesDeEstoque,
  condicoesDeExcecoes,
  condicoesDePrescricoes,
  condicoesDeSos,
  condicoesDeValidade,
  fimDoPlantao,
  type DoseParaAlerta,
  type LoteParaAlerta,
  type PrescricaoParaAlerta,
  type ReservaParaAlerta,
  type SosBloqueado,
} from "./dominio/condicoes";
export { montarEmail, type EmailDeAlerta } from "./dominio/email";
export {
  INFORMATIVOS,
  casasAtivas,
  verificarAlertasDaCasa,
  type ResultadoDaVerificacao,
  type ServicoDeAlertas,
} from "./dados/verificacao";
export {
  ESPERAS_MIN,
  MAXIMO_DE_TENTATIVAS,
  enviarAlertasDaCasa,
  type ResultadoDoEnvio,
} from "./dados/envio";
export {
  encerrarAlerta,
  listarAlertas,
  marcarComoLido,
  resumoDosAlertas,
  type AlertaDoPainel,
  type FiltroDoPainel,
  type ResumoDosAlertas,
} from "./dados/painel";
export { configurarAlertas, obterConfiguracaoDeAlertas } from "./dados/configuracao";
