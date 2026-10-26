import { diaDaSemanaIso, somarDias } from "@/compartilhado/datas";
import { deMilesimos, emMilesimos } from "./quantidade";
import { loteVencido } from "./validade";

// Previsão de término do estoque (spec 6.3). Função pura: recebe o saldo dos lotes e as demandas
// (prescrições) já preparados e simula, dose a dose, o consumo dos próximos dias.
//
// Por que simular em vez de dividir saldo por consumo diário: a divisão não enxerga que um lote
// vence antes de ser usado, que a prescrição acaba numa data, nem que hoje já passou parte das
// doses. A simulação responde "em que dia falta remédio" respeitando tudo isso.
//
// Regras:
//  - lote vencido (validade anterior a hoje) não conta;
//  - lote que vence durante a simulação deixa de contar a partir do dia seguinte à validade;
//  - consome-se primeiro o que vence primeiro (FEFO), como a equipe deve fazer na prateleira;
//  - prescrição regular consome nos horários dela, entre início e fim; só as doses de hoje que
//    ainda não passaram contam (as anteriores já saíram do saldo pelos movimentos);
//  - prescrição SOS usa a média diária dos últimos 14 dias; sem histórico, assume um mínimo
//    conservador (não zero, para um remédio de uso eventual não parecer "eterno").

export const HORIZONTE_PADRAO_DIAS = 365;
export const SOS_MINIMO_DOSES_POR_DIA = 1;
export const JANELA_DE_CONSUMO_MEDIO_DIAS = 7;
const FIM_DO_DIA_MIN = 24 * 60;

export type DemandaRegular = {
  tipo: "regular";
  dose: number;
  inicio: string;
  fim: string | null;
  /** `minutos` desde a meia-noite (hora local da casa); `dias` no padrão ISO, 1 = segunda. */
  horarios: Array<{ minutos: number; dias: readonly number[] }>;
};

export type DemandaSos = {
  tipo: "sos";
  dose: number;
  inicio: string;
  fim: string | null;
  limiteDiario: number;
  /** Média de doses por dia nos últimos 14 dias; null = sem histórico. */
  dosesPorDiaMedia: number | null;
};

export type Demanda = DemandaRegular | DemandaSos;

export type LoteParaPrever = { id: string; saldo: number; validade: string };

export type EntradaDaPrevisao = {
  /** AAAA-MM-DD na casa. */
  hoje: string;
  /** Minutos desde a meia-noite, no fuso da casa. */
  minutosAgora: number;
  lotes: LoteParaPrever[];
  demandas: Demanda[];
  horizonteDias?: number;
};

export type LoteQueVenceSemUso = { loteId: string; quantidade: number; validade: string };

export type Previsao = {
  /** `sem_consumo`: nenhuma dose prevista; `cobre`: o saldo dura até o fim do período; `acaba`. */
  situacao: "sem_consumo" | "cobre" | "acaba";
  /** Dias de hoje até o primeiro dia sem remédio para a dose (0 = falta hoje). Null se não acaba. */
  diasRestantes: number | null;
  /** Dia da primeira dose que não terá remédio. */
  esgotaEm: string | null;
  /** Saldo dos lotes ainda dentro da validade. */
  saldoDisponivel: number;
  /** Saldo parado em lotes já vencidos: não entra na conta. */
  saldoVencido: number;
  /** Consumo diário previsto, em média, nos próximos 7 dias. */
  consumoDiarioMedio: number;
  /** Lotes que, pelo ritmo previsto, vencem antes de acabar. */
  vencemSemUso: LoteQueVenceSemUso[];
};

type Evento = { minutos: number; milesimos: number };

function dentroDaVigencia(d: { inicio: string; fim: string | null }, data: string): boolean {
  return data >= d.inicio && (d.fim === null || data <= d.fim);
}

/** Doses previstas num dia, em ordem de horário. `aPartirDe` descarta o que já passou hoje. */
function eventosDoDia(demandas: Demanda[], data: string, aPartirDe: number): Evento[] {
  const eventos: Evento[] = [];
  const diaSemana = diaDaSemanaIso(data);
  for (const d of demandas) {
    if (!dentroDaVigencia(d, data)) continue;
    if (d.tipo === "regular") {
      for (const h of d.horarios) {
        if (h.dias.length > 0 && !h.dias.includes(diaSemana)) continue;
        if (h.minutos < aPartirDe) continue;
        eventos.push({ minutos: h.minutos, milesimos: emMilesimos(d.dose) });
      }
    } else {
      const porDia = Math.min(d.dosesPorDiaMedia ?? SOS_MINIMO_DOSES_POR_DIA, d.limiteDiario);
      const milesimos = Math.round(emMilesimos(d.dose) * porDia);
      // O SOS entra no fim do dia (depois das doses regulares) e sempre conta, inclusive hoje.
      if (milesimos > 0) eventos.push({ minutos: FIM_DO_DIA_MIN, milesimos });
    }
  }
  return eventos.sort((a, b) => a.minutos - b.minutos);
}

type Resultado = {
  esgotamento: { indice: number; data: string } | null;
  faltaMilesimos: number;
  temConsumo: boolean;
  vencemSemUso: LoteQueVenceSemUso[];
};

function simular(
  e: EntradaDaPrevisao,
  horizonte: number,
  continuarAposEsgotar: boolean,
): { resultado: Resultado; saldoDisponivel: number; saldoVencido: number } {
  const ativos = e.lotes
    .filter((l) => !loteVencido(l.validade, e.hoje) && emMilesimos(l.saldo) > 0)
    .map((l) => ({ id: l.id, validade: l.validade, resta: emMilesimos(l.saldo) }))
    .sort((a, b) => a.validade.localeCompare(b.validade) || a.id.localeCompare(b.id));
  const saldoVencido = e.lotes
    .filter((l) => loteVencido(l.validade, e.hoje))
    .reduce((t, l) => t + emMilesimos(l.saldo), 0);
  const saldoDisponivel = ativos.reduce((t, l) => t + l.resta, 0);

  const vencemSemUso: LoteQueVenceSemUso[] = [];
  let esgotamento: Resultado["esgotamento"] = null;
  let faltaMilesimos = 0;
  let temConsumo = false;

  for (let dia = 0; dia < horizonte; dia += 1) {
    const data = somarDias(e.hoje, dia);
    // Lotes cuja validade ficou para trás saem da conta; o que sobrou neles foi perda.
    for (let i = ativos.length - 1; i >= 0; i -= 1) {
      const l = ativos[i];
      if (l && l.validade < data) {
        if (l.resta > 0) {
          vencemSemUso.push({
            loteId: l.id,
            quantidade: deMilesimos(l.resta),
            validade: l.validade,
          });
        }
        ativos.splice(i, 1);
      }
    }
    for (const evento of eventosDoDia(e.demandas, data, dia === 0 ? e.minutosAgora : 0)) {
      temConsumo = true;
      let precisa = evento.milesimos;
      const total = ativos.reduce((t, l) => t + l.resta, 0);
      if (total < precisa && esgotamento === null) esgotamento = { indice: dia, data };
      if (total < precisa && !continuarAposEsgotar) {
        return {
          resultado: {
            esgotamento,
            faltaMilesimos: precisa - total,
            temConsumo,
            vencemSemUso: vencemSemUso.sort(porValidade),
          },
          saldoDisponivel: deMilesimos(saldoDisponivel),
          saldoVencido: deMilesimos(saldoVencido),
        };
      }
      for (const l of ativos) {
        if (precisa === 0) break;
        const tira = Math.min(l.resta, precisa);
        l.resta -= tira;
        precisa -= tira;
      }
      faltaMilesimos += precisa;
    }
  }
  return {
    resultado: {
      esgotamento,
      faltaMilesimos,
      temConsumo,
      vencemSemUso: vencemSemUso.sort(porValidade),
    },
    saldoDisponivel: deMilesimos(saldoDisponivel),
    saldoVencido: deMilesimos(saldoVencido),
  };
}

const porValidade = (a: LoteQueVenceSemUso, b: LoteQueVenceSemUso) =>
  a.validade.localeCompare(b.validade) || a.loteId.localeCompare(b.loteId);

/** Consumo diário médio previsto (dias inteiros a partir de hoje, ignorando o saldo). */
export function consumoDiarioMedio(
  demandas: Demanda[],
  hoje: string,
  dias = JANELA_DE_CONSUMO_MEDIO_DIAS,
): number {
  let total = 0;
  for (let i = 0; i < dias; i += 1) {
    for (const ev of eventosDoDia(demandas, somarDias(hoje, i), 0)) total += ev.milesimos;
  }
  return deMilesimos(Math.round(total / dias));
}

export function preverEstoque(e: EntradaDaPrevisao): Previsao {
  const horizonte = e.horizonteDias ?? HORIZONTE_PADRAO_DIAS;
  const { resultado, saldoDisponivel, saldoVencido } = simular(e, horizonte, false);
  const consumo = consumoDiarioMedio(e.demandas, e.hoje);
  const base = {
    saldoDisponivel,
    saldoVencido,
    consumoDiarioMedio: consumo,
    vencemSemUso: resultado.vencemSemUso,
  };
  if (resultado.esgotamento) {
    return {
      ...base,
      situacao: "acaba",
      diasRestantes: resultado.esgotamento.indice,
      esgotaEm: resultado.esgotamento.data,
    };
  }
  return {
    ...base,
    situacao: resultado.temConsumo ? "cobre" : "sem_consumo",
    diasRestantes: null,
    esgotaEm: null,
  };
}

/**
 * Quanto falta comprar para cobrir `coberturaDias` a partir de agora: soma da demanda que o
 * estoque utilizável não alcança (lote que vence antes de ser usado não ajuda). Zero se sobra.
 */
export function faltaParaCobrir(e: EntradaDaPrevisao, coberturaDias: number): number {
  const { resultado } = simular(e, coberturaDias, true);
  return deMilesimos(resultado.faltaMilesimos);
}
