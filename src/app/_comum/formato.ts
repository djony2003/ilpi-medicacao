// Datas e números como a equipe lê: hora de parede no fuso da casa, vírgula decimal.

export const FUSO_PADRAO = "America/Sao_Paulo";

export function hora(iso: string, fuso = FUSO_PADRAO): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function dataCurta(isoData: string): string {
  const [, m, d] = isoData.split("-");
  return `${d}/${m}`;
}

export function numero(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

const UNIDADES: Record<string, [string, string]> = {
  comprimido: ["comprimido", "comprimidos"],
  capsula: ["cápsula", "cápsulas"],
  gotas: ["gota", "gotas"],
  ml: ["mL", "mL"],
  mg: ["mg", "mg"],
  g: ["g", "g"],
  mcg: ["mcg", "mcg"],
  ui: ["UI", "UI"],
  aplicacao: ["aplicação", "aplicações"],
  jato: ["jato", "jatos"],
  adesivo: ["adesivo", "adesivos"],
};

export function quantidade(n: number, unidade: string): string {
  const [um, varios] = UNIDADES[unidade] ?? [unidade, unidade];
  return `${numero(n)} ${n === 1 ? um : varios}`;
}

const VIAS: Record<string, string> = {
  oral: "pela boca",
  sublingual: "embaixo da língua",
  topica: "na pele",
  oftalmica: "nos olhos",
  otica: "no ouvido",
  nasal: "no nariz",
  inalatoria: "por inalação",
  retal: "via retal",
  subcutanea: "injeção subcutânea",
  intramuscular: "injeção intramuscular",
  intravenosa: "na veia",
  transdermica: "adesivo na pele",
};

export const via = (v: string) => VIAS[v] ?? v;

/** Data e hora local (AAAA-MM-DD, HH:MM) → instante ISO, no fuso da casa. */
export function instanteNoFuso(data: string, horaMin: string, fuso = FUSO_PADRAO): string {
  const [a = 0, m = 1, d = 1] = data.split("-").map(Number);
  const [h = 0, mi = 0] = horaMin.split(":").map(Number);
  const comoUtc = Date.UTC(a, m - 1, d, h, mi);
  // Deslocamento do fuso naquele instante (uma correção basta: o Brasil não tem horário de verão
  // desde 2019, e onde houver, a hora ambígua cai na primeira ocorrência).
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(comoUtc));
  const p = Object.fromEntries(partes.map((x) => [x.type, Number(x.value)]));
  const mostrado = Date.UTC(
    p.year ?? a,
    (p.month ?? m) - 1,
    p.day ?? d,
    p.hour ?? h,
    p.minute ?? mi,
  );
  return new Date(comoUtc - (mostrado - comoUtc)).toISOString();
}
