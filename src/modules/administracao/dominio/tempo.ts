// Hora de parede em um fuso → instante absoluto, com horário de verão. Usa só `Intl` do Node (base
// de fusos do sistema), sem biblioteca de datas.
//
// Regras nos dois casos difíceis, para o resultado ser sempre UM instante e sempre o mesmo:
//  - hora que NÃO existe (relógio adianta, ex.: 02:30 quando 02:00 vira 03:00): vale o instante da
//    própria mudança (o relógio passa a mostrar 03:00). A dose sai no primeiro momento possível
//    depois do horário prescrito, sem atrasar além do necessário, e a ordem dos horários se mantém.
//  - hora que existe DUAS vezes (relógio atrasa, ex.: 01:30 acontece duas vezes): vale a PRIMEIRA
//    ocorrência. Nunca gera duas doses.

const formatadores = new Map<string, Intl.DateTimeFormat>();

function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: fuso,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatadores.set(fuso, f);
  }
  return f;
}

export function fusoValido(fuso: string): boolean {
  try {
    formatador(fuso);
    return true;
  } catch {
    return false;
  }
}

type Partes = {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
};

function partesNoFuso(instanteMs: number, fuso: string): Partes {
  const p: Record<string, number> = {};
  for (const parte of formatador(fuso).formatToParts(new Date(instanteMs))) {
    if (parte.type !== "literal") p[parte.type] = Number(parte.value);
  }
  return {
    ano: p.year ?? 0,
    mes: p.month ?? 0,
    dia: p.day ?? 0,
    hora: p.hour ?? 0,
    minuto: p.minute ?? 0,
    segundo: p.second ?? 0,
  };
}

/** Diferença, em ms, entre a hora de parede no fuso e UTC naquele instante (positivo a leste). */
export function deslocamentoMs(instanteMs: number, fuso: string): number {
  const p = partesNoFuso(instanteMs, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/** Data de calendário (AAAA-MM-DD) que o relógio do fuso mostra naquele instante. */
export function dataLocalDe(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante.getTime(), fuso);
  return `${String(p.ano).padStart(4, "0")}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

const DIA_MS = 86_400_000;

export function instanteLocal(data: string, hora: string, fuso: string): Date {
  const [a = 0, m = 1, d = 1] = data.split("-").map(Number);
  const [h = 0, mi = 0] = hora.split(":").map(Number);
  const comoUtc = Date.UTC(a, m - 1, d, h, mi, 0);

  // Os deslocamentos possíveis naquele dia: os de um dia antes e um dia depois cobrem qualquer
  // mudança de horário que aconteça no meio.
  const candidatos = new Set([
    deslocamentoMs(comoUtc - DIA_MS, fuso),
    deslocamentoMs(comoUtc + DIA_MS, fuso),
  ]);
  const validos: number[] = [];
  for (const deslocamento of candidatos) {
    const instante = comoUtc - deslocamento;
    if (deslocamentoMs(instante, fuso) === deslocamento) validos.push(instante);
  }
  if (validos.length > 0) return new Date(Math.min(...validos)); // 1 válido, ou 2 (a primeira vez)

  // Hora inexistente: acha o instante exato da mudança de horário (primeiro instante já com o
  // deslocamento novo), por busca binária entre os dois extremos possíveis.
  const antes = deslocamentoMs(comoUtc - DIA_MS, fuso);
  const depois = deslocamentoMs(comoUtc + DIA_MS, fuso);
  let baixo = Math.min(comoUtc - antes, comoUtc - depois); // ainda com o deslocamento antigo
  let alto = Math.max(comoUtc - antes, comoUtc - depois); // já com o novo
  while (alto - baixo > 1000) {
    const meio = Math.floor((baixo + alto) / 2);
    if (deslocamentoMs(meio, fuso) === depois) alto = meio;
    else baixo = meio;
  }
  return new Date(alto);
}

/** Hora de parede (HH:MM) que o relógio do fuso mostra naquele instante. */
export function horaLocalDe(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante.getTime(), fuso);
  return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}
