import { describe, expect, it } from "vitest";
import { JANELA_PADRAO } from "@/modules/administracao";
import {
  CONFIGURACAO_PADRAO,
  condicoesDeDoses,
  condicoesDeEstoque,
  condicoesDeExcecoes,
  condicoesDePrescricoes,
  condicoesDeSos,
  condicoesDeValidade,
  configuracaoDeAlertas,
  deveEnviarEmail,
  fimDoPlantao,
  montarEmail,
  problemasDaConfiguracao,
  reconciliar,
  type AlertaAberto,
  type Condicao,
} from "@/modules/alertas";

const C = CONFIGURACAO_PADRAO;
const FUSO = "America/Sao_Paulo";
const H = 3_600_000;
const T0 = new Date("2026-03-10T12:00:00Z"); // 09:00 em São Paulo

describe("configuração dos alertas", () => {
  it("sem nada configurado, vale o padrão da spec", () => {
    expect(configuracaoDeAlertas({})).toEqual(C);
    expect(configuracaoDeAlertas(null)).toEqual(C);
    expect(C).toMatchObject({
      estoqueAvisoDias: 7,
      estoqueUrgenteDias: 3,
      validadeAvisoDias: 30,
      validadeUrgenteDias: 7,
      prescricaoAvisoDias: 5,
      escalonamentoHoras: 2,
    });
  });

  it("campo inválido volta ao padrão (configuração estragada nunca silencia alerta)", () => {
    const c = configuracaoDeAlertas({
      alertas: {
        estoqueAvisoDias: -1,
        validadeAvisoDias: "30",
        fimDosPlantoes: ["25:00"],
        escalonamentoHoras: 4,
      },
    });
    expect(c).toMatchObject({
      estoqueAvisoDias: 7,
      validadeAvisoDias: 30,
      fimDosPlantoes: ["07:00", "19:00"],
      escalonamentoHoras: 4,
    });
  });

  it("urgente nunca depois do aviso, e os plantões ficam em ordem", () => {
    const c = configuracaoDeAlertas({
      alertas: { estoqueAvisoDias: 2, estoqueUrgenteDias: 5, fimDosPlantoes: ["19:00", "07:00"] },
    });
    expect(c.estoqueUrgenteDias).toBe(2);
    expect(c.fimDosPlantoes).toEqual(["07:00", "19:00"]);
  });

  it("aponta o que está errado no pedido do gestor", () => {
    expect(problemasDaConfiguracao({ estoqueAvisoDias: 7, fimDosPlantoes: ["07:00"] })).toEqual([]);
    expect(problemasDaConfiguracao({ estoqueAvisoDias: 0.5 })).toHaveLength(1);
    expect(problemasDaConfiguracao({ fimDosPlantoes: ["07:00", "07:00"] })).toHaveLength(1);
    expect(problemasDaConfiguracao({ emailParaAvisos: "sim" })).toHaveLength(1);
  });
});

describe("condições", () => {
  it("estoque: aviso com 7 dias, urgente com 3; o prazo de reposição adianta o aviso", () => {
    const r = (dias: number | null, config = C) =>
      condicoesDeEstoque(
        [
          {
            chave: "k",
            medicamento: "Losartana 50 mg",
            idosoNome: "Benedito",
            diasRestantes: dias,
            esgotaEm: "2026-03-13",
          },
        ],
        config,
      );
    expect(r(8)).toEqual([]);
    expect(r(null)).toEqual([]);
    expect(r(7)[0]).toMatchObject({
      gravidade: "aviso",
      chave: "estoque:k",
      titulo: "Losartana 50 mg de Benedito acaba em 7 dias",
    });
    expect(r(3)[0]?.gravidade).toBe("urgente");
    expect(r(0)[0]?.titulo).toContain("falta para a próxima dose hoje");
    expect(r(10, { ...C, prazoReposicaoDias: 10 })[0]?.gravidade).toBe("aviso");
  });

  it("validade: aviso em 30 dias, urgente em 7, vencido é outra condição (urgente)", () => {
    const lote = (validade: string, saldo = 5) => ({
      id: "L",
      numeroLote: "A1",
      medicamento: "Dipirona",
      validade,
      saldo,
      idosoNome: null,
    });
    const hoje = "2026-03-10";
    expect(condicoesDeValidade([lote("2026-04-10")], hoje, C)).toEqual([]);
    expect(condicoesDeValidade([lote("2026-04-09")], hoje, C)[0]).toMatchObject({
      chave: "validade:L",
      gravidade: "aviso",
    });
    expect(condicoesDeValidade([lote("2026-03-17")], hoje, C)[0]?.gravidade).toBe("urgente");
    expect(condicoesDeValidade([lote("2026-03-10")], hoje, C)[0]).toMatchObject({
      tipo: "validade_proxima",
      titulo: expect.stringContaining("vence hoje"),
    });
    expect(condicoesDeValidade([lote("2026-03-09")], hoje, C)[0]).toMatchObject({
      chave: "vencido:L",
      tipo: "lote_vencido",
      gravidade: "urgente",
    });
    expect(condicoesDeValidade([lote("2026-03-09", 0)], hoje, C)).toEqual([]);
  });

  it("dose: atrasada depois da janela, sem registro depois do limite; no fim do plantão vai ao gestor", () => {
    const ref = new Date("2026-03-10T11:00:00Z"); // 08:00
    const dose = {
      id: "D",
      idosoNome: "Aparecida",
      medicamento: "Losartana",
      horaLocal: "08:00",
      referencia: ref,
    };
    const aos = (min: number) =>
      condicoesDeDoses([dose], new Date(ref.getTime() + min * 60_000), JANELA_PADRAO, FUSO, C);
    expect(aos(30)).toEqual([]);
    expect(aos(31)[0]).toMatchObject({
      chave: "dose_atrasada:D",
      gravidade: "aviso",
      destino: "enfermeiro",
    });
    expect(aos(120)[0]?.tipo).toBe("dose_atrasada");
    expect(aos(121)[0]).toMatchObject({
      chave: "dose_sem_registro:D",
      gravidade: "urgente",
      destino: "enfermeiro",
    });
    // Plantão das 07:00 às 19:00: às 19:00 (22:00Z) vai para o gestor.
    expect(aos(10 * 60 + 59)[0]?.destino).toBe("enfermeiro");
    expect(aos(11 * 60)[0]?.destino).toBe("gestor");
  });

  it("fim do plantão: o próximo fim depois do horário da dose, inclusive passando da meia-noite", () => {
    const fins = ["07:00", "19:00"];
    expect(fimDoPlantao(new Date("2026-03-10T11:00:00Z"), FUSO, fins).toISOString()).toBe(
      "2026-03-10T22:00:00.000Z",
    );
    expect(fimDoPlantao(new Date("2026-03-10T23:30:00Z"), FUSO, fins).toISOString()).toBe(
      "2026-03-11T10:00:00.000Z",
    );
    expect(fimDoPlantao(new Date("2026-03-10T22:00:00Z"), FUSO, fins).toISOString()).toBe(
      "2026-03-11T10:00:00.000Z",
    );
  });

  it("prescrição: aviso 5 dias antes, urgente no dia; depois do fim, nada", () => {
    const p = (fim: string) =>
      condicoesDePrescricoes(
        [{ id: "P", idosoNome: "Celina", medicamento: "Amoxicilina", fim }],
        "2026-03-10",
        C,
      );
    expect(p("2026-03-16")).toEqual([]);
    expect(p("2026-03-15")[0]?.gravidade).toBe("aviso");
    expect(p("2026-03-10")[0]).toMatchObject({
      gravidade: "urgente",
      titulo: expect.stringContaining("termina hoje"),
    });
    expect(p("2026-03-09")).toEqual([]);
  });

  it("exceções: resumo de ontem para o gestor (informativo); repetidas pela mesma pessoa, urgente", () => {
    const r = condicoesDeExcecoes(
      { data: "2026-03-09", total: 2 },
      [
        { usuarioId: "u1", nome: "Ana", total: 3 },
        { usuarioId: "u2", nome: "Bruno", total: 2 },
      ],
      C,
    );
    expect(r).toEqual([
      expect.objectContaining({
        chave: "excecoes_dia:2026-03-09",
        destino: "gestor",
        informativo: true,
        titulo: "2 exceções de conferência em 09/03",
      }),
      expect.objectContaining({
        chave: "excecoes_usuario:u1",
        gravidade: "urgente",
        informativo: false,
      }),
    ]);
    expect(condicoesDeExcecoes({ data: "2026-03-09", total: 0 }, [], C)).toEqual([]);
  });

  it("SOS bloqueado: um aviso informativo por prescrição por dia", () => {
    expect(
      condicoesDeSos([
        {
          prescricaoId: "p",
          idosoNome: "Aparecida",
          medicamento: "Paracetamol",
          data: "2026-03-10",
          vezes: 2,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        chave: "sos:p:2026-03-10",
        informativo: true,
        detalhe: "Bloqueado 2 vezes em 10/03. Avalie o paciente.",
      }),
    ]);
  });
});

describe("reconciliação", () => {
  const cond = (chave: string, extra: Partial<Condicao> = {}): Condicao => ({
    chave,
    tipo: "estoque_acabando",
    gravidade: "aviso",
    destino: "enfermeiro",
    titulo: `t ${chave}`,
    detalhe: null,
    entidade: null,
    entidadeId: null,
    informativo: false,
    ...extra,
  });
  const aberto = (chave: string, extra: Partial<AlertaAberto> = {}): AlertaAberto => ({
    id: `id-${chave}`,
    chave,
    gravidade: "aviso",
    destino: "enfermeiro",
    titulo: `t ${chave}`,
    detalhe: null,
    informativo: false,
    abertoEm: T0,
    gravidadeDesde: T0,
    notificadoEm: T0,
    escaladoEm: null,
    lido: false,
    ...extra,
  });
  const em = (h: number) => new Date(T0.getTime() + h * H);

  it("abre o que é novo, uma vez por condição (a mais grave vence)", () => {
    const p = reconciliar(
      [cond("a"), cond("a", { gravidade: "urgente" }), cond("b")],
      [aberto("b")],
      [],
      em(0),
      C,
    );
    expect(p.abrir.map((c) => [c.chave, c.gravidade])).toEqual([["a", "urgente"]]);
    expect(p).toMatchObject({
      agravar: [],
      atualizar: [],
      resolver: [],
      reavisar: [],
      escalar: [],
    });
  });

  it("agrava, abranda e atualiza o texto; fecha o que sumiu; informativo só fecha ao ser lido", () => {
    const p = reconciliar(
      [cond("a", { gravidade: "urgente" }), cond("b"), cond("c", { titulo: "novo texto" })],
      [
        aberto("a"),
        aberto("b", { gravidade: "urgente" }),
        aberto("c"),
        aberto("d"),
        aberto("e", { informativo: true }),
      ],
      [],
      em(0.5),
      C,
    );
    expect(p.agravar.map((x) => x.id)).toEqual(["id-a"]);
    expect(p.atualizar.map((x) => x.id).sort()).toEqual(["id-b", "id-c"]);
    expect(p.resolver).toEqual(["id-d"]);
  });

  it("quem tratou não é incomodado de novo pela mesma condição, a menos que tenha piorado", () => {
    const p = reconciliar(
      [cond("a"), cond("b", { gravidade: "urgente" })],
      [],
      [
        { chave: "a", gravidade: "aviso" },
        { chave: "b", gravidade: "aviso" },
      ],
      em(0),
      C,
    );
    expect(p.abrir.map((c) => c.chave)).toEqual(["b"]);
  });

  it("reavisa o que ninguém leu, no intervalo da gravidade; quem leu não recebe reaviso", () => {
    const urgente = aberto("u", { gravidade: "urgente", escaladoEm: em(0) });
    expect(
      reconciliar([cond("u", { gravidade: "urgente" })], [urgente], [], em(3.9), C).reavisar,
    ).toEqual([]);
    expect(
      reconciliar([cond("u", { gravidade: "urgente" })], [urgente], [], em(4), C).reavisar,
    ).toEqual(["id-u"]);
    expect(reconciliar([cond("a")], [aberto("a")], [], em(23), C).reavisar).toEqual([]);
    expect(reconciliar([cond("a")], [aberto("a")], [], em(24), C).reavisar).toEqual(["id-a"]);
    expect(reconciliar([cond("a")], [aberto("a", { lido: true })], [], em(48), C).reavisar).toEqual(
      [],
    );
  });

  it("escala ao gestor o urgente não lido em 2 horas, ou a condição que já pede o gestor", () => {
    const u = aberto("u", { gravidade: "urgente" });
    expect(reconciliar([cond("u", { gravidade: "urgente" })], [u], [], em(1.9), C).escalar).toEqual(
      [],
    );
    expect(reconciliar([cond("u", { gravidade: "urgente" })], [u], [], em(2), C).escalar).toEqual([
      "id-u",
    ]);
    expect(
      reconciliar([cond("u", { gravidade: "urgente" })], [{ ...u, lido: true }], [], em(5), C)
        .escalar,
    ).toEqual([]);
    expect(
      reconciliar(
        [cond("u", { gravidade: "urgente" })],
        [{ ...u, escaladoEm: em(2) }],
        [],
        em(5),
        C,
      ).escalar,
    ).toEqual([]);
    expect(
      reconciliar(
        [cond("u", { gravidade: "urgente", destino: "gestor" })],
        [{ ...u, lido: true }],
        [],
        em(0.1),
        C,
      ).escalar,
    ).toEqual(["id-u"]);
  });

  it("e-mail: urgentes sempre; avisos só se a casa pedir; escalonamento e agravamento sempre", () => {
    expect(deveEnviarEmail("aviso", "novo", C)).toBe(false);
    expect(deveEnviarEmail("aviso", "novo", { ...C, emailParaAvisos: true })).toBe(true);
    expect(deveEnviarEmail("urgente", "reaviso", C)).toBe(true);
    expect(deveEnviarEmail("aviso", "escalonamento", C)).toBe(true);
  });
});

describe("e-mail sem dados de saúde", () => {
  it("só diz que há um alerta, onde ver, e nada do alerta em si", () => {
    const e = montarEmail({
      motivo: "escalonamento",
      gravidade: "urgente",
      casaNome: "Casa Bem Viver",
      nomeDestinatario: "Gestora",
      linkDoPainel: "https://app.exemplo/painel",
    });
    expect(e.assunto).toBe("[Urgente] Alerta no ILPI Medicação: Casa Bem Viver");
    expect(e.texto).toContain("https://app.exemplo/painel");
    expect(e.texto).toContain("encaminhado a você");
    // A função nem recebe título, residente ou remédio: não há como vazar. Garantia extra:
    for (const proibido of ["dose", "remédio", "medicamento", "alergia", "paciente", "residente"]) {
      expect(e.texto.toLowerCase()).not.toContain(proibido);
      expect(e.assunto.toLowerCase()).not.toContain(proibido);
    }
  });
});
