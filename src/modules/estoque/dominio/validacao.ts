import { dataValida, diasEntre } from "@/compartilhado/datas";
import { UNIDADES, type UnidadeDeDose } from "@/modules/prescricoes";
import { problemaDeQuantidade } from "./quantidade";

// Validação das entradas de estoque, sem banco: o que a equipe digitou precisa fazer sentido
// antes de gravar. As mensagens são para quem está no balcão, em português claro.

/** Validade além deste prazo costuma ser erro de digitação (ano 2062 em vez de 2026). */
export const VALIDADE_MAXIMA_ANOS = 10;

/** Saídas de estoque que a equipe lança à mão. O consumo vem da administração, nunca daqui. */
export const MOTIVOS_DE_SAIDA = ["perda", "descarte", "devolucao", "ajuste"] as const;
export type TipoDeSaidaManual = (typeof MOTIVOS_DE_SAIDA)[number];

export type EntradaDeLote = {
  medicamentoId: string;
  /** Ausente ou null = estoque comum da casa. */
  idosoId?: string | null;
  numeroLote: string;
  validade: string;
  unidade: UnidadeDeDose;
  quantidade: number;
  observacao?: string | null;
};

export function validarEntradaDeLote(e: EntradaDeLote, hoje: string): string[] {
  const p: string[] = [];
  const numero = e.numeroLote.trim();
  if (numero.length < 1 || numero.length > 60) {
    p.push("O número do lote deve ter entre 1 e 60 caracteres.");
  }
  if (!dataValida(e.validade)) {
    p.push("Informe a validade como uma data real (AAAA-MM-DD).");
  } else if (e.validade < hoje) {
    p.push("Este lote já está vencido: não pode entrar no estoque.");
  } else if (diasEntre(hoje, e.validade) > VALIDADE_MAXIMA_ANOS * 366) {
    p.push("Confira a validade: está a mais de 10 anos.");
  }
  if (!UNIDADES.includes(e.unidade)) p.push("Unidade desconhecida.");
  else {
    const q = problemaDeQuantidade(e.quantidade, e.unidade);
    if (q) p.push(q);
  }
  const obs = e.observacao?.trim();
  if (obs !== undefined && obs.length > 300) {
    p.push("A observação pode ter no máximo 300 caracteres.");
  }
  return p;
}

/** Perda, descarte, devolução, ajuste e divergência de inventário não valem sem motivo. */
export function problemaDeMotivo(motivo: string): string | null {
  const m = motivo.trim();
  if (m.length < 3 || m.length > 500) return "Informe o motivo (3 a 500 caracteres).";
  return null;
}
