// Filtros de período dos relatórios: datas de calendário (AAAA-MM-DD) no fuso da casa.

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export function dataDeCalendarioValida(texto: string): boolean {
  if (!DATA.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

export type Periodo = { de: string; ate: string };

/** Hoje (AAAA-MM-DD) no fuso informado. */
export function hojeNoFuso(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(agora);
}

export function somarDias(data: string, dias: number): string {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Problemas do período (lista vazia = válido). `ate` é inclusivo. */
export function problemasDoPeriodo(de: string, ate: string, maximoDias = 366): string[] {
  const p: string[] = [];
  if (!dataDeCalendarioValida(de)) p.push("A data inicial é inválida.");
  if (!dataDeCalendarioValida(ate)) p.push("A data final é inválida.");
  if (p.length > 0) return p;
  if (ate < de) p.push("A data final não pode ser anterior à inicial.");
  else if (
    (new Date(`${ate}T00:00:00Z`).getTime() - new Date(`${de}T00:00:00Z`).getTime()) / 86_400_000 >
    maximoDias
  )
    p.push(`O período não pode passar de ${maximoDias} dias.`);
  return p;
}

/** Brasil: dd/mm/aaaa a partir de AAAA-MM-DD. */
export function dataBr(data: string): string {
  const [a, m, d] = data.split("-");
  return `${d}/${m}/${a}`;
}

export function dataHoraBr(iso: string, fuso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));
}
