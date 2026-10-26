import { diaDaSemanaIso, diasEntre } from "@/compartilhado/datas";
import { normalizarDias, normalizarHora } from "./validacao";
import type { Horario, StatusDePrescricao } from "./tipos";

export type SituacaoDeVigencia = "futura" | "vigente" | "vencida" | "encerrada";

type ComVigencia = { status: StatusDePrescricao; inicio: string; fim: string | null };

/** Situação da prescrição numa data (no fuso da casa). O fim é inclusivo: vale o dia inteiro. */
export function situacaoDeVigencia(p: ComVigencia, data: string): SituacaoDeVigencia {
  if (p.status !== "ativa") return "encerrada";
  if (data < p.inicio) return "futura";
  if (p.fim !== null && data > p.fim) return "vencida";
  return "vigente";
}

export function estaVigente(p: ComVigencia, data: string): boolean {
  return situacaoDeVigencia(p, data) === "vigente";
}

/** Dias até o último dia de vigência (0 = vence hoje). Null se for uso contínuo ou já inativa. */
export function diasParaVencer(p: ComVigencia, hoje: string): number | null {
  if (p.fim === null || !estaVigente(p, hoje)) return null;
  return diasEntre(hoje, p.fim);
}

/** Horários (HH:MM, em ordem) em que a dose cai numa data. Só faz sentido para prescrição regular. */
export function horariosNoDia(horarios: Horario[], data: string): string[] {
  const dia = diaDaSemanaIso(data);
  return horarios
    .filter((h) => normalizarDias(h.diasSemana).includes(dia))
    .map((h) => normalizarHora(h.hora))
    .filter((h): h is string => h !== null)
    .sort();
}
