import { describe, expect, it } from "vitest";
import {
  consumoDiarioMedio,
  demandaDaPrescricao,
  faltaParaCobrir,
  montarReservas,
  preverEstoque,
  type Demanda,
  type DemandaRegular,
  type EntradaDaPrevisao,
} from "@/modules/estoque";

// 2026-03-11 é uma quarta-feira.
const HOJE = "2026-03-11";
const TODOS = [1, 2, 3, 4, 5, 6, 7];
const h = (hora: string, dias: number[] = TODOS) => {
  const [hh = "0", mm = "0"] = hora.split(":");
  return { minutos: Number(hh) * 60 + Number(mm), dias };
};
const TRES_POR_DIA = [h("08:00"), h("14:00"), h("20:00")];

const regular = (
  horarios: DemandaRegular["horarios"],
  extra: Partial<DemandaRegular> = {},
): DemandaRegular => ({
  tipo: "regular",
  dose: 1,
  inicio: "2026-01-01",
  fim: null,
  horarios,
  ...extra,
});

function prever(
  lotes: Array<{ id?: string; saldo: number; validade?: string }>,
  demandas: Demanda[],
  extra: Partial<EntradaDaPrevisao> = {},
) {
  return preverEstoque({
    hoje: HOJE,
    minutosAgora: 0,
    lotes: lotes.map((l, i) => ({
      id: l.id ?? `lote-${i}`,
      saldo: l.saldo,
      validade: l.validade ?? "2030-01-01",
    })),
    demandas,
    ...extra,
  });
}

describe("previsão de término: o básico", () => {
  it("saldo 6 e 3 doses por dia duram exatamente 2 dias", () => {
    const p = prever([{ saldo: 6 }], [regular(TRES_POR_DIA)]);
    expect(p.situacao).toBe("acaba");
    expect(p.diasRestantes).toBe(2);
    expect(p.esgotaEm).toBe("2026-03-13");
    expect(p.saldoDisponivel).toBe(6);
    expect(p.consumoDiarioMedio).toBe(3);
  });

  it("uma dose a menos que o ciclo fecha: saldo 5 acaba no dia 1, na terceira dose", () => {
    const p = prever([{ saldo: 5 }], [regular(TRES_POR_DIA)]);
    expect(p.diasRestantes).toBe(1);
    expect(p.esgotaEm).toBe("2026-03-12");
  });

  it("sem saldo, falta já na primeira dose que ainda vai acontecer hoje", () => {
    const p = prever([], [regular(TRES_POR_DIA)]);
    expect(p.situacao).toBe("acaba");
    expect(p.diasRestantes).toBe(0);
    expect(p.esgotaEm).toBe(HOJE);
  });

  it("doses de hoje que já passaram não contam; as de agora em diante, sim", () => {
    // 15:00: resta só a das 20:00. Saldo 6 = 1 (hoje) + 3 (amanhã) + 2 → falta no dia 2, às 20:00.
    const p = prever([{ saldo: 6 }], [regular(TRES_POR_DIA)], { minutosAgora: 15 * 60 });
    expect(p.diasRestantes).toBe(2);
    // Passou da última dose: sem saldo, a falta é amanhã de manhã.
    const q = prever([], [regular(TRES_POR_DIA)], { minutosAgora: 21 * 60 });
    expect(q.diasRestantes).toBe(1);
    expect(q.esgotaEm).toBe("2026-03-12");
  });

  it("a dose exatamente no minuto atual ainda conta", () => {
    const p = prever([{ saldo: 2 }], [regular(TRES_POR_DIA)], { minutosAgora: 8 * 60 });
    // 08:00, 14:00 hoje (2); 20:00 falta no dia 0.
    expect(p.diasRestantes).toBe(0);
    const q = prever([{ saldo: 2 }], [regular(TRES_POR_DIA)], { minutosAgora: 8 * 60 + 1 });
    // 14:00, 20:00 hoje (2); amanhã 08:00 falta.
    expect(q.diasRestantes).toBe(1);
  });

  it("sem nenhuma dose prevista, a situação é sem_consumo", () => {
    const p = prever([{ saldo: 10 }], []);
    expect(p.situacao).toBe("sem_consumo");
    expect(p.diasRestantes).toBeNull();
    expect(p.esgotaEm).toBeNull();
    expect(p.consumoDiarioMedio).toBe(0);
    expect(prever([], []).situacao).toBe("sem_consumo");
  });

  it("estoque de sobra para o horizonte inteiro é cobre, sem data de término", () => {
    const p = prever([{ saldo: 100000 }], [regular(TRES_POR_DIA)]);
    expect(p.situacao).toBe("cobre");
    expect(p.diasRestantes).toBeNull();
    expect(prever([{ saldo: 10 }], [regular(TRES_POR_DIA)], { horizonteDias: 3 }).situacao).toBe(
      "cobre",
    );
    expect(prever([{ saldo: 8 }], [regular(TRES_POR_DIA)], { horizonteDias: 3 }).situacao).toBe(
      "acaba",
    );
  });
});

describe("previsão: prescrições com início, fim e dias da semana", () => {
  it("o fim da prescrição limita a conta: o saldo cobre o tratamento inteiro", () => {
    // Uma dose por dia de hoje até hoje+3 = 4 doses.
    const demanda = regular([h("08:00")], { fim: "2026-03-14" });
    expect(prever([{ saldo: 4 }], [demanda]).situacao).toBe("cobre");
    const curto = prever([{ saldo: 3 }], [demanda]);
    expect(curto.situacao).toBe("acaba");
    expect(curto.esgotaEm).toBe("2026-03-14");
    expect(curto.diasRestantes).toBe(3);
  });

  it("prescrição que ainda não começou só consome a partir do início", () => {
    const demanda = regular([h("08:00")], { inicio: "2026-03-16" });
    const p = prever([], [demanda]);
    expect(p.diasRestantes).toBe(5);
    expect(p.esgotaEm).toBe("2026-03-16");
  });

  it("prescrição já encerrada no passado não consome nada", () => {
    const demanda = regular([h("08:00")], { inicio: "2026-01-01", fim: "2026-03-01" });
    expect(prever([], [demanda]).situacao).toBe("sem_consumo");
  });

  it("dose semanal só consome no dia dela (segunda = 1)", () => {
    const segunda = regular([h("09:00", [1])]);
    // Quarta 11/03; segundas: 16/03 e 23/03. Saldo 1 cobre a primeira e falta na segunda.
    const p = prever([{ saldo: 1 }], [segunda]);
    expect(p.esgotaEm).toBe("2026-03-23");
    expect(p.diasRestantes).toBe(12);
    expect(consumoDiarioMedio([segunda], HOJE)).toBe(0.143);
  });

  it("dias da semana vazios valem todos os dias", () => {
    const todos = regular([h("08:00", [])]);
    expect(prever([{ saldo: 2 }], [todos]).diasRestantes).toBe(2);
  });

  it("duas prescrições do mesmo remédio somam o consumo", () => {
    const a = regular([h("08:00")]);
    const b = regular([h("08:00"), h("20:00")]);
    const p = prever([{ saldo: 9 }], [a, b]);
    expect(p.consumoDiarioMedio).toBe(3);
    expect(p.diasRestantes).toBe(3);
  });
});

describe("previsão: frações sem erro de ponto flutuante", () => {
  it("meio comprimido: 1,25 dura 2 dias e falta no terceiro", () => {
    const p = prever([{ saldo: 1.25 }], [regular([h("08:00")], { dose: 0.5 })]);
    expect(p.diasRestantes).toBe(2);
  });

  it("três doses de 0,1 gastam exatamente 0,3", () => {
    const p = prever([{ saldo: 0.3 }], [regular(TRES_POR_DIA, { dose: 0.1 })]);
    expect(p.diasRestantes).toBe(1);
    expect(p.consumoDiarioMedio).toBe(0.3);
  });
});

describe("previsão: validade dos lotes", () => {
  it("lote vencido não conta, e o saldo parado nele é informado", () => {
    const p = prever(
      [
        { id: "velho", saldo: 5, validade: "2026-03-10" },
        { id: "bom", saldo: 3, validade: "2030-01-01" },
      ],
      [regular(TRES_POR_DIA)],
    );
    expect(p.saldoDisponivel).toBe(3);
    expect(p.saldoVencido).toBe(5);
    expect(p.diasRestantes).toBe(1);
  });

  it("a validade de hoje ainda vale hoje, e amanhã o lote sai da conta", () => {
    const p = prever([{ id: "A", saldo: 10, validade: HOJE }], [regular(TRES_POR_DIA)]);
    expect(p.saldoDisponivel).toBe(10);
    // Consome 3 hoje; amanhã já está vencido, sobram 7 que não servem.
    expect(p.diasRestantes).toBe(1);
    expect(p.vencemSemUso).toEqual([{ loteId: "A", quantidade: 7, validade: HOJE }]);
  });

  it("consome primeiro o que vence primeiro e aponta o que vence sem uso", () => {
    const p = prever(
      [
        { id: "B", saldo: 10, validade: "2026-04-10" },
        { id: "A", saldo: 10, validade: "2026-03-12" },
      ],
      [regular(TRES_POR_DIA)],
    );
    // A (vence amanhã): hoje 3 → 7, amanhã 3 → 4, depois sai com 4 sobrando.
    expect(p.vencemSemUso).toEqual([{ loteId: "A", quantidade: 4, validade: "2026-03-12" }]);
    // B sozinho a partir do dia 2: 10 doses = dias 2, 3, 4 (9) + 1 no dia 5 → falta no dia 5.
    expect(p.diasRestantes).toBe(5);
    expect(p.esgotaEm).toBe("2026-03-16");
  });

  it("lote de saldo zero e lote vencido de saldo zero não atrapalham", () => {
    const p = prever(
      [{ saldo: 0, validade: "2030-01-01" }, { saldo: 0, validade: "2020-01-01" }, { saldo: 3 }],
      [regular(TRES_POR_DIA)],
    );
    expect(p.saldoVencido).toBe(0);
    expect(p.diasRestantes).toBe(1);
  });

  it("sem consumo, o que vence dentro do horizonte aparece como vencendo sem uso", () => {
    const p = prever([{ id: "Z", saldo: 5, validade: "2026-03-20" }], []);
    expect(p.situacao).toBe("sem_consumo");
    expect(p.vencemSemUso).toEqual([{ loteId: "Z", quantidade: 5, validade: "2026-03-20" }]);
  });
});

describe("previsão: remédio SOS", () => {
  const sos = (extra: { dosesPorDiaMedia: number | null; limiteDiario?: number }): Demanda => ({
    tipo: "sos",
    dose: 1,
    inicio: "2026-01-01",
    fim: null,
    limiteDiario: extra.limiteDiario ?? 4,
    dosesPorDiaMedia: extra.dosesPorDiaMedia,
  });

  it("sem histórico, assume o mínimo conservador de uma dose por dia", () => {
    const p = prever([{ saldo: 3 }], [sos({ dosesPorDiaMedia: null })]);
    expect(p.diasRestantes).toBe(3);
    expect(p.consumoDiarioMedio).toBe(1);
  });

  it("com histórico, usa a média diária dos últimos 14 dias", () => {
    const p = prever([{ saldo: 3 }], [sos({ dosesPorDiaMedia: 2 })]);
    expect(p.diasRestantes).toBe(1);
    expect(prever([{ saldo: 1 }], [sos({ dosesPorDiaMedia: 0.5 })]).diasRestantes).toBe(2);
  });

  it("a média nunca passa do limite diário da prescrição", () => {
    const p = prever([{ saldo: 8 }], [sos({ dosesPorDiaMedia: 10, limiteDiario: 4 })]);
    expect(p.diasRestantes).toBe(2);
  });

  it("média zero é histórico real de não uso: sem consumo previsto", () => {
    const p = prever([{ saldo: 3 }], [sos({ dosesPorDiaMedia: 0 })]);
    expect(p.situacao).toBe("sem_consumo");
  });

  it("SOS convive com a prescrição regular do mesmo remédio", () => {
    const p = prever(
      [{ saldo: 8 }],
      [regular([h("08:00"), h("20:00")]), sos({ dosesPorDiaMedia: null })],
    );
    expect(p.consumoDiarioMedio).toBe(3);
    expect(p.diasRestantes).toBe(2); // 8 = 3 + 3 + 2 → falta na 3ª dose do dia 2
  });
});

describe("falta para cobrir um período (lista de reposição)", () => {
  const entrada = (lotes: EntradaDaPrevisao["lotes"]): EntradaDaPrevisao => ({
    hoje: HOJE,
    minutosAgora: 0,
    lotes,
    demandas: [regular(TRES_POR_DIA)],
  });

  it("é a demanda do período menos o que o estoque alcança", () => {
    expect(faltaParaCobrir(entrada([{ id: "a", saldo: 20, validade: "2030-01-01" }]), 30)).toBe(70);
    expect(faltaParaCobrir(entrada([]), 30)).toBe(90);
  });

  it("é zero quando o estoque cobre o período", () => {
    expect(faltaParaCobrir(entrada([{ id: "a", saldo: 90, validade: "2030-01-01" }]), 30)).toBe(0);
    expect(faltaParaCobrir(entrada([{ id: "a", saldo: 500, validade: "2030-01-01" }]), 30)).toBe(0);
  });

  it("lote que vence antes de ser usado não ajuda a cobrir", () => {
    // Vence em 15/03 (dias 0 a 4 = 15 doses); dos 20, 5 não servem. Falta 90 - 15 = 75.
    expect(faltaParaCobrir(entrada([{ id: "a", saldo: 20, validade: "2026-03-15" }]), 30)).toBe(75);
  });

  it("estoque parcial entra na conta, sem exigir dose inteira", () => {
    // 90 doses de 1; saldo 0,5 ajuda com meia dose: falta 89,5.
    expect(faltaParaCobrir(entrada([{ id: "a", saldo: 0.5, validade: "2030-01-01" }]), 30)).toBe(
      89.5,
    );
  });
});

describe("consumo diário médio", () => {
  it("é a média dos próximos 7 dias, ignorando início futuro e fim passado", () => {
    expect(consumoDiarioMedio([regular(TRES_POR_DIA)], HOJE)).toBe(3);
    expect(consumoDiarioMedio([regular(TRES_POR_DIA, { fim: "2026-03-01" })], HOJE)).toBe(0);
    // Começa daqui a 3 dias: 4 dos 7 dias consomem 3 doses → 12/7.
    expect(consumoDiarioMedio([regular(TRES_POR_DIA, { inicio: "2026-03-14" })], HOJE)).toBe(1.714);
  });
});

describe("reservas: quem consome de qual estoque", () => {
  const lote = (
    id: string,
    extra: Partial<Parameters<typeof montarReservas>[0][number]> = {},
  ): Parameters<typeof montarReservas>[0][number] => ({
    id,
    medicamentoId: "med",
    idosoId: null,
    unidade: "comprimido",
    saldo: 10,
    validade: "2030-01-01",
    ...extra,
  });
  const presc = (
    id: string,
    idosoId: string,
    extra: Partial<Parameters<typeof montarReservas>[1][number]> = {},
  ): Parameters<typeof montarReservas>[1][number] => ({
    id,
    idosoId,
    medicamentoId: "med",
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    inicio: "2026-01-01",
    fim: null,
    sosLimiteDiario: null,
    horarios: [{ hora: "08:00" }],
    ...extra,
  });

  it("idosos sem estoque individual dividem o estoque comum", () => {
    const r = montarReservas([lote("c1"), lote("c2")], [presc("p1", "ana"), presc("p2", "bia")]);
    expect(r).toHaveLength(1);
    expect(r[0]?.dono).toBe("comum");
    expect(r[0]?.lotes.map((l) => l.id)).toEqual(["c1", "c2"]);
    expect(r[0]?.idososAtendidos.sort()).toEqual(["ana", "bia"]);
    expect(r[0]?.demandas).toHaveLength(2);
  });

  it("quem tem lote individual do remédio é atendido só por ele, mesmo havendo estoque comum", () => {
    const r = montarReservas(
      [lote("c1"), lote("i1", { idosoId: "ana" })],
      [presc("p1", "ana"), presc("p2", "bia")],
    );
    const ana = r.find((x) => x.dono === "individual");
    const comum = r.find((x) => x.dono === "comum");
    expect(ana?.idosoId).toBe("ana");
    expect(ana?.idososAtendidos).toEqual(["ana"]);
    expect(comum?.idososAtendidos).toEqual(["bia"]);
  });

  it("estoque individual esgotado continua individual (a falta aparece, não some)", () => {
    const r = montarReservas(
      [lote("c1"), lote("i1", { idosoId: "ana", saldo: 0 })],
      [presc("p1", "ana")],
    );
    const ana = r.find((x) => x.idososAtendidos.includes("ana"));
    expect(ana?.dono).toBe("individual");
    expect(preverEstoque({ hoje: HOJE, minutosAgora: 0, ...ana! }).diasRestantes).toBe(0);
  });

  it("o estoque individual de um idoso não atende outro idoso", () => {
    const r = montarReservas([lote("i1", { idosoId: "ana" })], [presc("p1", "bia")]);
    const bia = r.find((x) => x.idososAtendidos.includes("bia"));
    expect(bia?.dono).toBe("comum");
    expect(bia?.lotes).toHaveLength(0);
  });

  it("receita numa unidade e estoque em outra: reserva marcada, sem conversão automática", () => {
    const r = montarReservas([lote("c1")], [presc("p1", "ana", { unidade: "mg", dose: 500 })]);
    const mg = r.find((x) => x.unidade === "mg");
    expect(mg?.lotesEmOutraUnidade).toBe(true);
    expect(mg?.lotes).toHaveLength(0);
    expect(r.find((x) => x.unidade === "comprimido")?.lotesEmOutraUnidade).toBe(false);
  });

  it("prescrição sem nenhum lote cadastrado vira reserva vazia, que acaba hoje", () => {
    const r = montarReservas([], [presc("p1", "ana")]);
    expect(r).toHaveLength(1);
    expect(r[0]?.lotesEmOutraUnidade).toBe(false);
    expect(r[0]?.lotes).toEqual([]);
    expect(preverEstoque({ hoje: HOJE, minutosAgora: 0, ...r[0]! }).diasRestantes).toBe(0);
  });

  it("medicamentos diferentes nunca se misturam", () => {
    const r = montarReservas(
      [lote("c1"), lote("c2", { medicamentoId: "outro" })],
      [presc("p1", "ana")],
    );
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.medicamentoId === "outro")?.demandas).toHaveLength(0);
  });
});

describe("demanda a partir da prescrição", () => {
  it("regular: hora vira minutos e dias vazios viram todos os dias", () => {
    const d = demandaDaPrescricao({
      id: "p",
      idosoId: "i",
      medicamentoId: "m",
      tipo: "regular",
      dose: 0.5,
      unidade: "comprimido",
      inicio: "2026-01-01",
      fim: "2026-02-01",
      sosLimiteDiario: null,
      horarios: [{ hora: "08:30" }, { hora: "22:00", diasSemana: [1, 3] }],
    });
    expect(d).toEqual({
      tipo: "regular",
      dose: 0.5,
      inicio: "2026-01-01",
      fim: "2026-02-01",
      horarios: [
        { minutos: 510, dias: [1, 2, 3, 4, 5, 6, 7] },
        { minutos: 1320, dias: [1, 3] },
      ],
    });
  });

  it("SOS: guarda o limite diário e ainda não tem histórico", () => {
    const d = demandaDaPrescricao({
      id: "p",
      idosoId: "i",
      medicamentoId: "m",
      tipo: "sos",
      dose: 1,
      unidade: "comprimido",
      inicio: "2026-01-01",
      fim: null,
      sosLimiteDiario: 3,
      horarios: [],
    });
    expect(d).toMatchObject({ tipo: "sos", limiteDiario: 3, dosesPorDiaMedia: null });
  });
});
