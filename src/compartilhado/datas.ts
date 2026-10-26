// Datas de calendário (AAAA-MM-DD) tratadas como texto: sem fuso, sem horário de verão. A conversão
// de um instante para "a data de hoje na casa" é feita uma única vez, no banco, com o fuso da casa.

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Confere formato AAAA-MM-DD e se o dia existe de verdade (30 de fevereiro não passa). */
export function dataValida(texto: string): boolean {
  const m = DATA_ISO.exec(texto);
  if (!m) return false;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

function emUtc(iso: string): number {
  const [a = 0, m = 1, d = 1] = iso.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
}

export function somarDias(iso: string, dias: number): string {
  return new Date(emUtc(iso) + dias * 86_400_000).toISOString().slice(0, 10);
}

/** Dias de `de` até `ate` (negativo se `ate` for anterior). */
export function diasEntre(de: string, ate: string): number {
  return Math.round((emUtc(ate) - emUtc(de)) / 86_400_000);
}

/** Dia da semana no padrão ISO: 1 = segunda ... 7 = domingo. */
export function diaDaSemanaIso(iso: string): number {
  const d = new Date(emUtc(iso)).getUTCDay();
  return d === 0 ? 7 : d;
}
