import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import {
  ehSaldoInsuficiente,
  emitirEtiqueta,
  fracionarLote,
  lancarSaida,
  listarLotes,
  obterLote,
  registrarEntrada,
} from "@/modules/estoque";
import { ErroDePermissao, ErroDeReautenticacao, type Servico } from "@/modules/identidade";
import { mudarStatusDoIdoso } from "@/modules/idosos";
import { desativarMedicamento } from "@/modules/prescricoes";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import {
  acoesDeAuditoria,
  consumirDoLote,
  entrarLote,
  movimentosDoLote,
  novoIdoso,
  novoMedicamento,
  saldoDoLote,
} from "../ajudantes/estoque";
import { criarAtorTablet, criarAtorWeb, type AtorTablet, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let enf: AtorWeb;
let gestor: AtorWeb;
let enfB: AtorWeb;
let cuidador: AtorTablet;
let agora: Date;
let med: string;
let medB: string;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const T = (iso: string) => new Date(iso);
/** O ator com a senha confirmada agora (a janela é de 5 minutos). */
const confirmado = <A extends { reautenticadoEm: Date | null }>(a: A): A => ({
  ...a,
  reautenticadoEm: agora,
});
const saldo = (loteId: string, casa = casaA) => saldoDoLote(app, casa, loteId);

beforeAll(async () => {
  app = criarPoolApp(10);
  migrador = criarPoolMigrador();
  agora = T("2026-03-10T10:00:00Z"); // 07:00 em São Paulo
  casaA = await criarCasa(migrador, "Casa A Estoque");
  casaB = await criarCasa(migrador, "Casa B Estoque");
  enf = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
  gestor = await criarAtorWeb(servico, migrador, casaA, "gestor");
  cuidador = await criarAtorTablet(servico, migrador, casaA);
  enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
  med = await novoMedicamento(servico(), enf);
  medB = await novoMedicamento(servico(), enfB);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("entrada de lote", () => {
  it("cria o lote, lança a entrada no movimento e o saldo é a quantidade", async () => {
    const r = await registrarEntrada(servico(), enf, {
      medicamentoId: med,
      numeroLote: "  AB-123  ",
      validade: "2027-06-30",
      unidade: "comprimido",
      quantidade: 30,
      observacao: "Doado pela família",
    });
    if (!r.ok) throw new Error(r.motivo);
    expect(await saldo(r.loteId)).toBe(30);
    expect(await movimentosDoLote(app, casaA, r.loteId)).toEqual([
      { tipo: "entrada", quantidade: 30, motivo: null, parId: null },
    ]);
    const lote = await obterLote(servico(), enf, r.loteId);
    if (!lote.ok) throw new Error("lote");
    expect(lote.lote).toMatchObject({
      numeroLote: "AB-123",
      validade: "2027-06-30",
      unidade: "comprimido",
      quantidadeInicial: 30,
      saldo: 30,
      idosoId: null,
      origemId: null,
      situacaoDeValidade: "ok",
      criadoEm: agora.toISOString(),
    });
    expect(lote.lote.movimentos[0]).toMatchObject({
      tipo: "entrada",
      quantidade: 30,
      usuarioId: enf.usuarioId,
    });
    expect(await acoesDeAuditoria(app, casaA, r.loteId)).toEqual(["estoque.entrada"]);
  });

  it("aceita meio comprimido na quantidade e estoque individual de um idoso", async () => {
    const idoso = await novoIdoso(servico(), enf, "Dona Zilda");
    const id = await entrarLote(servico(), enf, med, 30.5, { idosoId: idoso });
    expect(await saldo(id)).toBe(30.5);
    const lote = await obterLote(servico(), gestor, id);
    expect(lote.ok && lote.lote.idosoNome).toBe("Dona Zilda");
  });

  it("gestor também pode dar entrada", async () => {
    expect((await registrarEntrada(servico(), gestor, base(med))).ok).toBe(true);
  });

  const base = (medicamentoId: string) => ({
    medicamentoId,
    numeroLote: "X1",
    validade: "2030-01-31",
    unidade: "comprimido" as const,
    quantidade: 10,
  });

  it("recusa medicamento inexistente, de outra casa ou desativado, sem gravar nada", async () => {
    const antes = (await listarLotes(servico(), enf, { incluirZerados: true })).length;
    const inexistente = "00000000-0000-4000-8000-000000000001";
    expect(await registrarEntrada(servico(), enf, base(inexistente))).toEqual({
      ok: false,
      motivo: "medicamento_nao_encontrado",
    });
    expect(await registrarEntrada(servico(), enf, base(medB))).toEqual({
      ok: false,
      motivo: "medicamento_nao_encontrado",
    });
    const aposentado = await novoMedicamento(servico(), enf);
    expect((await desativarMedicamento(servico(), enf, { medicamentoId: aposentado })).ok).toBe(
      true,
    );
    expect(await registrarEntrada(servico(), enf, base(aposentado))).toEqual({
      ok: false,
      motivo: "medicamento_inativo",
    });
    expect((await listarLotes(servico(), enf, { incluirZerados: true })).length).toBe(antes);
  });

  it("recusa idoso de outra casa, inexistente ou desligado", async () => {
    const idosoB = await novoIdoso(servico(), enfB);
    expect(await registrarEntrada(servico(), enf, { ...base(med), idosoId: idosoB })).toEqual({
      ok: false,
      motivo: "idoso_nao_encontrado",
    });
    expect(
      await registrarEntrada(servico(), enf, {
        ...base(med),
        idosoId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toEqual({ ok: false, motivo: "idoso_nao_encontrado" });
    const saiu = await novoIdoso(servico(), enf);
    expect(
      (await mudarStatusDoIdoso(servico(), enf, { idosoId: saiu, status: "desligado" })).ok,
    ).toBe(true);
    expect(await registrarEntrada(servico(), enf, { ...base(med), idosoId: saiu })).toEqual({
      ok: false,
      motivo: "idoso_desligado",
    });
  });

  it("dados inválidos voltam com os problemas e nada é gravado", async () => {
    const antes = (await listarLotes(servico(), enf, { incluirZerados: true })).length;
    const r = await registrarEntrada(servico(), enf, {
      ...base(med),
      validade: "2026-03-09",
      quantidade: 0.3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.motivo === "dados_invalidos") expect(r.problemas).toHaveLength(2);
    expect((await listarLotes(servico(), enf, { incluirZerados: true })).length).toBe(antes);
  });

  it("cuidador não dá entrada de estoque", async () => {
    await expect(registrarEntrada(servico(), cuidador, base(med))).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
  });

  it("a validade vale no fuso da casa, não em UTC", async () => {
    // 01:00 UTC de 11/03 ainda é 22:00 de 10/03 em São Paulo: validade 10/03 ainda não venceu.
    agora = T("2026-03-11T01:00:00Z");
    try {
      expect(
        (await registrarEntrada(servico(), enf, { ...base(med), validade: "2026-03-10" })).ok,
      ).toBe(true);
      const r = await registrarEntrada(servico(), enf, { ...base(med), validade: "2026-03-09" });
      expect(r.ok).toBe(false);
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
  });

  it("cada lote recebe um código de QR próprio, de 20 caracteres, que nunca aparece nas consultas", async () => {
    const a = await entrarLote(servico(), enf, med, 5);
    const b = await entrarLote(servico(), enf, med, 5);
    const codigos = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{ codigo_qr: string }>(
        "SELECT codigo_qr FROM lote_estoque WHERE id = ANY($1::uuid[])",
        [[a, b]],
      );
      return r.rows.map((x) => x.codigo_qr);
    });
    expect(new Set(codigos).size).toBe(2);
    for (const c of codigos) {
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{20}$/);
      const consulta = JSON.stringify([
        await obterLote(servico(), enf, a),
        await obterLote(servico(), enf, b),
        await listarLotes(servico(), enf),
      ]);
      expect(consulta).not.toContain(c);
    }
  });
});

describe("saldo por movimentos e travas do banco", () => {
  it("o saldo é a soma dos movimentos, sem erro de ponto flutuante", async () => {
    const id = await entrarLote(servico(), enf, med, 1, { unidade: "ml" });
    await comContexto(app, { casaId: casaA, usuarioId: enf.usuarioId }, async (c) => {
      for (const q of [-0.1, -0.2, -0.3]) {
        await c.query(
          `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, motivo, usuario_id)
           VALUES (app_casa_id(), $1, 'perda', $2, 'teste de soma', $3)`,
          [id, q, enf.usuarioId],
        );
      }
    });
    expect(await saldo(id)).toBe(0.4);
  });

  it("o banco recusa saldo negativo, mesmo por inserção direta", async () => {
    const id = await entrarLote(servico(), enf, med, 3);
    const erro = await comContexto(app, { casaId: casaA, usuarioId: enf.usuarioId }, (c) =>
      c.query(
        `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, motivo, usuario_id)
         VALUES (app_casa_id(), $1, 'perda', -3.001, 'teste', $2)`,
        [id, enf.usuarioId],
      ),
    ).catch((e: unknown) => e);
    expect(ehSaldoInsuficiente(erro)).toBe(true);
    expect(await saldo(id)).toBe(3);
    // Exatamente o saldo é permitido.
    await consumirDoLote(app, casaA, enf.usuarioId, id, 3);
    expect(await saldo(id)).toBe(0);
  });

  it("o sinal do movimento precisa combinar com o tipo", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const tenta = (tipo: string, q: number, extra = "'motivo ok'", adm = "NULL") =>
      comContexto(app, { casaId: casaA, usuarioId: enf.usuarioId }, (c) =>
        c.query(
          `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, motivo, usuario_id, administracao_id, par_id)
           VALUES (app_casa_id(), $1, $2, $3, ${extra}, $4, ${adm}, gen_random_uuid())`,
          [id, tipo, q, enf.usuarioId],
        ),
      ).then(
        () => null,
        (e: { constraint?: string }) => e.constraint ?? "erro",
      );
    expect(await tenta("entrada", -1)).toBe("movimento_sinal_do_tipo");
    expect(await tenta("perda", 1)).toBe("movimento_sinal_do_tipo");
    expect(await tenta("descarte", 1)).toBe("movimento_sinal_do_tipo");
    expect(await tenta("devolucao", 1)).toBe("movimento_sinal_do_tipo");
    expect(await tenta("fracionamento_saida", 1)).toBe("movimento_sinal_do_tipo");
    expect(await tenta("fracionamento_entrada", -1)).toBe("movimento_sinal_do_tipo");
    expect(await tenta("consumo", 1, "NULL", "gen_random_uuid()")).toBe("movimento_sinal_do_tipo");
    expect(await tenta("perda", 0)).toBe("movimento_estoque_quantidade_check");
    // Ajuste vale nos dois sentidos.
    expect(await tenta("ajuste", 2)).toBeNull();
    expect(await tenta("ajuste", -2)).toBeNull();
  });

  it("perda, descarte, devolução e ajuste exigem motivo; consumo exige a administração", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const tenta = (tipo: string, q: number, motivo: string, adm: string) =>
      comContexto(app, { casaId: casaA, usuarioId: enf.usuarioId }, (c) =>
        c.query(
          `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, motivo, usuario_id, administracao_id)
           VALUES (app_casa_id(), $1, $2, $3, ${motivo}, $4, ${adm})`,
          [id, tipo, q, enf.usuarioId],
        ),
      ).then(
        () => null,
        (e: { constraint?: string }) => e.constraint ?? "erro",
      );
    for (const tipo of ["perda", "descarte", "devolucao"]) {
      expect(await tenta(tipo, -1, "NULL", "NULL"), tipo).toBe("movimento_motivo_obrigatorio");
      expect(await tenta(tipo, -1, "'  '", "NULL"), tipo).toBe("movimento_estoque_motivo_check");
    }
    expect(await tenta("ajuste", 1, "NULL", "NULL")).toBe("movimento_motivo_obrigatorio");
    expect(await tenta("consumo", -1, "NULL", "NULL")).toBe("movimento_consumo_tem_administracao");
    expect(await tenta("consumo", -1, "NULL", "gen_random_uuid()")).toBeNull();
  });

  it("fracionamento exige o par que liga as duas pontas", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const erro = await comContexto(app, { casaId: casaA, usuarioId: enf.usuarioId }, (c) =>
      c.query(
        `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, usuario_id)
         VALUES (app_casa_id(), $1, 'fracionamento_saida', -1, $2)`,
        [id, enf.usuarioId],
      ),
    ).catch((e: { constraint?: string }) => e.constraint);
    expect(erro).toBe("movimento_fracionamento_tem_par");
  });

  it("lotes e movimentos não mudam nem se apagam: nem para a aplicação, nem para o dono do schema", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    // Aplicação: sem permissão de UPDATE nem DELETE.
    for (const sql of [
      "UPDATE lote_estoque SET numero_lote = 'x' WHERE id = $1",
      "UPDATE movimento_estoque SET quantidade = 999 WHERE lote_id = $1",
      "DELETE FROM lote_estoque WHERE id = $1",
      "DELETE FROM movimento_estoque WHERE lote_id = $1",
      "UPDATE impressao_etiqueta SET reimpressao = true WHERE lote_id = $1",
    ]) {
      const erro = await comContexto(app, { casaId: casaA }, (c) => c.query(sql, [id])).catch(
        (e: { code?: string }) => e.code,
      );
      expect(erro, sql).toBe("42501");
    }
    // Dono do schema: o gatilho barra.
    for (const sql of [
      "UPDATE lote_estoque SET numero_lote = 'x' WHERE id = $1",
      "UPDATE movimento_estoque SET quantidade = 999 WHERE lote_id = $1",
      "DELETE FROM lote_estoque WHERE id = $1",
      "DELETE FROM movimento_estoque WHERE lote_id = $1",
    ]) {
      const erro = await comContexto(migrador, { casaId: casaA }, (c) => c.query(sql, [id])).catch(
        (e: Error) => e.message,
      );
      expect(String(erro), sql).toMatch(/não pode ser alterado/);
    }
    expect(await saldo(id)).toBe(10);
  });

  it("dez baixas simultâneas de uma unidade num lote de cinco: só cinco passam e o saldo termina em zero", async () => {
    const id = await entrarLote(servico(), enf, med, 5);
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, () => consumirDoLote(app, casaA, enf.usuarioId, id, 1)),
    );
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const recusadas = resultados.filter((r) => r.status === "rejected");
    expect(recusadas).toHaveLength(5);
    for (const r of recusadas)
      expect(ehSaldoInsuficiente((r as PromiseRejectedResult).reason)).toBe(true);
    expect(await saldo(id)).toBe(0);
  });

  it("a casa B não enxerga lotes, movimentos nem saldo da casa A, e não movimenta lote alheio", async () => {
    const id = await entrarLote(servico(), enf, med, 8);
    await comContexto(app, { casaId: casaB }, async (c) => {
      expect((await c.query("SELECT 1 FROM lote_estoque WHERE id = $1", [id])).rowCount).toBe(0);
      expect(
        (await c.query("SELECT 1 FROM movimento_estoque WHERE lote_id = $1", [id])).rowCount,
      ).toBe(0);
      expect((await c.query("SELECT 1 FROM saldo_lote WHERE lote_id = $1", [id])).rowCount).toBe(0);
    });
    // Lançar movimento da casa B num lote da casa A: a chave estrangeira composta recusa a
    // entrada, e o gatilho de saldo (que só enxerga a casa B) recusa a saída.
    const lancar = (quantidade: number) =>
      comContexto(app, { casaId: casaB, usuarioId: enfB.usuarioId }, (c) =>
        c.query(
          `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, motivo, usuario_id)
           VALUES (app_casa_id(), $1, 'ajuste', $2, 'invasão', $3)`,
          [id, quantidade, enfB.usuarioId],
        ),
      ).catch((e: { code?: string }) => e.code);
    expect(await lancar(1)).toBe("23503");
    expect(await lancar(-1)).toBe("23514");
    expect(await saldo(id)).toBe(8);
    // E lote da casa B não pode apontar para medicamento da casa A.
    const erro2 = await comContexto(app, { casaId: casaB, usuarioId: enfB.usuarioId }, (c) =>
      c.query(
        `INSERT INTO lote_estoque (casa_id, medicamento_id, codigo_qr, numero_lote, validade, unidade, quantidade_inicial)
         VALUES (app_casa_id(), $1, 'ABCDEFGHJKMNPQRSTUVW', 'x', '2030-01-01', 'comprimido', 1)`,
        [med],
      ),
    ).catch((e: { code?: string }) => e.code);
    expect(erro2).toBe("23503");
  });
});

describe("fracionamento", () => {
  it("separa parte do lote em outro com etiqueta própria, sem mudar o estoque total", async () => {
    const origem = await entrarLote(servico(), enf, med, 30, {
      validade: "2029-05-31",
      numeroLote: "CX-9",
    });
    const r = await fracionarLote(servico(), enf, { loteId: origem, quantidade: 10 });
    if (!r.ok) throw new Error(r.motivo);
    expect(await saldo(origem)).toBe(20);
    expect(await saldo(r.loteId)).toBe(10);
    const filho = await obterLote(servico(), enf, r.loteId);
    if (!filho.ok) throw new Error("filho");
    expect(filho.lote).toMatchObject({
      origemId: origem,
      medicamentoId: med,
      unidade: "comprimido",
      validade: "2029-05-31",
      numeroLote: "CX-9",
      quantidadeInicial: 10,
      idosoId: null,
    });
    const saida = (await movimentosDoLote(app, casaA, origem)).find(
      (m) => m.tipo === "fracionamento_saida",
    );
    const entrada = (await movimentosDoLote(app, casaA, r.loteId))[0];
    expect(saida).toMatchObject({ quantidade: -10 });
    expect(entrada).toMatchObject({ tipo: "fracionamento_entrada", quantidade: 10 });
    expect(saida?.parId).toBeTruthy();
    expect(saida?.parId).toBe(entrada?.parId);
    expect(await acoesDeAuditoria(app, casaA, origem)).toContain("estoque.fracionado");
  });

  it("o lote novo tem código de QR diferente do de origem", async () => {
    const origem = await entrarLote(servico(), enf, med, 4);
    const r = await fracionarLote(servico(), enf, { loteId: origem, quantidade: 1 });
    if (!r.ok) throw new Error(r.motivo);
    const codigos = await comContexto(app, { casaId: casaA }, async (c) => {
      const x = await c.query<{ codigo_qr: string }>(
        "SELECT codigo_qr FROM lote_estoque WHERE id IN ($1, $2)",
        [origem, r.loteId],
      );
      return x.rows.map((l) => l.codigo_qr);
    });
    expect(new Set(codigos).size).toBe(2);
  });

  it("do estoque comum, o pedaço pode ir para um idoso; do individual, só para o mesmo idoso", async () => {
    const ana = await novoIdoso(servico(), enf);
    const bia = await novoIdoso(servico(), enf);
    const comum = await entrarLote(servico(), enf, med, 20);
    const paraAna = await fracionarLote(servico(), enf, {
      loteId: comum,
      quantidade: 5,
      destinoIdosoId: ana,
    });
    if (!paraAna.ok) throw new Error(paraAna.motivo);
    expect(
      await obterLote(servico(), enf, paraAna.loteId).then((x) => x.ok && x.lote.idosoId),
    ).toBe(ana);

    // O lote da Ana não passa para a Bia, mas pode ser repartido dentro da própria Ana.
    const nao = await fracionarLote(servico(), enf, {
      loteId: paraAna.loteId,
      quantidade: 1,
      destinoIdosoId: bia,
    });
    expect(nao.ok).toBe(false);
    expect(await saldo(paraAna.loteId)).toBe(5);
    const mesma = await fracionarLote(servico(), enf, {
      loteId: paraAna.loteId,
      quantidade: 1,
      destinoIdosoId: ana,
    });
    expect(mesma.ok).toBe(true);
    const semDestino = await fracionarLote(servico(), enf, {
      loteId: paraAna.loteId,
      quantidade: 1,
    });
    if (!semDestino.ok) throw new Error("sem destino");
    expect(
      await obterLote(servico(), enf, semDestino.loteId).then((x) => x.ok && x.lote.idosoId),
    ).toBe(ana);
  });

  it("recusa mais do que o saldo, lote vencido, quantidade inválida, lote alheio e idoso desligado", async () => {
    const id = await entrarLote(servico(), enf, med, 3);
    expect(await fracionarLote(servico(), enf, { loteId: id, quantidade: 3.25 })).toEqual({
      ok: false,
      motivo: "saldo_insuficiente",
    });
    expect((await fracionarLote(servico(), enf, { loteId: id, quantidade: 0.3 })).ok).toBe(false);
    expect((await fracionarLote(servico(), enf, { loteId: id, quantidade: 0 })).ok).toBe(false);
    expect((await fracionarLote(servico(), enf, { loteId: id, quantidade: -1 })).ok).toBe(false);
    expect(
      await fracionarLote(servico(), enf, {
        loteId: "00000000-0000-4000-8000-000000000003",
        quantidade: 1,
      }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await fracionarLote(servico(), enfB, { loteId: id, quantidade: 1 })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    const saiu = await novoIdoso(servico(), enf);
    await mudarStatusDoIdoso(servico(), enf, { idosoId: saiu, status: "desligado" });
    expect(
      await fracionarLote(servico(), enf, { loteId: id, quantidade: 1, destinoIdosoId: saiu }),
    ).toEqual({ ok: false, motivo: "idoso_desligado" });
    expect(await saldo(id)).toBe(3);

    const venc = await entrarLote(servico(), enf, med, 5, { validade: "2026-03-12" });
    agora = T("2026-03-13T10:00:00Z");
    try {
      expect(await fracionarLote(servico(), enf, { loteId: venc, quantidade: 1 })).toEqual({
        ok: false,
        motivo: "lote_vencido",
      });
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
    expect(await saldo(venc)).toBe(5);
  });

  it("o banco impede lote fracionado com validade maior, unidade ou medicamento diferentes", async () => {
    const origem = await entrarLote(servico(), enf, med, 10, { validade: "2028-01-01" });
    const outroMed = await novoMedicamento(servico(), enf);
    const insere = (medicamento: string, validade: string, unidade: string) =>
      comContexto(app, { casaId: casaA, usuarioId: enf.usuarioId }, (c) =>
        c.query(
          `INSERT INTO lote_estoque (casa_id, medicamento_id, codigo_qr, numero_lote, validade, unidade, quantidade_inicial, origem_id)
           VALUES (app_casa_id(), $1, $4, 'f', $2, $3, 1, $5)`,
          [
            medicamento,
            validade,
            unidade,
            `${Math.random()
              .toString(36)
              .slice(2)
              .toUpperCase()
              .replace(/[01IOL]/g, "2")
              .padEnd(20, "A")
              .slice(0, 20)}`,
            origem,
          ],
        ),
      ).then(
        () => "ok",
        (e: Error) => e.message,
      );
    expect(await insere(med, "2028-01-02", "comprimido")).toMatch(/vencer depois/);
    expect(await insere(med, "2028-01-01", "ml")).toMatch(/mesma unidade/);
    expect(await insere(outroMed, "2028-01-01", "comprimido")).toMatch(/mesmo medicamento/);
    expect(await insere(med, "2027-12-31", "comprimido")).toBe("ok");
  });

  it("dois fracionamentos disputando o mesmo saldo: um passa, o outro é recusado, e nada se perde", async () => {
    for (let rodada = 0; rodada < 5; rodada += 1) {
      const origem = await entrarLote(servico(), enf, med, 10);
      const r = await Promise.all([
        fracionarLote(servico(), enf, { loteId: origem, quantidade: 10 }),
        fracionarLote(servico(), gestor, { loteId: origem, quantidade: 10 }),
      ]);
      expect(
        r.filter((x) => x.ok),
        `rodada ${rodada}`,
      ).toHaveLength(1);
      expect(r.filter((x) => !x.ok && x.motivo === "saldo_insuficiente")).toHaveLength(1);
      expect(await saldo(origem)).toBe(0);
    }
  });

  it("cuidador não fraciona", async () => {
    const id = await entrarLote(servico(), enf, med, 3);
    await expect(
      fracionarLote(servico(), cuidador, { loteId: id, quantidade: 1 }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
  });
});

describe("perdas, descartes, devoluções e ajustes", () => {
  it("a perda tira do saldo, guarda o motivo e quem fez, e fica na auditoria", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const r = await lancarSaida(servico(), confirmado(enf), {
      loteId: id,
      tipo: "perda",
      quantidade: 2.5,
      motivo: "  Frasco caiu no chão  ",
    });
    if (!r.ok) throw new Error(r.motivo);
    expect(r).toMatchObject({ quantidade: -2.5, saldo: 7.5 });
    expect(await saldo(id)).toBe(7.5);
    const mov = (await movimentosDoLote(app, casaA, id)).at(-1);
    expect(mov).toMatchObject({ tipo: "perda", quantidade: -2.5, motivo: "Frasco caiu no chão" });
    const auditoria = await comContexto(app, { casaId: casaA }, async (c) => {
      const x = await c.query<{ antes: unknown; depois: unknown; usuario_id: string }>(
        "SELECT antes, depois, usuario_id FROM auditoria WHERE entidade_id = $1 AND acao = 'estoque.perda'",
        [id],
      );
      return x.rows[0];
    });
    expect(auditoria?.antes).toEqual({ saldo: 10 });
    expect(auditoria?.depois).toEqual({
      saldo: 7.5,
      quantidade: -2.5,
      motivo: "Frasco caiu no chão",
    });
    expect(auditoria?.usuario_id).toBe(enf.usuarioId);
  });

  it("devolução e descarte reduzem o saldo; descartar tudo zera o lote", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const dev = await lancarSaida(servico(), confirmado(enf), {
      loteId: id,
      tipo: "devolucao",
      quantidade: 4,
      motivo: "Devolvido à família",
    });
    expect(dev.ok && dev.saldo).toBe(6);
    const tudo = await lancarSaida(servico(), confirmado(enf), {
      loteId: id,
      tipo: "descarte",
      descartarTudo: true,
      motivo: "Lote vencido",
    });
    expect(tudo).toMatchObject({ ok: true, quantidade: -6, saldo: 0 });
    expect(await saldo(id)).toBe(0);
    expect(
      await lancarSaida(servico(), confirmado(enf), {
        loteId: id,
        tipo: "descarte",
        descartarTudo: true,
        motivo: "Outra vez",
      }),
    ).toMatchObject({ ok: false, motivo: "dados_invalidos" });
  });

  it("ajuste vale para os dois lados, e não tira mais do que há", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const mais = await lancarSaida(servico(), confirmado(gestor), {
      loteId: id,
      tipo: "ajuste",
      quantidade: 2,
      motivo: "Sobra encontrada na caixa",
    });
    expect(mais.ok && mais.saldo).toBe(12);
    const menos = await lancarSaida(servico(), confirmado(gestor), {
      loteId: id,
      tipo: "ajuste",
      quantidade: -5,
      motivo: "Contagem na prateleira",
    });
    expect(menos.ok && menos.saldo).toBe(7);
    expect(
      await lancarSaida(servico(), confirmado(gestor), {
        loteId: id,
        tipo: "ajuste",
        quantidade: -7.25,
        motivo: "Contagem errada",
      }),
    ).toEqual({ ok: false, motivo: "saldo_insuficiente" });
    expect(
      await lancarSaida(servico(), confirmado(gestor), {
        loteId: id,
        tipo: "ajuste",
        quantidade: 0,
        motivo: "Nada",
      }),
    ).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    expect(await saldo(id)).toBe(7);
  });

  it("recusa quantidade maior que o saldo, mas aceita exatamente o saldo", async () => {
    const id = await entrarLote(servico(), enf, med, 3);
    expect(
      await lancarSaida(servico(), confirmado(enf), {
        loteId: id,
        tipo: "perda",
        quantidade: 3.25,
        motivo: "Quebrou tudo",
      }),
    ).toEqual({ ok: false, motivo: "saldo_insuficiente" });
    expect(
      (
        await lancarSaida(servico(), confirmado(enf), {
          loteId: id,
          tipo: "perda",
          quantidade: 3,
          motivo: "Quebrou tudo",
        })
      ).ok,
    ).toBe(true);
    expect(await saldo(id)).toBe(0);
  });

  it("pede a senha de novo: sem confirmação recente nada muda", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const pedido = {
      loteId: id,
      tipo: "perda" as const,
      quantidade: 1,
      motivo: "Teste de reautenticação",
    };
    await expect(
      lancarSaida(servico(), { ...enf, reautenticadoEm: null }, pedido),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    await expect(
      lancarSaida(
        servico(),
        { ...enf, reautenticadoEm: new Date(agora.getTime() - 5 * 60_000 - 1) },
        pedido,
      ),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    // Confirmação "do futuro" (relógio errado) também não vale.
    await expect(
      lancarSaida(
        servico(),
        { ...enf, reautenticadoEm: new Date(agora.getTime() + 60_000) },
        pedido,
      ),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    expect(await saldo(id)).toBe(10);
    expect(
      (
        await lancarSaida(
          servico(),
          { ...enf, reautenticadoEm: new Date(agora.getTime() - 4 * 60_000) },
          pedido,
        )
      ).ok,
    ).toBe(true);
  });

  it("cuidador não lança saída, nem confirmado", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    await expect(
      lancarSaida(servico(), confirmado(cuidador), {
        loteId: id,
        tipo: "perda",
        quantidade: 1,
        motivo: "Quebrou",
      }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    expect(await saldo(id)).toBe(10);
  });

  it("recusa motivo curto, tipo inventado e combinações sem sentido, sem tocar no saldo", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const e = confirmado(enf);
    const invalido = (r: Awaited<ReturnType<typeof lancarSaida>>) =>
      expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    invalido(
      await lancarSaida(servico(), e, { loteId: id, tipo: "perda", quantidade: 1, motivo: "ab" }),
    );
    invalido(
      await lancarSaida(servico(), e, { loteId: id, tipo: "perda", quantidade: 1, motivo: "   " }),
    );
    invalido(
      await lancarSaida(servico(), e, {
        loteId: id,
        tipo: "consumo" as never,
        quantidade: 1,
        motivo: "Fraude",
      }),
    );
    invalido(
      await lancarSaida(servico(), e, {
        loteId: id,
        tipo: "perda",
        descartarTudo: true,
        motivo: "Perdeu tudo",
      }),
    );
    invalido(
      await lancarSaida(servico(), e, {
        loteId: id,
        tipo: "descarte",
        descartarTudo: true,
        quantidade: 3,
        motivo: "Descartar",
      }),
    );
    invalido(
      await lancarSaida(servico(), e, { loteId: id, tipo: "perda", motivo: "Sem quantidade" }),
    );
    invalido(
      await lancarSaida(servico(), e, {
        loteId: id,
        tipo: "perda",
        quantidade: -1,
        motivo: "Negativa",
      }),
    );
    invalido(
      await lancarSaida(servico(), e, {
        loteId: id,
        tipo: "perda",
        quantidade: 0.3,
        motivo: "Fração estranha",
      }),
    );
    expect(await saldo(id)).toBe(10);
  });

  it("lote de outra casa ou inexistente não é encontrado, e nada muda", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const pedido = { tipo: "perda" as const, quantidade: 1, motivo: "Invasão" };
    expect(await lancarSaida(servico(), confirmado(enfB), { loteId: id, ...pedido })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(
      await lancarSaida(servico(), confirmado(enf), {
        loteId: "00000000-0000-4000-8000-000000000004",
        ...pedido,
      }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await saldo(id)).toBe(10);
  });

  it("oito perdas simultâneas de uma unidade num lote de cinco: cinco passam e as outras são recusadas", async () => {
    const id = await entrarLote(servico(), enf, med, 5);
    const r = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        lancarSaida(servico(), confirmado(i % 2 ? gestor : enf), {
          loteId: id,
          tipo: "perda",
          quantidade: 1,
          motivo: "Corrida de teste",
        }),
      ),
    );
    expect(r.filter((x) => x.ok)).toHaveLength(5);
    expect(r.filter((x) => !x.ok && x.motivo === "saldo_insuficiente")).toHaveLength(3);
    expect(await saldo(id)).toBe(0);
  });
});

describe("etiqueta", () => {
  it("a primeira impressão e as reimpressões ficam registradas, com o mesmo código", async () => {
    const idoso = await novoIdoso(servico(), enf, "Seu Almir");
    const id = await entrarLote(servico(), enf, med, 30, {
      idosoId: idoso,
      numeroLote: "ET-1",
      validade: "2028-02-29",
    });
    const primeira = await emitirEtiqueta(servico(), enf, { loteId: id });
    const segunda = await emitirEtiqueta(servico(), gestor, { loteId: id });
    if (!primeira.ok || !segunda.ok) throw new Error("etiqueta");
    expect(primeira.etiqueta).toMatchObject({
      numeroLote: "ET-1",
      validade: "2028-02-29",
      quantidade: 30,
      unidade: "comprimido",
      destino: "Seu Almir",
      reimpressao: false,
    });
    expect(segunda.etiqueta.reimpressao).toBe(true);
    expect(segunda.etiqueta.codigo).toBe(primeira.etiqueta.codigo);
    expect(primeira.etiqueta.codigo).toMatch(/^[A-HJKMNP-Z2-9]{20}$/);
    expect(await acoesDeAuditoria(app, casaA, id)).toEqual([
      "estoque.entrada",
      "estoque.etiqueta_impressa",
      "estoque.etiqueta_reimpressa",
    ]);
    const impressoes = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{ usuario_id: string; reimpressao: boolean }>(
        "SELECT usuario_id, reimpressao FROM impressao_etiqueta WHERE lote_id = $1 ORDER BY seq",
        [id],
      );
      return r.rows;
    });
    expect(impressoes).toEqual([
      { usuario_id: enf.usuarioId, reimpressao: false },
      { usuario_id: gestor.usuarioId, reimpressao: true },
    ]);
    // O código do QR nunca vai para a auditoria.
    const auditoria = await comContexto(app, { casaId: casaA }, async (c) =>
      JSON.stringify((await c.query("SELECT antes, depois FROM auditoria")).rows),
    );
    expect(auditoria).not.toContain(primeira.etiqueta.codigo);
  });

  it("a etiqueta do estoque comum não leva nome de idoso", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    const r = await emitirEtiqueta(servico(), enf, { loteId: id });
    expect(r.ok && r.etiqueta.destino).toBeNull();
  });

  it("lote inexistente ou de outra casa não é encontrado e não deixa rastro de impressão", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    expect(await emitirEtiqueta(servico(), enfB, { loteId: id })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(
      await emitirEtiqueta(servico(), enf, { loteId: "00000000-0000-4000-8000-000000000005" }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    await comContexto(app, { casaId: casaA }, async (c) => {
      expect(
        (await c.query("SELECT 1 FROM impressao_etiqueta WHERE lote_id = $1", [id])).rowCount,
      ).toBe(0);
    });
  });

  it("cuidador não imprime etiqueta", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    await expect(emitirEtiqueta(servico(), cuidador, { loteId: id })).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
  });
});

describe("listagem e detalhe de lotes", () => {
  it("lista só lotes com saldo por padrão, em ordem de validade, e traz a situação da validade", async () => {
    const m = await novoMedicamento(servico(), enf);
    const longe = await entrarLote(servico(), enf, m, 5, { validade: "2030-01-01" });
    const perto = await entrarLote(servico(), enf, m, 5, { validade: "2026-03-15" });
    const hoje = await entrarLote(servico(), enf, m, 5, { validade: "2026-03-10" });
    const zerado = await entrarLote(servico(), enf, m, 2, { validade: "2029-01-01" });
    await consumirDoLote(app, casaA, enf.usuarioId, zerado, 2);

    const lista = await listarLotes(servico(), enf, { medicamentoId: m });
    expect(lista.map((l) => l.id)).toEqual([hoje, perto, longe]);
    expect(lista.map((l) => l.situacaoDeValidade)).toEqual(["urgente", "urgente", "ok"]);
    const todos = await listarLotes(servico(), enf, { medicamentoId: m, incluirZerados: true });
    expect(todos.map((l) => l.id)).toContain(zerado);
    expect(todos.find((l) => l.id === zerado)?.saldo).toBe(0);
  });

  it("filtra por idoso, por destino e por vencimento (incluindo o que já venceu)", async () => {
    const m = await novoMedicamento(servico(), enf);
    const ana = await novoIdoso(servico(), enf);
    const individual = await entrarLote(servico(), enf, m, 5, {
      idosoId: ana,
      validade: "2030-01-01",
    });
    const comum = await entrarLote(servico(), enf, m, 5, { validade: "2026-03-20" });
    expect(
      (await listarLotes(servico(), enf, { medicamentoId: m, idosoId: ana })).map((l) => l.id),
    ).toEqual([individual]);
    expect(
      (await listarLotes(servico(), enf, { medicamentoId: m, destino: "individual" })).map(
        (l) => l.id,
      ),
    ).toEqual([individual]);
    expect(
      (await listarLotes(servico(), enf, { medicamentoId: m, destino: "comum" })).map((l) => l.id),
    ).toEqual([comum]);
    expect(
      (await listarLotes(servico(), enf, { medicamentoId: m, venceEmDias: 10 })).map((l) => l.id),
    ).toEqual([comum]);
    expect(
      (await listarLotes(servico(), enf, { medicamentoId: m, venceEmDias: 9 })).map((l) => l.id),
    ).toEqual([]);
    // Depois que vence, continua aparecendo no filtro de vencimento.
    agora = T("2026-03-25T10:00:00Z");
    try {
      const vencidos = await listarLotes(servico(), enf, { medicamentoId: m, venceEmDias: 0 });
      expect(vencidos.map((l) => [l.id, l.situacaoDeValidade])).toEqual([[comum, "vencido"]]);
    } finally {
      agora = T("2026-03-10T10:00:00Z");
    }
  });

  it("não lista lote de outra casa, e o detalhe dele não existe", async () => {
    const idB = await entrarLote(servico(), enfB, medB, 7);
    expect(
      (await listarLotes(servico(), enf, { incluirZerados: true })).some((l) => l.id === idB),
    ).toBe(false);
    expect(await obterLote(servico(), enf, idB)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect((await listarLotes(servico(), enfB)).some((l) => l.id === idB)).toBe(true);
  });

  it("o detalhe traz os movimentos em ordem, com quem fez cada um", async () => {
    const id = await entrarLote(servico(), enf, med, 10);
    agora = T("2026-03-10T11:00:00Z");
    await lancarSaida(servico(), confirmado(gestor), {
      loteId: id,
      tipo: "perda",
      quantidade: 1,
      motivo: "Quebrou",
    });
    agora = T("2026-03-10T12:00:00Z");
    await emitirEtiqueta(servico(), enf, { loteId: id });
    const r = await obterLote(servico(), enf, id);
    agora = T("2026-03-10T10:00:00Z");
    if (!r.ok) throw new Error("lote");
    expect(r.lote.movimentos.map((m) => [m.tipo, m.quantidade, m.usuarioId])).toEqual([
      ["entrada", 10, enf.usuarioId],
      ["perda", -1, gestor.usuarioId],
    ]);
    expect(r.lote.movimentos[0]?.usuarioNome).toBe(enf.usuario.nome);
    expect(r.lote.etiquetasImpressas).toBe(1);
    expect(r.lote.saldo).toBe(9);
  });

  it("cuidador não consulta estoque", async () => {
    await expect(listarLotes(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      obterLote(servico(), cuidador, "00000000-0000-4000-8000-000000000006"),
    ).rejects.toBeInstanceOf(ErroDePermissao);
  });
});
