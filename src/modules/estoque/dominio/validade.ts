import { diasEntre } from "@/compartilhado/datas";

// Validade de lote. A data gravada é o ÚLTIMO dia de uso (inclusive): um lote com validade
// 2026-10-31 ainda pode ser administrado em 31/10 e está vencido em 01/11. Toda a aplicação
// (inclusive o registro da dose, no M5) usa estas funções, para ninguém decidir de outro jeito.

export type SituacaoDeValidade = "vencido" | "urgente" | "aviso" | "ok";

/** Padrões da spec (6.4): aviso com 30 dias, urgente com 7. Configuráveis por casa mais adiante. */
export const LIMITES_DE_VALIDADE_PADRAO = { avisoDias: 30, urgenteDias: 7 } as const;

export type LimitesDeValidade = { avisoDias: number; urgenteDias: number };

export function loteVencido(validade: string, hoje: string): boolean {
  return validade < hoje;
}

/** Dias até o último dia de uso (0 = vence hoje, negativo = já vencido). */
export function diasParaVencer(validade: string, hoje: string): number {
  return diasEntre(hoje, validade);
}

export function situacaoDeValidade(
  validade: string,
  hoje: string,
  limites: LimitesDeValidade = LIMITES_DE_VALIDADE_PADRAO,
): SituacaoDeValidade {
  const dias = diasParaVencer(validade, hoje);
  if (dias < 0) return "vencido";
  if (dias <= limites.urgenteDias) return "urgente";
  if (dias <= limites.avisoDias) return "aviso";
  return "ok";
}

export type SituacaoDeEstoque = "ok" | "aviso" | "urgente";

/** Padrões da spec (6.4): aviso com 7 dias ou menos de estoque, urgente com 3 ou menos. */
export const LIMITES_DE_ESTOQUE_PADRAO = { avisoDias: 7, urgenteDias: 3 } as const;

export function situacaoDeEstoque(
  diasRestantes: number | null,
  limites: LimitesDeValidade = LIMITES_DE_ESTOQUE_PADRAO,
): SituacaoDeEstoque {
  if (diasRestantes === null) return "ok";
  if (diasRestantes <= limites.urgenteDias) return "urgente";
  if (diasRestantes <= limites.avisoDias) return "aviso";
  return "ok";
}
