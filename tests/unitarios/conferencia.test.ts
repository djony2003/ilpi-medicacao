import { describe, expect, it } from "vitest";
import {
  JANELA_PADRAO,
  conferirDose,
  problemaNoAdiamento,
  regraDeHorario,
  type EntradaDaConferencia,
  type LoteParaConferir,
} from "@/modules/administracao";

// Conferência da dose (tabela 5.4 da spec): cada bloqueio isolado, a ordem entre eles e o que
// NÃO bloqueia.

const IDOSO = "idoso-a";
const OUTRO = "idoso-b";
const MED = "med-1";

const loteBom: LoteParaConferir = {
  id: "lote-1",
  medicamentoId: MED,
  idosoId: null,
  validade: "2026-12-31",
  unidade: "comprimido",
  saldo: 10,
};

function base(extra: Partial<EntradaDaConferencia> = {}): EntradaDaConferencia {
  return {
    idosoId: IDOSO,
    prescricao: {
      status: "ativa",
      medicamentoId: MED,
      principioAtivo: "Losartana potássica",
      nomeComercial: "Cozaar",
      dose: 1,
      unidade: "comprimido",
      alergiasConfirmadas: [],
    },
    alergias: [],
    registroFinal: null,
    pulseira: { situacao: "lida", idosoId: IDOSO },
    lote: { situacao: "lida", lote: loteBom },
    resultado: "administrada",
    hoje: "2026-03-10",
    fuso: "America/Sao_Paulo",
    ...extra,
  };
}

const codigos = (e: EntradaDaConferencia) => conferirDose(e).bloqueios.map((b) => b.codigo);
const comLote = (l: Partial<LoteParaConferir>) => ({
  situacao: "lida" as const,
  lote: { ...loteBom, ...l },
});

describe("conferência da dose", () => {
  it("tudo certo: nenhum bloqueio", () => {
    expect(conferirDose(base())).toEqual({ bloqueios: [], alergiasConfirmadas: [] });
  });

  it("pulseira de outro paciente bloqueia, com a frase da spec", () => {
    const r = conferirDose(base({ pulseira: { situacao: "lida", idosoId: OUTRO } }));
    expect(r.bloqueios[0]).toMatchObject({
      codigo: "pulseira_de_outro_idoso",
      mensagem: "Esta pulseira é de outro paciente",
      acao: "Tente com o paciente certo.",
    });
  });

  it("pulseira inválida, desconhecida ou substituída bloqueia cada uma com seu código", () => {
    expect(codigos(base({ pulseira: { situacao: "invalida" } }))).toEqual(["pulseira_invalida"]);
    expect(codigos(base({ pulseira: { situacao: "desconhecida" } }))).toEqual([
      "pulseira_desconhecida",
    ]);
    expect(codigos(base({ pulseira: { situacao: "substituida" } }))).toEqual([
      "pulseira_substituida",
    ]);
  });

  it("dose já registrada: diz por quem e a que horas (no fuso da casa), e nada mais importa", () => {
    const r = conferirDose(
      base({
        registroFinal: { usuarioNome: "Maria", ocorridaEm: new Date("2026-03-10T11:05:00Z") },
        pulseira: { situacao: "lida", idosoId: OUTRO },
      }),
    );
    expect(r.bloqueios).toEqual([
      {
        codigo: "dose_ja_registrada",
        mensagem: "Dose já registrada: por Maria às 08:05",
        acao: "Nenhuma.",
      },
    ]);
  });

  it("prescrição encerrada ou substituída bloqueia", () => {
    for (const status of ["encerrada", "substituida"] as const) {
      expect(codigos(base({ prescricao: { ...base().prescricao, status } }))).toEqual([
        "prescricao_encerrada",
      ]);
    }
  });

  it("remédio errado: o resto do lote nem é avaliado", () => {
    expect(
      codigos(
        base({ lote: comLote({ medicamentoId: "outro", validade: "2020-01-01", saldo: 0 }) }),
      ),
    ).toEqual(["medicamento_errado"]);
  });

  it("lote vencido: diz quando venceu; vencer hoje ainda vale (validade é o último dia de uso)", () => {
    const r = conferirDose(base({ lote: comLote({ validade: "2026-03-09" }) }));
    expect(r.bloqueios).toEqual([
      expect.objectContaining({
        codigo: "lote_vencido",
        mensagem: "Lote vencido: venceu em 09/03",
      }),
    ]);
    expect(codigos(base({ lote: comLote({ validade: "2026-03-10" }) }))).toEqual([]);
  });

  it("lote do estoque de outro idoso bloqueia; o do próprio idoso e o comum, não", () => {
    expect(codigos(base({ lote: comLote({ idosoId: OUTRO }) }))).toEqual(["lote_de_outro_idoso"]);
    expect(codigos(base({ lote: comLote({ idosoId: IDOSO }) }))).toEqual([]);
    expect(codigos(base({ lote: comLote({ idosoId: null }) }))).toEqual([]);
  });

  it("saldo menor que a dose bloqueia; igual à dose passa (sem erro de ponto flutuante)", () => {
    const meia = { ...base().prescricao, dose: 0.5 };
    expect(codigos(base({ prescricao: meia, lote: comLote({ saldo: 0.25 }) }))).toEqual([
      "saldo_insuficiente",
    ]);
    expect(codigos(base({ prescricao: meia, lote: comLote({ saldo: 0.5 }) }))).toEqual([]);
    const fracao = { ...base().prescricao, dose: 0.3, unidade: "ml" };
    expect(
      codigos(base({ prescricao: fracao, lote: comLote({ unidade: "ml", saldo: 0.1 + 0.2 }) })),
    ).toEqual([]);
  });

  it("unidade do lote diferente da prescrita bloqueia (não há conversão automática)", () => {
    const r = conferirDose(base({ lote: comLote({ unidade: "ml" }) }));
    expect(r.bloqueios.map((b) => b.codigo)).toEqual(["unidade_diferente"]);
    expect(r.bloqueios[0]?.mensagem).toContain("lote em ml, prescrição em comprimido");
  });

  it("etiqueta inválida ou desconhecida bloqueia", () => {
    expect(codigos(base({ lote: { situacao: "invalida" } }))).toEqual(["etiqueta_invalida"]);
    expect(codigos(base({ lote: { situacao: "desconhecida" } }))).toEqual([
      "etiqueta_desconhecida",
    ]);
  });

  describe("alergia", () => {
    const dipirona = { id: "al-1", substancia: "Dipirona", gravidade: "grave" as const };
    const prescricaoDeNovalgina = {
      ...base().prescricao,
      principioAtivo: "Metamizol sódico",
      nomeComercial: "Novalgina",
    };

    it("alergia ao princípio ativo (ou a um sinônimo) bloqueia e diz qual", () => {
      const r = conferirDose(base({ prescricao: prescricaoDeNovalgina, alergias: [dipirona] }));
      expect(r.bloqueios).toEqual([
        expect.objectContaining({
          codigo: "alergia",
          mensagem: "Alerta: alergia registrada: Dipirona (grave)",
        }),
      ]);
    });

    it("alergia confirmada por quem prescreveu avisa, mas não bloqueia", () => {
      const r = conferirDose(
        base({
          prescricao: { ...prescricaoDeNovalgina, alergiasConfirmadas: ["al-1"] },
          alergias: [dipirona],
        }),
      );
      expect(r.bloqueios).toEqual([]);
      expect(r.alergiasConfirmadas).toEqual([
        expect.objectContaining({ alergiaId: "al-1", substancia: "Dipirona" }),
      ]);
    });

    it("alergia nova (cadastrada depois da confirmação) bloqueia mesmo com outra confirmada", () => {
      const r = conferirDose(
        base({
          prescricao: { ...prescricaoDeNovalgina, alergiasConfirmadas: ["al-1"] },
          alergias: [dipirona, { id: "al-2", substancia: "Metamizol", gravidade: "moderada" }],
        }),
      );
      expect(r.bloqueios.map((b) => b.mensagem)).toEqual([
        "Alerta: alergia registrada: Metamizol (moderada)",
      ]);
    });

    it("recusa e não administração não dependem de alergia nem de lote", () => {
      for (const resultado of ["recusada", "nao_administrada"] as const) {
        expect(
          codigos(
            base({
              resultado,
              prescricao: prescricaoDeNovalgina,
              alergias: [dipirona],
              lote: { situacao: "invalida" },
            }),
          ),
        ).toEqual([]);
      }
    });
  });

  it("vários problemas: todos aparecem, na ordem da gravidade", () => {
    expect(
      codigos(
        base({
          pulseira: { situacao: "lida", idosoId: OUTRO },
          prescricao: { ...base().prescricao, status: "encerrada" },
          lote: comLote({ idosoId: OUTRO, validade: "2026-01-01", saldo: 0 }),
        }),
      ),
    ).toEqual([
      "pulseira_de_outro_idoso",
      "prescricao_encerrada",
      "lote_de_outro_idoso",
      "lote_vencido",
      "saldo_insuficiente",
    ]);
  });

  it("sem pulseira (não administrada) ou sem lote ainda lido: só confere o que tem", () => {
    expect(codigos(base({ pulseira: null, lote: null, resultado: "nao_administrada" }))).toEqual(
      [],
    );
    expect(codigos(base({ lote: null }))).toEqual([]);
  });
});

describe("regra de horário (janela 30 min, limite 120 min)", () => {
  const prevista = new Date("2026-03-10T11:00:00Z");
  const aos = (min: number) =>
    regraDeHorario(prevista, new Date(prevista.getTime() + min * 60_000), JANELA_PADRAO);

  it("dentro da janela é livre, inclusive nas bordas", () => {
    for (const m of [-30, -1, 0, 15, 30]) expect(aos(m)).toEqual({ tipo: "livre" });
  });

  it("fora da janela até o limite exige motivo, nos dois sentidos", () => {
    expect(aos(31)).toEqual({ tipo: "exige_motivo", sentido: "atrasado" });
    expect(aos(120)).toEqual({ tipo: "exige_motivo", sentido: "atrasado" });
    expect(aos(-31)).toEqual({ tipo: "exige_motivo", sentido: "adiantado" });
    expect(aos(-120)).toEqual({ tipo: "exige_motivo", sentido: "adiantado" });
  });

  it("além do limite: antecipado só com liberação, atrasado só como registro tardio", () => {
    const cedo = aos(-121);
    expect(cedo).toMatchObject({
      tipo: "bloqueio",
      bloqueio: { codigo: "horario_antecipado", liberavel: true },
    });
    const tarde = aos(121);
    expect(tarde).toMatchObject({ tipo: "bloqueio", bloqueio: { codigo: "horario_expirado" } });
    expect(tarde.tipo === "bloqueio" && tarde.bloqueio.liberavel).toBeFalsy();
  });

  it("a janela segue a configuração da casa", () => {
    const j = { janelaMin: 10, limiteMaiorMin: 60 };
    expect(regraDeHorario(prevista, new Date(prevista.getTime() + 11 * 60_000), j)).toEqual({
      tipo: "exige_motivo",
      sentido: "atrasado",
    });
    expect(regraDeHorario(prevista, new Date(prevista.getTime() + 61 * 60_000), j).tipo).toBe(
      "bloqueio",
    );
  });
});

describe("adiamento", () => {
  const prevista = new Date("2026-03-10T11:00:00Z");
  const agora = new Date("2026-03-10T11:10:00Z");
  const em = (min: number) => new Date(prevista.getTime() + min * 60_000);

  it("aceita um novo horário depois de agora e até o limite maior do horário original", () => {
    expect(problemaNoAdiamento(em(40), prevista, agora, JANELA_PADRAO)).toBeNull();
    expect(problemaNoAdiamento(em(120), prevista, agora, JANELA_PADRAO)).toBeNull();
  });

  it("recusa horário no passado, inválido ou além do limite", () => {
    expect(problemaNoAdiamento(em(5), prevista, agora, JANELA_PADRAO)).toMatch(/depois de agora/);
    expect(problemaNoAdiamento(em(10), prevista, agora, JANELA_PADRAO)).toMatch(/depois de agora/);
    expect(problemaNoAdiamento(em(121), prevista, agora, JANELA_PADRAO)).toMatch(/120 minutos/);
    expect(problemaNoAdiamento(new Date("x"), prevista, agora, JANELA_PADRAO)).toMatch(
      /novo horário/,
    );
  });
});
