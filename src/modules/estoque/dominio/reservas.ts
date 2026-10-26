import { normalizarDias, type Horario, type UnidadeDeDose } from "@/modules/prescricoes";
import type { Demanda, LoteParaPrever } from "./previsao";

// Agrupa lotes e prescrições em "reservas": cada reserva é um conjunto de lotes que atende um
// conjunto de prescrições, e é a unidade de previsão de término.
//
// Regra do dono do estoque, escolhida para ser simples de explicar à equipe:
//  - se o idoso já teve algum lote individual daquele medicamento (o remédio que a família
//    traz), ele é atendido SÓ pelo estoque individual, e a reserva dele se chama "individual";
//    quando esse estoque acaba, a previsão mostra zero dias (a falta é o que interessa avisar),
//    em vez de passar silenciosamente a gastar o estoque comum;
//  - caso contrário, ele é atendido pelo estoque comum do medicamento, compartilhado entre
//    todos os idosos nessa situação.
// Dentro de cada dono, lotes e prescrições só se encontram se tiverem a mesma unidade: não há
// conversão automática entre, por exemplo, miligramas da receita e comprimidos da caixa.

export type LoteDaReserva = LoteParaPrever & {
  medicamentoId: string;
  idosoId: string | null;
  unidade: UnidadeDeDose;
};

export type PrescricaoParaReserva = {
  id: string;
  idosoId: string;
  medicamentoId: string;
  tipo: "regular" | "sos";
  dose: number;
  unidade: UnidadeDeDose;
  inicio: string;
  fim: string | null;
  sosLimiteDiario: number | null;
  horarios: Horario[];
};

export type Reserva = {
  chave: string;
  dono: "individual" | "comum";
  /** Dono do estoque individual; null no estoque comum. */
  idosoId: string | null;
  medicamentoId: string;
  unidade: UnidadeDeDose;
  lotes: LoteDaReserva[];
  demandas: Demanda[];
  /** Idosos cujas prescrições consomem desta reserva. */
  idososAtendidos: string[];
  /** Há lotes do dono em outra unidade: a previsão não pode comparar e fica indeterminada. */
  lotesEmOutraUnidade: boolean;
};

export function horaEmMinutos(hora: string): number {
  const [h = "0", m = "0"] = hora.split(":");
  return Number(h) * 60 + Number(m);
}

export function demandaDaPrescricao(p: PrescricaoParaReserva): Demanda {
  if (p.tipo === "sos") {
    return {
      tipo: "sos",
      dose: p.dose,
      inicio: p.inicio,
      fim: p.fim,
      limiteDiario: p.sosLimiteDiario ?? 1,
      // O histórico dos últimos 14 dias vem das administrações (M5); até lá, vale o mínimo.
      dosesPorDiaMedia: null,
    };
  }
  return {
    tipo: "regular",
    dose: p.dose,
    inicio: p.inicio,
    fim: p.fim,
    horarios: p.horarios.map((h) => ({
      minutos: horaEmMinutos(h.hora),
      dias: normalizarDias(h.diasSemana),
    })),
  };
}

const chaveDoDono = (medicamentoId: string, idosoId: string | null) =>
  idosoId ? `individual:${idosoId}:${medicamentoId}` : `comum:${medicamentoId}`;

export function montarReservas(
  lotes: LoteDaReserva[],
  prescricoes: PrescricaoParaReserva[],
): Reserva[] {
  const individuais = new Set(
    lotes.filter((l) => l.idosoId).map((l) => `${l.idosoId}|${l.medicamentoId}`),
  );
  const donosComLotes = new Set(lotes.map((l) => chaveDoDono(l.medicamentoId, l.idosoId)));
  const reservas = new Map<string, Reserva>();

  const reservaDe = (
    medicamentoId: string,
    idosoId: string | null,
    unidade: UnidadeDeDose,
  ): Reserva => {
    const dono = chaveDoDono(medicamentoId, idosoId);
    const chave = `${dono}:${unidade}`;
    let r = reservas.get(chave);
    if (!r) {
      r = {
        chave,
        dono: idosoId ? "individual" : "comum",
        idosoId,
        medicamentoId,
        unidade,
        lotes: [],
        demandas: [],
        idososAtendidos: [],
        lotesEmOutraUnidade: false,
      };
      reservas.set(chave, r);
    }
    return r;
  };

  for (const l of lotes) reservaDe(l.medicamentoId, l.idosoId, l.unidade).lotes.push(l);

  for (const p of prescricoes) {
    const doIdoso = individuais.has(`${p.idosoId}|${p.medicamentoId}`);
    const dono = doIdoso ? p.idosoId : null;
    const r = reservaDe(p.medicamentoId, dono, p.unidade);
    r.demandas.push(demandaDaPrescricao(p));
    if (!r.idososAtendidos.includes(p.idosoId)) r.idososAtendidos.push(p.idosoId);
    if (r.lotes.length === 0 && donosComLotes.has(chaveDoDono(p.medicamentoId, dono))) {
      r.lotesEmOutraUnidade = true;
    }
  }
  // Reservas de lotes sem demanda de ninguém: o dono tem só estoque, e isso é informação útil.
  return [...reservas.values()].sort((a, b) => a.chave.localeCompare(b.chave));
}
