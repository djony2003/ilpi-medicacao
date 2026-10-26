import { describe, expect, it } from "vitest";
import {
  JANELA_PADRAO,
  classificarRegistro,
  compararParaEscala,
  dataLocalDe,
  dosesDoPeriodo,
  estadoDaDose,
  fusoValido,
  instanteLocal,
  janelaDaCasa,
  type PrescricaoParaGerar,
} from "@/modules/administracao";

const iso = (d: Date) => d.toISOString();

describe("instanteLocal: hora de parede → instante, com horário de verão", () => {
  it("dia comum em São Paulo (UTC-3) e em fusos com deslocamento quebrado", () => {
    expect(iso(instanteLocal("2026-03-10", "08:00", "America/Sao_Paulo"))).toBe(
      "2026-03-10T11:00:00.000Z",
    );
    expect(iso(instanteLocal("2026-03-10", "00:00", "America/Sao_Paulo"))).toBe(
      "2026-03-10T03:00:00.000Z",
    );
    expect(iso(instanteLocal("2026-03-10", "23:59", "America/Sao_Paulo"))).toBe(
      "2026-03-11T02:59:00.000Z",
    );
    expect(iso(instanteLocal("2026-03-10", "08:00", "Asia/Kolkata"))).toBe(
      "2026-03-10T02:30:00.000Z",
    );
    expect(iso(instanteLocal("2026-03-10", "08:00", "UTC"))).toBe("2026-03-10T08:00:00.000Z");
  });

  it("hora que não existe (relógio adianta) sai no instante da mudança", () => {
    // Nova York, 8/3/2026: 02:00 vira 03:00.
    expect(iso(instanteLocal("2026-03-08", "01:30", "America/New_York"))).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(iso(instanteLocal("2026-03-08", "02:30", "America/New_York"))).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(iso(instanteLocal("2026-03-08", "02:00", "America/New_York"))).toBe(
      "2026-03-08T07:00:00.000Z",
    ); // 03:00 EDT
    expect(iso(instanteLocal("2026-03-08", "03:00", "America/New_York"))).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    // São Paulo em 2018 (último ano com horário de verão): 04/11 00:00 virou 01:00.
    expect(iso(instanteLocal("2018-11-04", "00:30", "America/Sao_Paulo"))).toBe(
      "2018-11-04T03:00:00.000Z",
    );
    expect(iso(instanteLocal("2018-11-03", "23:30", "America/Sao_Paulo"))).toBe(
      "2018-11-04T02:30:00.000Z",
    );
  });

  it("hora que existe duas vezes (relógio atrasa) vale a primeira ocorrência", () => {
    // Nova York, 1/11/2026: 02:00 EDT volta para 01:00 EST.
    expect(iso(instanteLocal("2026-11-01", "00:30", "America/New_York"))).toBe(
      "2026-11-01T04:30:00.000Z",
    );
    expect(iso(instanteLocal("2026-11-01", "01:30", "America/New_York"))).toBe(
      "2026-11-01T05:30:00.000Z",
    ); // EDT, a primeira
    expect(iso(instanteLocal("2026-11-01", "02:00", "America/New_York"))).toBe(
      "2026-11-01T07:00:00.000Z",
    );
    // São Paulo em 2019: 17/02 00:00 BRST voltou para 16/02 23:00 BRT.
    expect(iso(instanteLocal("2019-02-16", "23:30", "America/Sao_Paulo"))).toBe(
      "2019-02-17T01:30:00.000Z",
    ); // BRST, a primeira
    expect(iso(instanteLocal("2019-02-17", "00:30", "America/Sao_Paulo"))).toBe(
      "2019-02-17T03:30:00.000Z",
    );
  });

  it("mudança de meia hora (Lord Howe) também funciona", () => {
    // 4/10/2026: 02:00 (+10:30) vira 02:30 (+11:00).
    expect(iso(instanteLocal("2026-10-04", "01:45", "Australia/Lord_Howe"))).toBe(
      "2026-10-03T15:15:00.000Z",
    );
    expect(iso(instanteLocal("2026-10-04", "02:15", "Australia/Lord_Howe"))).toBe(
      "2026-10-03T15:30:00.000Z",
    );
    expect(iso(instanteLocal("2026-10-04", "02:30", "Australia/Lord_Howe"))).toBe(
      "2026-10-03T15:30:00.000Z",
    );
  });

  it(
    "para todo dia de 2026, em vários fusos, o resultado é consistente e crescente",
    { timeout: 60_000 },
    () => {
      const fusos = [
        "America/Sao_Paulo",
        "America/New_York",
        "Australia/Lord_Howe",
        "America/Santiago",
      ];
      for (const fuso of fusos) {
        let anterior = Number.NEGATIVE_INFINITY;
        for (let dia = 0; dia < 366; dia += 1) {
          const data = new Date(Date.UTC(2026, 0, 1 + dia)).toISOString().slice(0, 10);
          for (let min = 0; min < 24 * 60; min += 90) {
            const hora = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
            const t = instanteLocal(data, hora, fuso).getTime();
            // Nunca volta no tempo (a hora de parede é crescente, e a ambígua escolhe a primeira).
            expect(t, `${fuso} ${data} ${hora}`).toBeGreaterThanOrEqual(anterior);
            anterior = t;
            // A volta ao relógio devolve a mesma hora, ou uma posterior (se a hora não existia).
            const volta = new Intl.DateTimeFormat("en-CA", {
              timeZone: fuso,
              hourCycle: "h23",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
              .format(new Date(t))
              .replace(",", "");
            expect(volta >= `${data} ${hora}`, `${fuso} ${data} ${hora} → ${volta}`).toBe(true);
          }
        }
      }
    },
  );

  it("data local no fuso: 01h UTC ainda é o dia anterior em São Paulo", () => {
    expect(dataLocalDe(new Date("2026-03-11T01:00:00Z"), "America/Sao_Paulo")).toBe("2026-03-10");
    expect(dataLocalDe(new Date("2026-03-11T03:00:00Z"), "America/Sao_Paulo")).toBe("2026-03-11");
    expect(dataLocalDe(new Date("2026-03-11T23:30:00Z"), "Asia/Kolkata")).toBe("2026-03-12");
  });

  it("valida nome de fuso", () => {
    expect(fusoValido("America/Sao_Paulo")).toBe(true);
    expect(fusoValido("Marte/Olympus")).toBe(false);
    expect(fusoValido("")).toBe(false);
  });
});

describe("geração das doses de uma prescrição", () => {
  const base: PrescricaoParaGerar = {
    id: "p1",
    inicio: "2026-03-01",
    fim: null,
    criadaEm: new Date("2026-03-01T00:00:00Z"),
    horarios: [{ hora: "08:00" }, { hora: "20:00" }],
  };
  const SP = "America/Sao_Paulo";
  const resumo = (ds: ReturnType<typeof dosesDoPeriodo>) =>
    ds.map((d) => `${d.dataLocal} ${d.horaLocal}`);

  it("gera cada horário de cada dia do período", () => {
    const ds = dosesDoPeriodo(base, "2026-03-10", "2026-03-12", SP);
    expect(resumo(ds)).toEqual([
      "2026-03-10 08:00",
      "2026-03-10 20:00",
      "2026-03-11 08:00",
      "2026-03-11 20:00",
      "2026-03-12 08:00",
      "2026-03-12 20:00",
    ]);
    expect(iso(ds[0]?.previstaEm ?? new Date(0))).toBe("2026-03-10T11:00:00.000Z");
  });

  it("respeita início e fim (inclusivos) e período vazio", () => {
    const p = { ...base, inicio: "2026-03-11", fim: "2026-03-12" };
    expect(
      resumo(dosesDoPeriodo(p, "2026-03-09", "2026-03-14", SP)).map((s) => s.slice(0, 10)),
    ).toEqual(["2026-03-11", "2026-03-11", "2026-03-12", "2026-03-12"]);
    expect(dosesDoPeriodo(p, "2026-03-13", "2026-03-20", SP)).toEqual([]);
    expect(dosesDoPeriodo(p, "2026-03-05", "2026-03-10", SP)).toEqual([]);
    expect(dosesDoPeriodo(base, "2026-03-12", "2026-03-10", SP)).toEqual([]);
  });

  it("respeita os dias da semana de cada horário", () => {
    const p = { ...base, horarios: [{ hora: "08:00", diasSemana: [1, 3] }, { hora: "20:00" }] };
    // 9/3 é segunda, 10/3 terça, 11/3 quarta.
    expect(resumo(dosesDoPeriodo(p, "2026-03-09", "2026-03-11", SP))).toEqual([
      "2026-03-09 08:00",
      "2026-03-09 20:00",
      "2026-03-10 20:00",
      "2026-03-11 08:00",
      "2026-03-11 20:00",
    ]);
  });

  it("não gera dose de antes da criação da versão (sem dose fantasma)", () => {
    const p = { ...base, criadaEm: new Date("2026-03-10T12:00:00Z") }; // 09:00 em São Paulo
    expect(resumo(dosesDoPeriodo(p, "2026-03-10", "2026-03-10", SP))).toEqual(["2026-03-10 20:00"]);
    // Criada exatamente no horário da dose: ainda vale.
    expect(
      resumo(
        dosesDoPeriodo(
          { ...base, criadaEm: new Date("2026-03-10T11:00:00Z") },
          "2026-03-10",
          "2026-03-10",
          SP,
        ),
      ),
    ).toEqual(["2026-03-10 08:00", "2026-03-10 20:00"]);
  });

  it("no dia em que o relógio atrasa, uma dose por horário (não duplica)", () => {
    const p: PrescricaoParaGerar = {
      ...base,
      inicio: "2026-11-01",
      criadaEm: new Date("2026-10-01T00:00:00Z"),
      horarios: [{ hora: "01:30" }, { hora: "09:00" }],
    };
    const ds = dosesDoPeriodo(p, "2026-11-01", "2026-11-01", "America/New_York");
    expect(ds).toHaveLength(2);
    expect(new Set(ds.map((d) => d.previstaEm.getTime())).size).toBe(2);
  });

  it("no dia em que o relógio adianta, a dose da hora inexistente sai no instante da mudança", () => {
    const p: PrescricaoParaGerar = {
      ...base,
      inicio: "2026-03-08",
      criadaEm: new Date("2026-02-01T00:00:00Z"),
      horarios: [{ hora: "02:30" }],
    };
    const [d] = dosesDoPeriodo(p, "2026-03-08", "2026-03-08", "America/New_York");
    expect(d && iso(d.previstaEm)).toBe("2026-03-08T07:00:00.000Z");
    expect(d?.horaLocal).toBe("02:30"); // a hora prescrita continua registrada como foi escrita
  });

  it("recusa período gigante", () => {
    expect(() => dosesDoPeriodo(base, "2026-01-01", "2026-12-31", SP)).toThrow(/grande demais/);
  });
});

describe("estado da dose e regras de horário", () => {
  const prevista = new Date("2026-03-10T11:00:00Z"); // 08:00 em São Paulo
  const em = (min: number) => new Date(prevista.getTime() + min * 60_000);
  const dose = { previstaEm: prevista, cancelada: false, registrada: false };

  it("percorre os estados na janela padrão (30 min, limite de 2 h)", () => {
    const j = JANELA_PADRAO;
    expect(estadoDaDose(dose, em(-120), j)).toBe("a_fazer");
    expect(estadoDaDose(dose, em(-31), j)).toBe("a_fazer");
    expect(estadoDaDose(dose, em(-30), j)).toBe("em_janela");
    expect(estadoDaDose(dose, em(0), j)).toBe("em_janela");
    expect(estadoDaDose(dose, em(30), j)).toBe("em_janela");
    expect(estadoDaDose(dose, em(31), j)).toBe("atrasada");
    expect(estadoDaDose(dose, em(120), j)).toBe("atrasada");
    expect(estadoDaDose(dose, em(121), j)).toBe("sem_registro");
    expect(estadoDaDose(dose, em(600), j)).toBe("sem_registro");
  });

  it("cancelada e concluída mandam sobre o horário", () => {
    expect(estadoDaDose({ ...dose, cancelada: true }, em(500), JANELA_PADRAO)).toBe("cancelada");
    expect(estadoDaDose({ ...dose, registrada: true }, em(500), JANELA_PADRAO)).toBe("concluida");
    expect(estadoDaDose({ ...dose, registrada: true, cancelada: true }, em(0), JANELA_PADRAO)).toBe(
      "cancelada",
    );
  });

  it("classifica o registro: normal, com motivo, fora do limite, bloqueado", () => {
    const j = JANELA_PADRAO;
    expect(classificarRegistro(prevista, em(-30), j)).toEqual({ regra: "normal" });
    expect(classificarRegistro(prevista, em(30), j)).toEqual({ regra: "normal" });
    expect(classificarRegistro(prevista, em(31), j)).toEqual({
      regra: "exige_motivo",
      sentido: "atrasado",
    });
    expect(classificarRegistro(prevista, em(120), j)).toEqual({
      regra: "exige_motivo",
      sentido: "atrasado",
    });
    expect(classificarRegistro(prevista, em(121), j)).toEqual({
      regra: "fora_do_limite",
      sentido: "atrasado",
    });
    expect(classificarRegistro(prevista, em(-31), j)).toEqual({
      regra: "exige_motivo",
      sentido: "adiantado",
    });
    expect(classificarRegistro(prevista, em(-120), j)).toEqual({
      regra: "exige_motivo",
      sentido: "adiantado",
    });
    expect(classificarRegistro(prevista, em(-121), j)).toEqual({
      regra: "bloqueado",
      sentido: "adiantado",
    });
  });

  it("usa a janela configurada pela casa", () => {
    const j = { janelaMin: 10, limiteMaiorMin: 60 };
    expect(estadoDaDose(dose, em(11), j)).toBe("atrasada");
    expect(estadoDaDose(dose, em(61), j)).toBe("sem_registro");
    expect(classificarRegistro(prevista, em(-61), j)).toEqual({
      regra: "bloqueado",
      sentido: "adiantado",
    });
  });

  it("lê a configuração da casa e volta ao padrão quando há valor ruim", () => {
    expect(janelaDaCasa({ janelaMinutos: 20, limiteMaiorMinutos: 90 })).toEqual({
      janelaMin: 20,
      limiteMaiorMin: 90,
    });
    expect(janelaDaCasa({})).toEqual(JANELA_PADRAO);
    expect(janelaDaCasa(null)).toEqual(JANELA_PADRAO);
    expect(janelaDaCasa("texto")).toEqual(JANELA_PADRAO);
    expect(janelaDaCasa({ janelaMinutos: -5, limiteMaiorMinutos: "x" })).toEqual(JANELA_PADRAO);
    expect(janelaDaCasa({ janelaMinutos: 1000 })).toEqual(JANELA_PADRAO);
    // O limite maior nunca fica menor que a janela.
    expect(janelaDaCasa({ janelaMinutos: 60, limiteMaiorMinutos: 30 })).toEqual({
      janelaMin: 60,
      limiteMaiorMin: 60,
    });
  });

  it("ordena: sem registro e atrasadas no topo (a mais antiga primeiro), depois janela, depois o que vem", () => {
    const t = (h: number) => new Date(Date.UTC(2026, 2, 10, h));
    const lista = [
      { n: "futura", estado: "a_fazer" as const, previstaEm: t(14) },
      { n: "janela", estado: "em_janela" as const, previstaEm: t(11) },
      { n: "atrasada-nova", estado: "atrasada" as const, previstaEm: t(10) },
      { n: "sem-registro", estado: "sem_registro" as const, previstaEm: t(7) },
      { n: "atrasada-velha", estado: "atrasada" as const, previstaEm: t(9) },
      { n: "concluida", estado: "concluida" as const, previstaEm: t(6) },
    ];
    expect([...lista].sort(compararParaEscala).map((d) => d.n)).toEqual([
      "sem-registro",
      "atrasada-velha",
      "atrasada-nova",
      "janela",
      "futura",
      "concluida",
    ]);
  });
});
