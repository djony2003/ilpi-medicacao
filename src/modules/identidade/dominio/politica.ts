// Prazos e limites de acesso em um só lugar, para a regra de segurança ser lida e revista sem
// caçar números espalhados pelo código.

const MINUTO = 60_000;
const HORA = 60 * MINUTO;

export const POLITICA = {
  /** Falhas seguidas (senha, segundo fator ou PIN) que bloqueiam a conta. */
  maximoDeFalhas: 5,
  bloqueioMs: 15 * MINUTO,

  web: {
    /** Depois da senha, o segundo fator precisa ser concluído neste prazo. */
    segundoFatorMs: 5 * MINUTO,
    duracaoMaximaMs: 12 * HORA,
    inatividadeSegundos: 30 * 60,
  },

  tablet: {
    duracaoMaximaMs: 12 * HORA,
    /** Quem sai do tablet sem encerrar não deixa a tela aberta para o próximo. */
    inatividadeSegundos: 2 * 60,
    /** Falhas de PIN no mesmo aparelho antes de exigir um gestor. */
    maximoDeFalhasDePin: 5,
  },

  /** Ação sensível (trocar senha, aprovar aparelho) exige senha digitada de novo neste prazo. */
  reautenticacaoMs: 5 * MINUTO,

  codigoDeAtivacaoMs: 30 * MINUTO,
} as const;
