import type { UnidadeDeDose } from "@/modules/prescricoes";

// Quantidades de estoque. O banco guarda numeric(12,3); aqui a conta é feita em milésimos
// inteiros para somar e subtrair sem os erros de arredondamento de ponto flutuante
// (0,1 + 0,2 não é 0,3 em JavaScript, e saldo de remédio não pode ter essa dúvida).

export const QUANTIDADE_MAXIMA = 999_999;

export function emMilesimos(valor: number): number {
  return Math.round(valor * 1000);
}

export function deMilesimos(milesimos: number): number {
  return milesimos / 1000;
}

/** Soma em milésimos e devolve o resultado exato com 3 casas. */
export function somar(...valores: number[]): number {
  return deMilesimos(valores.reduce((total, v) => total + emMilesimos(v), 0));
}

export function subtrair(a: number, b: number): number {
  return deMilesimos(emMilesimos(a) - emMilesimos(b));
}

// Itens que se contam e se partem em fração: comprimido pode ser meio ou um quarto, mas não 0,333.
const CONTAVEIS: ReadonlySet<UnidadeDeDose> = new Set([
  "comprimido",
  "capsula",
  "gotas",
  "aplicacao",
  "jato",
  "adesivo",
]);

/** Menor fração aceita no estoque daquela unidade. */
export function passoDaUnidade(unidade: UnidadeDeDose): number {
  return CONTAVEIS.has(unidade) ? 0.25 : 0.001;
}

/**
 * Confere uma quantidade informada pela equipe. Devolve a mensagem do problema, ou null se vale.
 * `permitirZero` serve à contagem de inventário, onde "não sobrou nada" é uma resposta válida.
 */
export function problemaDeQuantidade(
  valor: number,
  unidade: UnidadeDeDose,
  opcoes: { permitirZero?: boolean; permitirNegativa?: boolean } = {},
): string | null {
  if (!Number.isFinite(valor)) return "Informe a quantidade em números.";
  const m = emMilesimos(valor);
  if (Math.abs(valor * 1000 - m) > 1e-6) return "Use no máximo 3 casas decimais.";
  if (m === 0 && !opcoes.permitirZero) return "A quantidade não pode ser zero.";
  if (m < 0 && !opcoes.permitirNegativa) return "A quantidade não pode ser negativa.";
  if (Math.abs(m) > QUANTIDADE_MAXIMA * 1000) {
    return `A quantidade não pode passar de ${QUANTIDADE_MAXIMA}.`;
  }
  const passo = emMilesimos(passoDaUnidade(unidade));
  if (Math.abs(m) % passo !== 0) {
    return passo === 250
      ? "Para esta unidade, use múltiplos de 0,25 (inteiro, meio, um quarto)."
      : "Quantidade com precisão maior do que a permitida.";
  }
  return null;
}

/** Arredonda para cima ao próximo múltiplo do passo da unidade (usado para sugerir compras). */
export function arredondarParaCima(valor: number, unidade: UnidadeDeDose): number {
  const passo = emMilesimos(passoDaUnidade(unidade));
  // Arredondar para CIMA exige olhar o valor bruto: arredondar para o milésimo mais próximo antes
  // faria 10,0001 virar 10 e a compra sugerida ficaria curta. A folga de 1e-9 absorve o ruído do
  // ponto flutuante (0,3 × 1000 = 300,00000000000006) sem subir um passo inteiro à toa.
  const m = Math.ceil(valor * 1000 - 1e-9);
  return deMilesimos(Math.ceil(m / passo) * passo);
}
