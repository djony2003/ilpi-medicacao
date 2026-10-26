import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import {
  lancarSaida,
  listaDeReposicao,
  listarSobras,
  situacaoDoEstoque,
  type ReservaDeEstoque,
} from "@/modules/estoque";
import { ErroDePermissao, type Servico } from "@/modules/identidade";
import { mudarStatusDoIdoso } from "@/modules/idosos";
import { encerrarPrescricao } from "@/modules/prescricoes";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import {
  entrarLote,
  novoIdoso,
  novoMedicamento,
  prescreverParaEstoque,
} from "../ajudantes/estoque";
import { criarAtorTablet, criarAtorWeb, type AtorTablet, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const TRES_POR_DIA = ["08:00", "14:00", "20:00"];

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let enf: AtorWeb;
let enfB: AtorWeb;
let cuidador: AtorTablet;
let agora: Date;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const T = (iso: string) => new Date(iso);
const confirmado = <A extends { reautenticadoEm: Date | null }>(a: A): A => ({
  ...a,
  reautenticadoEm: agora,
});

async function reservas(filtro: { idosoId?: string; medicamentoId?: string }, ator: AtorWeb = enf) {
  return (await situacaoDoEstoque(servico(), ator, filtro)).reservas;
}
async function uma(filtro: {
  idosoId?: string;
  medicamentoId?: string;
}): Promise<ReservaDeEstoque> {
  const r = await reservas(filtro);
  if (r.length !== 1) throw new Error(`esperava 1 reserva, vieram ${r.length}`);
  return r[0] as ReservaDeEstoque;
}

beforeAll(async () => {
  app = criarPoolApp(8);
  migrador = criarPoolMigrador();
  // 07:00 em São Paulo de 10/03/2026 (terça-feira): as três doses de hoje ainda vão acontecer.
  agora = T("2026-03-10T10:00:00Z");
  casaA = await criarCasa(migrador, "Casa A Situação");
  casaB = await criarCasa(migrador, "Casa B Situação");
  enf = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
  enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
  cuidador = await criarAtorTablet(servico, migrador, casaA);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("situação do estoque", () => {
  it("estoque comum: quanto há, quanto dura e quem consome dele", async () => {
    const ana = await novoIdoso(servico(), enf, "Ana Comum");
    const m = await novoMedicamento(servico(), enf);
    const lote = await entrarLote(servico(), enf, m, 12, {
      validade: "2029-01-31",
      numeroLote: "C-1",
    });
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);

    const r = await uma({ medicamentoId: m });
    expect(r).toMatchObject({
      dono: "comum",
      idosoId: null,
      unidade: "comprimido",
      saldoDisponivel: 12,
      saldoVencido: 0,
      semPrevisao: null,
      situacao: "aviso",
    });
    expect(r.idososAtendidos).toEqual([{ id: ana, nome: "Ana Comum" }]);
    expect(r.medicamento).toMatchObject({ id: m, concentracao: "10 mg" });
    expect(r.lotes).toEqual([
      { id: lote, numeroLote: "C-1", validade: "2029-01-31", situacaoDeValidade: "ok", saldo: 12 },
    ]);
    // Hoje 08:00, 14:00 e 20:00 (3), amanhã (3), depois (3), depois (3): a falta é no dia 4.
    expect(r.previsao).toMatchObject({
      situacao: "acaba",
      diasRestantes: 4,
      esgotaEm: "2026-03-14",
      consumoDiarioMedio: 3,
    });
  });

  it("o que já passou hoje não conta, pelo horário da casa (não o de Greenwich)", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 6);
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    expect((await uma({ medicamentoId: m })).previsao?.diasRestantes).toBe(2);
    // 21:30 em São Paulo (00:30 UTC do dia seguinte): as três doses de hoje já passaram.
    agora = T("2026-03-11T00:30:00Z");
    try {
      const r = await uma({ medicamentoId: m });
      // 6 doses: amanhã (3) e depois (3) → falta em 13/03, dia 3 a partir de hoje.
      expect(r.previsao).toMatchObject({ diasRestantes: 3, esgotaEm: "2026-03-13" });
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
  });

  it("quem tem estoque individual é atendido só por ele; os demais, pelo comum", async () => {
    const ana = await novoIdoso(servico(), enf, "Ana Individual");
    const bia = await novoIdoso(servico(), enf, "Bia Comum");
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 6, { idosoId: ana });
    await entrarLote(servico(), enf, m, 9);
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    await prescreverParaEstoque(servico(), enf, bia, m, TRES_POR_DIA);

    const todas = await reservas({ medicamentoId: m });
    expect(todas).toHaveLength(2);
    const daAna = todas.find((r) => r.dono === "individual");
    const comum = todas.find((r) => r.dono === "comum");
    expect(daAna).toMatchObject({ idosoId: ana, idosoNome: "Ana Individual", saldoDisponivel: 6 });
    expect(daAna?.previsao?.diasRestantes).toBe(2);
    expect(comum?.idososAtendidos.map((i) => i.nome)).toEqual(["Bia Comum"]);
    expect(comum?.previsao?.diasRestantes).toBe(3);

    // Por idoso: cada um vê a reserva de que depende.
    expect((await reservas({ idosoId: ana })).map((r) => r.dono)).toEqual(["individual"]);
    expect((await reservas({ idosoId: bia })).map((r) => r.dono)).toEqual(["comum"]);
  });

  it("estoque individual esgotado continua individual: a falta aparece como urgente", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    const individual = await entrarLote(servico(), enf, m, 2, { idosoId: ana });
    await entrarLote(servico(), enf, m, 100); // o comum não "socorre" quem depende do da família
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"]);
    await lancarSaida(servico(), confirmado(enf), {
      loteId: individual,
      tipo: "descarte",
      descartarTudo: true,
      motivo: "Esgotado no teste",
    });
    const daAna = (await reservas({ idosoId: ana })).find((r) => r.dono === "individual");
    expect(daAna?.previsao).toMatchObject({ situacao: "acaba", diasRestantes: 0 });
    expect(daAna?.situacao).toBe("urgente");
  });

  it("idoso hospitalizado não consome: o estoque fica sem previsão de término", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 6);
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    expect((await uma({ medicamentoId: m })).previsao?.situacao).toBe("acaba");
    await mudarStatusDoIdoso(servico(), enf, { idosoId: ana, status: "hospitalizado" });
    const r = await uma({ medicamentoId: m });
    expect(r.previsao?.situacao).toBe("sem_consumo");
    expect(r.idososAtendidos).toEqual([]);
  });

  it("prescrição encerrada deixa de consumir", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 6);
    const p = await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    await encerrarPrescricao(servico(), enf, { prescricaoId: p, motivo: "Tratamento concluído" });
    expect((await uma({ medicamentoId: m })).previsao?.situacao).toBe("sem_consumo");
  });

  it("prescrição SOS conta o mínimo de uma dose por dia quando não há histórico", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 5);
    await prescreverParaEstoque(servico(), enf, ana, m, [], {
      tipo: "sos",
      sos: { indicacao: "Dor", limiteDiario: 3, intervaloMinimoMin: 120 },
    });
    expect((await uma({ medicamentoId: m })).previsao).toMatchObject({
      situacao: "acaba",
      diasRestantes: 5,
      consumoDiarioMedio: 1,
    });
  });

  it("receita em miligramas e estoque em comprimidos: sem conversão, a previsão fica indeterminada", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 20, { unidade: "comprimido" });
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"], { dose: 500, unidade: "mg" });
    const r = await reservas({ medicamentoId: m });
    const mg = r.find((x) => x.unidade === "mg");
    expect(mg).toMatchObject({ semPrevisao: "unidade_diferente", previsao: null, situacao: null });
    // O estoque em comprimidos continua visível, sem demanda.
    expect(r.find((x) => x.unidade === "comprimido")?.previsao?.situacao).toBe("sem_consumo");
  });

  it("prescrição sem nenhum lote cadastrado aparece como sem estoque (acaba hoje)", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"]);
    const r = await uma({ medicamentoId: m });
    expect(r.lotes).toEqual([]);
    expect(r.previsao).toMatchObject({ situacao: "acaba", diasRestantes: 0 });
    expect(r.situacao).toBe("urgente");
  });

  it("lote que vence antes de ser usado é apontado; lote vencido não entra na conta", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    const vencendo = await entrarLote(servico(), enf, m, 20, { validade: "2026-03-12" });
    const bom = await entrarLote(servico(), enf, m, 3, { validade: "2030-01-01" });
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    const r = await uma({ medicamentoId: m });
    // O lote vencendo é gasto primeiro: 3 doses por dia em 10, 11 e 12/03; sobram 11 que vencem.
    expect(r.previsao?.vencemSemUso).toEqual([
      { loteId: vencendo, quantidade: 11, validade: "2026-03-12" },
    ]);
    expect(r.lotes.map((l) => [l.id, l.situacaoDeValidade])).toEqual([
      [vencendo, "urgente"],
      [bom, "ok"],
    ]);

    // Passados três dias, o lote vence: o saldo dele não conta e é informado à parte.
    agora = T("2026-03-14T10:00:00Z");
    try {
      const depois = await uma({ medicamentoId: m });
      expect(depois.saldoVencido).toBe(20);
      expect(depois.saldoDisponivel).toBe(3);
      expect(depois.lotes.find((l) => l.id === vencendo)?.situacaoDeValidade).toBe("vencido");
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
  });

  it("o que acaba primeiro aparece primeiro, e sem consumo vai para o fim", async () => {
    const ana = await novoIdoso(servico(), enf);
    const folgado = await novoMedicamento(servico(), enf, { nome: "AAA Folgado" });
    const apertado = await novoMedicamento(servico(), enf, { nome: "ZZZ Apertado" });
    const parado = await novoMedicamento(servico(), enf, { nome: "MMM Parado" });
    await entrarLote(servico(), enf, folgado, 60);
    await entrarLote(servico(), enf, apertado, 4);
    await entrarLote(servico(), enf, parado, 10);
    await prescreverParaEstoque(servico(), enf, ana, folgado, TRES_POR_DIA);
    await prescreverParaEstoque(servico(), enf, ana, apertado, TRES_POR_DIA);
    const ids = [folgado, apertado, parado];
    const todas = (await reservas({})).filter((r) => ids.includes(r.medicamento.id));
    expect(todas.map((r) => r.medicamento.nome)).toEqual([
      "ZZZ Apertado",
      "AAA Folgado",
      "MMM Parado",
    ]);
  });

  it("não mostra lote esgotado sem demanda", async () => {
    const m = await novoMedicamento(servico(), enf);
    const id = await entrarLote(servico(), enf, m, 2);
    await lancarSaida(servico(), confirmado(enf), {
      loteId: id,
      tipo: "descarte",
      descartarTudo: true,
      motivo: "Acabou",
    });
    expect(await reservas({ medicamentoId: m })).toEqual([]);
  });

  it("uma casa nunca vê a situação da outra", async () => {
    const m = await novoMedicamento(servico(), enfB);
    const idoso = await novoIdoso(servico(), enfB, "Idoso Da Casa B");
    await entrarLote(servico(), enfB, m, 4);
    await prescreverParaEstoque(servico(), enfB, idoso, m, TRES_POR_DIA);
    expect(await reservas({ medicamentoId: m }, enfB)).toHaveLength(1);
    expect(await reservas({ medicamentoId: m })).toEqual([]);
    expect(await reservas({ idosoId: idoso })).toEqual([]);
    const tudoDeA = JSON.stringify(await reservas({}));
    expect(tudoDeA).not.toContain("Idoso Da Casa B");
  });

  it("cuidador não consulta a situação do estoque", async () => {
    await expect(situacaoDoEstoque(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
  });
});

describe("lista de reposição", () => {
  const item = (lista: Awaited<ReturnType<typeof listaDeReposicao>>, medicamentoId: string) =>
    lista.itens.find((i) => i.medicamento.id === medicamentoId);

  it("traz o que acaba em até 7 dias, com a quantidade para cobrir 30 dias", async () => {
    const ana = await novoIdoso(servico(), enf, "Ana Reposição");
    const urgente = await novoMedicamento(servico(), enf);
    const folgado = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, urgente, 4);
    await entrarLote(servico(), enf, folgado, 300);
    await prescreverParaEstoque(servico(), enf, ana, urgente, TRES_POR_DIA);
    await prescreverParaEstoque(servico(), enf, ana, folgado, TRES_POR_DIA);

    const lista = await listaDeReposicao(servico(), enf);
    expect(lista).toMatchObject({ coberturaDias: 30, diasParaRepor: 7, hoje: "2026-03-10" });
    expect(lista.casaNome).toBe("Casa A Situação");
    expect(item(lista, folgado)).toBeUndefined();
    // Dura 1 dia (3 hoje, 1 amanhã, falta na 2ª de amanhã); precisa de 90 em 30 dias, tem 4.
    expect(item(lista, urgente)).toMatchObject({
      unidade: "comprimido",
      idosoNome: null,
      idososAtendidos: ["Ana Reposição"],
      saldoDisponivel: 4,
      diasRestantes: 1,
      esgotaEm: "2026-03-11",
      situacao: "urgente",
      quantidadeSugerida: 86,
    });
  });

  it("respeita a cobertura e o limite de dias pedidos", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 4);
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    expect(
      item(await listaDeReposicao(servico(), enf, { coberturaDias: 10 }), m)?.quantidadeSugerida,
    ).toBe(26);
    expect(item(await listaDeReposicao(servico(), enf, { diasParaRepor: 0 }), m)).toBeUndefined();
    expect(item(await listaDeReposicao(servico(), enf, { diasParaRepor: 1 }), m)).toBeDefined();
  });

  it("remédio sem nenhum lote entra com a necessidade toda", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await prescreverParaEstoque(servico(), enf, ana, m, TRES_POR_DIA);
    expect(item(await listaDeReposicao(servico(), enf), m)).toMatchObject({
      saldoDisponivel: 0,
      diasRestantes: 0,
      quantidadeSugerida: 90,
    });
  });

  it("estoque individual aparece com o nome do dono", async () => {
    const dona = await novoIdoso(servico(), enf, "Dona Hilda");
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 2, { idosoId: dona });
    await prescreverParaEstoque(servico(), enf, dona, m, ["08:00"]);
    const i = item(await listaDeReposicao(servico(), enf), m);
    expect(i?.idosoNome).toBe("Dona Hilda");
    expect(i?.quantidadeSugerida).toBe(28); // 30 doses em 30 dias, tem 2
  });

  it("a sugestão arredonda para o passo da unidade (meio comprimido)", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 1);
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"], { dose: 0.5 });
    // 30 doses de 0,5 = 15; tem 1; faltam 14.
    expect(item(await listaDeReposicao(servico(), enf), m)?.quantidadeSugerida).toBe(14);
  });

  it("lote que vence antes de ser usado não conta como estoque para a compra", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 20, { validade: "2026-03-12" });
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"]);
    // Vence em 12/03: usa 3 doses (10, 11 e 12); 17 vencem. 30 doses − 3 = 27.
    const i = item(await listaDeReposicao(servico(), enf, { diasParaRepor: 365 }), m);
    expect(i?.quantidadeSugerida).toBe(27);
  });

  it("emitir a lista é uma exportação e fica na auditoria", async () => {
    const antes = await comContexto(app, { casaId: casaA }, async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM auditoria WHERE acao = 'estoque.lista_reposicao_emitida'",
          )
        ).rows[0]?.n,
      ),
    );
    await listaDeReposicao(servico(), enf, { ip: "10.0.0.9" });
    const depois = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{ ip: string }>(
        "SELECT ip FROM auditoria WHERE acao = 'estoque.lista_reposicao_emitida' ORDER BY id DESC LIMIT 1",
      );
      return {
        n: await c
          .query("SELECT 1 FROM auditoria WHERE acao = 'estoque.lista_reposicao_emitida'")
          .then((x) => x.rowCount),
        ip: r.rows[0]?.ip,
      };
    });
    expect(depois.n).toBe(antes + 1);
    expect(depois.ip).toBe("10.0.0.9");
  });

  it("uma casa não vê itens da outra; cuidador não emite", async () => {
    const idoso = await novoIdoso(servico(), enfB, "Idoso Reposição B");
    const m = await novoMedicamento(servico(), enfB);
    await prescreverParaEstoque(servico(), enfB, idoso, m, TRES_POR_DIA);
    expect(item(await listaDeReposicao(servico(), enfB), m)).toBeDefined();
    const deA = await listaDeReposicao(servico(), enf);
    expect(item(deA, m)).toBeUndefined();
    expect(JSON.stringify(deA)).not.toContain("Idoso Reposição B");
    await expect(listaDeReposicao(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
  });
});

describe("sobras para destinação", () => {
  const sobrasDe = async (m: string) =>
    (await listarSobras(servico(), enf)).sobras.filter((s) => s.lote.medicamentoId === m);

  it("lote vencido com saldo é sobra; lote em dia e esgotado não são", async () => {
    const m = await novoMedicamento(servico(), enf);
    const vencera = await entrarLote(servico(), enf, m, 5, { validade: "2026-03-12" });
    await entrarLote(servico(), enf, m, 5, { validade: "2030-01-01" });
    const esgotado = await entrarLote(servico(), enf, m, 3, { validade: "2026-03-12" });
    await lancarSaida(servico(), confirmado(enf), {
      loteId: esgotado,
      tipo: "descarte",
      descartarTudo: true,
      motivo: "Descartado",
    });
    expect(await sobrasDe(m)).toEqual([]);
    agora = T("2026-03-13T10:00:00Z");
    try {
      const s = await sobrasDe(m);
      expect(s.map((x) => [x.lote.id, x.motivos])).toEqual([[vencera, ["vencido"]]]);
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
  });

  it("estoque individual de quem saiu da casa é sobra", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    const lote = await entrarLote(servico(), enf, m, 8, { idosoId: ana });
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"]);
    expect(await sobrasDe(m)).toEqual([]);
    await mudarStatusDoIdoso(servico(), enf, { idosoId: ana, status: "desligado" });
    expect((await sobrasDe(m)).map((x) => [x.lote.id, x.motivos])).toEqual([
      [lote, ["idoso_desligado"]],
    ]);
  });

  it("estoque individual sem prescrição ativa do remédio (fim do tratamento) é sobra", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    const lote = await entrarLote(servico(), enf, m, 8, { idosoId: ana });
    expect((await sobrasDe(m)).map((x) => x.motivos)).toEqual([["sem_prescricao_ativa"]]);
    const p = await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"]);
    expect(await sobrasDe(m)).toEqual([]);
    await encerrarPrescricao(servico(), enf, { prescricaoId: p, motivo: "Fim do tratamento" });
    expect((await sobrasDe(m)).map((x) => [x.lote.id, x.motivos])).toEqual([
      [lote, ["sem_prescricao_ativa"]],
    ]);
  });

  it("idoso hospitalizado com prescrição ativa não tem sobra; vencido e desligado juntos listam os dois motivos", async () => {
    const ana = await novoIdoso(servico(), enf);
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 8, { idosoId: ana, validade: "2026-03-12" });
    await prescreverParaEstoque(servico(), enf, ana, m, ["08:00"]);
    await mudarStatusDoIdoso(servico(), enf, { idosoId: ana, status: "hospitalizado" });
    expect(await sobrasDe(m)).toEqual([]);
    await mudarStatusDoIdoso(servico(), enf, { idosoId: ana, status: "ativo" });
    await mudarStatusDoIdoso(servico(), enf, { idosoId: ana, status: "desligado" });
    agora = T("2026-03-13T10:00:00Z");
    try {
      expect((await sobrasDe(m)).map((x) => x.motivos)).toEqual([["vencido", "idoso_desligado"]]);
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
  });

  it("uma casa não vê sobras da outra; cuidador não consulta", async () => {
    const m = await novoMedicamento(servico(), enfB);
    await entrarLote(servico(), enfB, m, 5, { validade: "2026-03-12" });
    agora = T("2026-03-13T10:00:00Z");
    try {
      expect(
        (await listarSobras(servico(), enfB)).sobras.some((s) => s.lote.medicamentoId === m),
      ).toBe(true);
      expect(
        (await listarSobras(servico(), enf)).sobras.some((s) => s.lote.medicamentoId === m),
      ).toBe(false);
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
    await expect(listarSobras(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
  });
});
