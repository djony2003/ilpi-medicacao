// Estado de uma dose para a tela e regras de horário do registro (seção 5.2 da spec). Puro.

const MIN = 60_000;

export type JanelaDaCasa = {
  /** Tolerância antes e depois do horário previsto (registro normal). Padrão 30. */
  janelaMin: number;
  /** Depois disso (ou antes, no sentido contrário) o registro passa para outra regra. Padrão 120. */
  limiteMaiorMin: number;
};

export const JANELA_PADRAO: JanelaDaCasa = { janelaMin: 30, limiteMaiorMin: 120 };

/** Lê a janela de `casa.configuracoes`; valor ausente ou absurdo volta ao padrão. */
export function janelaDaCasa(configuracoes: unknown): JanelaDaCasa {
  const c = (
    typeof configuracoes === "object" && configuracoes !== null ? configuracoes : {}
  ) as Record<string, unknown>;
  const inteiro = (v: unknown, min: number, max: number): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
  const janelaMin = inteiro(c.janelaMinutos, 5, 120) ?? JANELA_PADRAO.janelaMin;
  const limite = inteiro(c.limiteMaiorMinutos, 15, 360) ?? JANELA_PADRAO.limiteMaiorMin;
  return { janelaMin, limiteMaiorMin: Math.max(limite, janelaMin) };
}

export type EstadoDaDose =
  "a_fazer" | "em_janela" | "atrasada" | "sem_registro" | "concluida" | "cancelada";

/** Minutos desde o horário previsto (negativo = ainda não chegou). */
export function minutosDesde(previstaEm: Date, agora: Date): number {
  return Math.floor((agora.getTime() - previstaEm.getTime()) / MIN);
}

export function estadoDaDose(
  d: { previstaEm: Date; cancelada: boolean; registrada: boolean },
  agora: Date,
  janela: JanelaDaCasa,
): EstadoDaDose {
  if (d.cancelada) return "cancelada";
  if (d.registrada) return "concluida";
  const m = minutosDesde(d.previstaEm, agora);
  if (m < -janela.janelaMin) return "a_fazer";
  if (m <= janela.janelaMin) return "em_janela";
  if (m <= janela.limiteMaiorMin) return "atrasada";
  return "sem_registro";
}

export type ClasseDoRegistro =
  /** Dentro da janela: registro normal. */
  | { regra: "normal" }
  /** Fora da janela, mas dentro do limite maior: exige motivo. */
  | { regra: "exige_motivo"; sentido: "atrasado" | "adiantado" }
  /** Atrasada além do limite maior: só como registro tardio, por quem tem permissão. */
  | { regra: "fora_do_limite"; sentido: "atrasado" }
  /** Adiantada além do limite maior: só o enfermeiro libera. */
  | { regra: "bloqueado"; sentido: "adiantado" };

export function classificarRegistro(
  previstaEm: Date,
  agora: Date,
  janela: JanelaDaCasa,
): ClasseDoRegistro {
  const m = minutosDesde(previstaEm, agora);
  if (Math.abs(m) <= janela.janelaMin) return { regra: "normal" };
  if (m > 0) {
    return m <= janela.limiteMaiorMin
      ? { regra: "exige_motivo", sentido: "atrasado" }
      : { regra: "fora_do_limite", sentido: "atrasado" };
  }
  return -m <= janela.limiteMaiorMin
    ? { regra: "exige_motivo", sentido: "adiantado" }
    : { regra: "bloqueado", sentido: "adiantado" };
}

const PRIORIDADE: Record<EstadoDaDose, number> = {
  sem_registro: 0,
  atrasada: 1,
  em_janela: 2,
  a_fazer: 3,
  concluida: 4,
  cancelada: 5,
};

/** Atrasadas no topo (a mais antiga primeiro), depois a janela atual, depois o que vem. */
export function compararParaEscala(
  a: { estado: EstadoDaDose; previstaEm: Date },
  b: { estado: EstadoDaDose; previstaEm: Date },
): number {
  return (
    PRIORIDADE[a.estado] - PRIORIDADE[b.estado] || a.previstaEm.getTime() - b.previstaEm.getTime()
  );
}
