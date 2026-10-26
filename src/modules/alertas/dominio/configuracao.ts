// Limites e prazos dos alertas (spec 6.4), por casa, em `casa.configuracoes.alertas`. Valor
// ausente ou fora da faixa volta ao padrão da spec: configuração estragada nunca silencia alerta.

export type ConfiguracaoDeAlertas = {
  /** Estoque: aviso com N dias ou menos (ou o prazo de reposição, se maior); urgente com M. */
  estoqueAvisoDias: number;
  estoqueUrgenteDias: number;
  /** Quanto o fornecedor leva para entregar. O aviso de estoque nunca vem depois disso. */
  prazoReposicaoDias: number;
  validadeAvisoDias: number;
  validadeUrgenteDias: number;
  /** Prescrição com fim marcado: aviso N dias antes; urgente no próprio dia. */
  prescricaoAvisoDias: number;
  /** Urgente não lido em N horas vai para o gestor. */
  escalonamentoHoras: number;
  /** Reaviso por e-mail de alerta aberto e não lido. */
  reavisoUrgenteHoras: number;
  reavisoAvisoHoras: number;
  /** Fim dos plantões (HH:MM, fuso da casa): dose ainda sem registro no fim do plantão vai ao gestor. */
  fimDosPlantoes: string[];
  /** Exceções de conferência do mesmo usuário em 7 dias que viram alerta urgente. */
  excecoesRepetidas: number;
  /** E-mail também para avisos (padrão: só urgentes, para não virar ruído). */
  emailParaAvisos: boolean;
};

export const CONFIGURACAO_PADRAO: ConfiguracaoDeAlertas = {
  estoqueAvisoDias: 7,
  estoqueUrgenteDias: 3,
  prazoReposicaoDias: 7,
  validadeAvisoDias: 30,
  validadeUrgenteDias: 7,
  prescricaoAvisoDias: 5,
  escalonamentoHoras: 2,
  reavisoUrgenteHoras: 4,
  reavisoAvisoHoras: 24,
  fimDosPlantoes: ["07:00", "19:00"],
  excecoesRepetidas: 3,
  emailParaAvisos: false,
};

type Faixa = { min: number; max: number };
export const FAIXAS: Record<
  Exclude<keyof ConfiguracaoDeAlertas, "fimDosPlantoes" | "emailParaAvisos">,
  Faixa
> = {
  estoqueAvisoDias: { min: 1, max: 60 },
  estoqueUrgenteDias: { min: 0, max: 30 },
  prazoReposicaoDias: { min: 0, max: 60 },
  validadeAvisoDias: { min: 1, max: 180 },
  validadeUrgenteDias: { min: 0, max: 60 },
  prescricaoAvisoDias: { min: 1, max: 30 },
  escalonamentoHoras: { min: 1, max: 24 },
  reavisoUrgenteHoras: { min: 1, max: 24 },
  reavisoAvisoHoras: { min: 4, max: 168 },
  excecoesRepetidas: { min: 2, max: 20 },
};

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export function horasValidas(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= 6 &&
    v.every((h) => typeof h === "string" && HORA.test(h)) &&
    new Set(v).size === v.length
  );
}

/** Lê `configuracoes.alertas`; cada campo inválido volta ao padrão, e os pares ficam coerentes. */
export function configuracaoDeAlertas(configuracoes: unknown): ConfiguracaoDeAlertas {
  const raiz = (
    typeof configuracoes === "object" && configuracoes !== null ? configuracoes : {}
  ) as Record<string, unknown>;
  const c = (
    typeof raiz.alertas === "object" && raiz.alertas !== null ? raiz.alertas : {}
  ) as Record<string, unknown>;
  const r: ConfiguracaoDeAlertas = { ...CONFIGURACAO_PADRAO };
  for (const [campo, faixa] of Object.entries(FAIXAS) as Array<[keyof typeof FAIXAS, Faixa]>) {
    const v = c[campo];
    if (typeof v === "number" && Number.isInteger(v) && v >= faixa.min && v <= faixa.max)
      r[campo] = v;
  }
  if (horasValidas(c.fimDosPlantoes)) r.fimDosPlantoes = [...c.fimDosPlantoes].sort();
  if (typeof c.emailParaAvisos === "boolean") r.emailParaAvisos = c.emailParaAvisos;
  // Urgente nunca depois do aviso.
  r.estoqueUrgenteDias = Math.min(r.estoqueUrgenteDias, r.estoqueAvisoDias);
  r.validadeUrgenteDias = Math.min(r.validadeUrgenteDias, r.validadeAvisoDias);
  return r;
}

/** Problemas de uma configuração enviada pelo gestor (para recusar com mensagem clara). */
export function problemasDaConfiguracao(c: Partial<Record<string, unknown>>): string[] {
  const problemas: string[] = [];
  for (const [campo, faixa] of Object.entries(FAIXAS)) {
    const v = c[campo];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < faixa.min || v > faixa.max) {
      problemas.push(`${campo}: use um número inteiro de ${faixa.min} a ${faixa.max}.`);
    }
  }
  if (c.fimDosPlantoes !== undefined && !horasValidas(c.fimDosPlantoes)) {
    problemas.push("fimDosPlantoes: de 1 a 6 horários HH:MM diferentes.");
  }
  if (c.emailParaAvisos !== undefined && typeof c.emailParaAvisos !== "boolean") {
    problemas.push("emailParaAvisos: sim ou não.");
  }
  return problemas;
}
