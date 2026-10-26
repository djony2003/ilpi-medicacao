import { describe, expect, it } from "vitest";
import { diaDaSemanaIso, diasEntre, somarDias } from "@/compartilhado/datas";
import {
  conflitosComAlergia,
  diasParaVencer,
  diferencasClinicas,
  estaVigente,
  horariosNoDia,
  situacaoDeVigencia,
  sugerirAltoRisco,
  validarPrescricao,
  verificarLimiteSos,
  type ConteudoDePrescricao,
} from "@/modules/prescricoes";

const HOJE = "2026-03-10"; // terça-feira

const regular: ConteudoDePrescricao = {
  medicamentoId: "m1",
  tipo: "regular",
  dose: 1,
  unidade: "comprimido",
  via: "oral",
  inicio: HOJE,
  fim: null,
  altoRisco: false,
  horarios: [{ hora: "08:00" }, { hora: "20:00" }],
};
const sos: ConteudoDePrescricao = {
  ...regular,
  tipo: "sos",
  horarios: [],
  sos: { indicacao: "Dor", limiteDiario: 3, intervaloMinimoMin: 360 },
};

describe("datas", () => {
  it("soma dias atravessando mês, ano e 29 de fevereiro", () => {
    expect(somarDias("2026-01-31", 1)).toBe("2026-02-01");
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somarDias("2028-02-28", 1)).toBe("2028-02-29");
    expect(somarDias("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("calcula diferença e dia da semana ISO", () => {
    expect(diasEntre("2026-03-10", "2026-03-15")).toBe(5);
    expect(diasEntre("2026-03-10", "2026-03-05")).toBe(-5);
    expect(diaDaSemanaIso("2026-03-10")).toBe(2);
    expect(diaDaSemanaIso("2026-03-15")).toBe(7);
    expect(diaDaSemanaIso("2026-03-09")).toBe(1);
  });
});

describe("validarPrescricao", () => {
  it("aceita prescrição regular e SOS corretas", () => {
    expect(validarPrescricao(regular, HOJE)).toEqual([]);
    expect(validarPrescricao(sos, HOJE)).toEqual([]);
  });

  it.each([
    ["dose zero", { dose: 0 }, /maior que zero/],
    ["dose negativa", { dose: -1 }, /maior que zero/],
    ["dose NaN", { dose: Number.NaN }, /maior que zero/],
    ["dose enorme", { dose: 1_000_000 }, /alto demais/],
    ["dose com 4 casas", { dose: 0.0001 }, /3 casas/],
    ["unidade inventada", { unidade: "colher" }, /Unidade/],
    ["via inventada", { via: "ocular" }, /Via/],
    ["início inexistente", { inicio: "2026-02-30" }, /início inválida/],
    ["início muito no futuro", { inicio: "2028-01-01" }, /mais de um ano/],
    ["fim antes do início", { fim: "2026-03-09" }, /antes do início/],
    ["fim que já passou", { inicio: "2026-01-01", fim: "2026-03-09" }, /já passou/],
    ["sem horário", { horarios: [] }, /ao menos um horário/],
    ["horário inválido", { horarios: [{ hora: "25:00" }] }, /Horário inválido/],
    [
      "horário repetido",
      { horarios: [{ hora: "08:00" }, { hora: "8:00" }, { hora: "08:00" }] },
      /mais de uma vez/,
    ],
    ["dia da semana 0", { horarios: [{ hora: "08:00", diasSemana: [0] }] }, /Dias da semana/],
    ["dia da semana 8", { horarios: [{ hora: "08:00", diasSemana: [8] }] }, /Dias da semana/],
    [
      "regular com limite SOS",
      { sos: { indicacao: "Dor", limiteDiario: 1, intervaloMinimoMin: 60 } },
      /não leva limite/,
    ],
  ] as Array<[string, Partial<ConteudoDePrescricao>, RegExp]>)(
    "recusa %s",
    (_nome, mudanca, regex) => {
      const problemas = validarPrescricao({ ...regular, ...mudanca }, HOJE);
      expect(problemas.join(" | ")).toMatch(regex);
    },
  );

  it("recusa mais de 24 horários", () => {
    const horarios = Array.from({ length: 25 }, (_, i) => ({
      hora: `${String(i % 24).padStart(2, "0")}:${i < 24 ? "00" : "30"}`,
    }));
    expect(validarPrescricao({ ...regular, horarios }, HOJE).join()).toMatch(/No máximo 24/);
  });

  it.each([
    ["SOS sem dados de limite", { sos: null }, /Informe a indicação/],
    ["SOS com horário fixo", { horarios: [{ hora: "08:00" }] }, /não tem horários fixos/],
    [
      "SOS limite 0",
      { sos: { indicacao: "Dor", limiteDiario: 0, intervaloMinimoMin: 60 } },
      /limite por dia/,
    ],
    [
      "SOS limite fracionado",
      { sos: { indicacao: "Dor", limiteDiario: 1.5, intervaloMinimoMin: 60 } },
      /limite por dia/,
    ],
    [
      "SOS limite 25",
      { sos: { indicacao: "Dor", limiteDiario: 25, intervaloMinimoMin: 60 } },
      /limite por dia/,
    ],
    [
      "SOS intervalo 0",
      { sos: { indicacao: "Dor", limiteDiario: 2, intervaloMinimoMin: 0 } },
      /intervalo mínimo/,
    ],
    [
      "SOS intervalo > 24h",
      { sos: { indicacao: "Dor", limiteDiario: 2, intervaloMinimoMin: 1441 } },
      /intervalo mínimo/,
    ],
    [
      "SOS sem indicação",
      { sos: { indicacao: " ", limiteDiario: 2, intervaloMinimoMin: 60 } },
      /indicação/,
    ],
  ] as Array<[string, Partial<ConteudoDePrescricao>, RegExp]>)(
    "recusa %s",
    (_nome, mudanca, regex) => {
      expect(validarPrescricao({ ...sos, ...mudanca }, HOJE).join(" | ")).toMatch(regex);
    },
  );

  it("começar hoje, amanhã ou no passado é permitido (transcrição de receita em curso)", () => {
    for (const inicio of ["2026-01-01", HOJE, "2026-03-11"])
      expect(validarPrescricao({ ...regular, inicio }, HOJE)).toEqual([]);
    expect(validarPrescricao({ ...regular, fim: HOJE }, HOJE)).toEqual([]);
  });
});

describe("vigência", () => {
  const base = { status: "ativa" as const, inicio: "2026-03-10", fim: "2026-03-20" };
  it("o primeiro e o último dia contam inteiros", () => {
    expect(situacaoDeVigencia(base, "2026-03-09")).toBe("futura");
    expect(situacaoDeVigencia(base, "2026-03-10")).toBe("vigente");
    expect(situacaoDeVigencia(base, "2026-03-20")).toBe("vigente");
    expect(situacaoDeVigencia(base, "2026-03-21")).toBe("vencida");
  });
  it("uso contínuo nunca vence", () => {
    expect(estaVigente({ ...base, fim: null }, "2030-01-01")).toBe(true);
    expect(diasParaVencer({ ...base, fim: null }, "2026-03-10")).toBeNull();
  });
  it("encerrada e substituída nunca estão vigentes, mesmo dentro das datas", () => {
    for (const status of ["encerrada", "substituida"] as const) {
      expect(situacaoDeVigencia({ ...base, status }, "2026-03-15")).toBe("encerrada");
      expect(estaVigente({ ...base, status }, "2026-03-15")).toBe(false);
      expect(diasParaVencer({ ...base, status }, "2026-03-15")).toBeNull();
    }
  });
  it("conta os dias para vencer (0 = vence hoje)", () => {
    expect(diasParaVencer(base, "2026-03-15")).toBe(5);
    expect(diasParaVencer(base, "2026-03-20")).toBe(0);
    expect(diasParaVencer(base, "2026-03-21")).toBeNull();
  });
  it("horários do dia respeitam os dias da semana e saem em ordem", () => {
    const horarios = [
      { hora: "20:00" },
      { hora: "08:00", diasSemana: [1, 3, 5] },
      { hora: "14:00", diasSemana: [2] },
    ];
    expect(horariosNoDia(horarios, "2026-03-10")).toEqual(["14:00", "20:00"]); // terça
    expect(horariosNoDia(horarios, "2026-03-09")).toEqual(["08:00", "20:00"]); // segunda
    expect(horariosNoDia(horarios, "2026-03-15")).toEqual(["20:00"]); // domingo
  });
});

describe("diferenças entre versões", () => {
  it("versão idêntica não tem diferença, mesmo com horários em outra ordem ou 'todos os dias' explícito", () => {
    const outra: ConteudoDePrescricao = {
      ...regular,
      instrucoes: "  ",
      horarios: [{ hora: "20:00", diasSemana: [7, 6, 5, 4, 3, 2, 1, 1] }, { hora: "08:00" }],
    };
    expect(diferencasClinicas(regular, outra)).toEqual([]);
  });
  it("lista só o que mudou", () => {
    expect(diferencasClinicas(regular, { ...regular, dose: 2 })).toEqual(["dose"]);
    expect(diferencasClinicas(regular, { ...regular, via: "sublingual", altoRisco: true })).toEqual(
      ["via", "altoRisco"],
    );
    expect(diferencasClinicas(regular, { ...regular, horarios: [{ hora: "08:00" }] })).toEqual([
      "horarios",
    ]);
    expect(diferencasClinicas(regular, { ...regular, fim: "2026-04-01" })).toEqual(["fim"]);
    expect(diferencasClinicas(regular, { ...regular, medicamentoId: "m2" })).toEqual([
      "medicamento",
    ]);
    expect(
      diferencasClinicas(sos, {
        ...sos,
        sos: { ...(sos.sos as NonNullable<typeof sos.sos>), limiteDiario: 4 },
      }),
    ).toEqual(["sos"]);
  });
});

describe("limite da dose SOS", () => {
  const limite = { limiteDiario: 3, intervaloMinimoMin: 360 };
  const t = (hhmm: string, dia = "2026-03-10") => new Date(`${dia}T${hhmm}:00Z`);

  it("sem doses anteriores, libera", () => {
    expect(verificarLimiteSos(limite, [], t("08:00"))).toEqual({ permitido: true });
  });
  it("bloqueia dentro do intervalo mínimo e diz quando libera", () => {
    const r = verificarLimiteSos(limite, [t("08:00")], t("12:00"));
    expect(r).toEqual({ permitido: false, motivo: "intervalo_minimo", liberaEm: t("14:00") });
  });
  it("libera exatamente no fim do intervalo", () => {
    expect(verificarLimiteSos(limite, [t("08:00")], t("14:00"))).toEqual({ permitido: true });
    expect(
      verificarLimiteSos(limite, [t("08:00")], new Date(t("14:00").getTime() - 1)).permitido,
    ).toBe(false);
  });
  it("bloqueia no limite diário usando janela móvel de 24h, não o dia do calendário", () => {
    const doses = [t("22:00", "2026-03-09"), t("23:00", "2026-03-09"), t("00:30")];
    const r = verificarLimiteSos({ limiteDiario: 3, intervaloMinimoMin: 10 }, doses, t("07:00"));
    // Três doses nas últimas 24h: libera quando a mais antiga sair da janela (22h de hoje).
    expect(r).toEqual({ permitido: false, motivo: "limite_diario", liberaEm: t("22:00") });
    expect(
      verificarLimiteSos({ limiteDiario: 3, intervaloMinimoMin: 10 }, doses, t("22:00")),
    ).toEqual({ permitido: true });
  });
  it("com mais doses que o limite na janela, libera quando sobrar espaço de verdade", () => {
    const doses = [t("01:00"), t("02:00"), t("03:00"), t("04:00")];
    const r = verificarLimiteSos({ limiteDiario: 2, intervaloMinimoMin: 10 }, doses, t("06:00"));
    // Para ficar com 1 dose na janela é preciso a de 03:00 sair: 03:00 do dia seguinte.
    expect(r).toEqual({
      permitido: false,
      motivo: "limite_diario",
      liberaEm: t("03:00", "2026-03-11"),
    });
  });
  it("quando os dois bloqueios valem, informa o que libera por último", () => {
    const doses = [t("06:00"), t("12:00"), t("18:00")];
    const r = verificarLimiteSos(limite, doses, t("19:00"));
    expect(r).toMatchObject({
      permitido: false,
      motivo: "limite_diario",
      liberaEm: t("06:00", "2026-03-11"),
    });
  });
  it("doses antigas (mais de 24h) não contam, e doses 'do futuro' não bloqueiam", () => {
    expect(
      verificarLimiteSos(
        limite,
        [t("08:00", "2026-03-08"), t("09:00", "2026-03-08"), t("10:00", "2026-03-08")],
        t("08:00"),
      ),
    ).toEqual({ permitido: true });
    expect(verificarLimiteSos(limite, [t("23:00")], t("08:00"))).toEqual({ permitido: true });
  });
  it("não depende da ordem em que as doses chegam", () => {
    const a = verificarLimiteSos(limite, [t("12:00"), t("06:00")], t("13:00"));
    const b = verificarLimiteSos(limite, [t("06:00"), t("12:00")], t("13:00"));
    expect(a).toEqual(b);
  });
});

describe("conflito com alergia", () => {
  const alergia = (substancia: string, gravidade: "leve" | "moderada" | "grave" = "grave") => ({
    id: substancia,
    substancia,
    gravidade,
  });

  it("acha a mesma substância ignorando acento, caixa e sal", () => {
    expect(
      conflitosComAlergia({ principioAtivo: "Dipirona Sódica" }, [alergia("dipirona")]),
    ).toEqual([expect.objectContaining({ alergiaId: "dipirona", tipo: "mesma_substancia" })]);
    expect(
      conflitosComAlergia({ principioAtivo: "Cloridrato de Tramadol" }, [alergia("TRAMADOL")]),
    ).toHaveLength(1);
  });
  it("acha pelo nome comercial e por sinônimos populares", () => {
    expect(
      conflitosComAlergia({ principioAtivo: "dipirona", nomeComercial: "Novalgina" }, [
        alergia("Novalgina"),
      ]),
    ).toHaveLength(1);
    expect(
      conflitosComAlergia({ principioAtivo: "Ácido acetilsalicílico" }, [alergia("Aspirina")]),
    ).toHaveLength(1);
    expect(
      conflitosComAlergia({ principioAtivo: "Acetaminofeno" }, [alergia("paracetamol")]),
    ).toHaveLength(1);
  });
  it("avisa de família (penicilinas), marcando como tal", () => {
    const r = conflitosComAlergia({ principioAtivo: "Amoxicilina" }, [
      alergia("Penicilina", "moderada"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]?.tipo).toBe("mesma_familia");
  });
  it("não confunde substâncias diferentes", () => {
    expect(
      conflitosComAlergia({ principioAtivo: "Losartana" }, [alergia("Dipirona"), alergia("Látex")]),
    ).toEqual([]);
    expect(conflitosComAlergia({ principioAtivo: "Metformina" }, [alergia("Metoprolol")])).toEqual(
      [],
    );
    expect(conflitosComAlergia({ principioAtivo: "Paracetamol" }, [alergia("Dipirona")])).toEqual(
      [],
    );
  });
  it("palavras neutras sozinhas não geram falso alerta", () => {
    expect(
      conflitosComAlergia({ principioAtivo: "Cloridrato de Metformina" }, [
        alergia("Cloridrato de Tramadol"),
      ]),
    ).toEqual([]);
    expect(
      conflitosComAlergia({ principioAtivo: "Ácido fólico" }, [alergia("Ácido acetilsalicílico")]),
    ).toEqual([]);
  });
  it("ordena da gravidade maior para a menor", () => {
    const r = conflitosComAlergia({ principioAtivo: "Ibuprofeno" }, [
      alergia("Naproxeno", "leve"),
      alergia("Ibuprofeno", "grave"),
      alergia("AAS", "moderada"),
    ]);
    expect(r.map((c) => c.gravidade)).toEqual(["grave", "moderada", "leve"]);
  });
  it("família: anti-inflamatórios entre si", () => {
    const r = conflitosComAlergia({ principioAtivo: "Diclofenaco" }, [alergia("Aspirina")]);
    expect(r).toEqual([expect.objectContaining({ tipo: "mesma_familia" })]);
  });
  it("sem alergias, sem conflito", () => {
    expect(conflitosComAlergia({ principioAtivo: "Dipirona" }, [])).toEqual([]);
  });
});

describe("sugestão de alto risco", () => {
  it("sugere para medicamentos de alta vigilância, ignorando acento e caixa", () => {
    for (const n of [
      "Insulina NPH",
      "VARFARINA sódica",
      "Cloreto de Potássio",
      "Lítio",
      "Digoxina",
    ])
      expect(sugerirAltoRisco(n), n).toBe(true);
  });
  it("não sugere para os comuns", () => {
    for (const n of ["Paracetamol", "Losartana", "Omeprazol", "Diclofenaco potássico"])
      expect(sugerirAltoRisco(n), n).toBe(false);
  });
});
