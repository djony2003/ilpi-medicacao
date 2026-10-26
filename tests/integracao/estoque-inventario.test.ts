import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelarInventario,
  concluirInventario,
  iniciarInventario,
  listarInventarios,
  obterInventario,
  registrarContagem,
} from "@/modules/estoque";
import { ErroDePermissao, ErroDeReautenticacao, type Servico } from "@/modules/identidade";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import {
  acoesDeAuditoria,
  consumirDoLote,
  entrarLote,
  movimentosDoLote,
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
let enfB: AtorWeb;
let cuidador: AtorTablet;
let agora: Date;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const T = (iso: string) => new Date(iso);
const confirmado = <A extends { reautenticadoEm: Date | null }>(a: A): A => ({
  ...a,
  reautenticadoEm: agora,
});
const saldo = (loteId: string) => saldoDoLote(app, casaA, loteId);

/** Cada teste começa sem inventário aberto, para não depender dos anteriores. */
async function fecharInventarios() {
  const lista = await listarInventarios(servico(), enf);
  for (const i of lista.filter((x) => x.status === "aberto")) {
    await cancelarInventario(servico(), enf, { inventarioId: i.id });
  }
}

async function abrir() {
  const r = await iniciarInventario(servico(), enf);
  if (!r.ok) throw new Error(`iniciar: ${r.motivo}`);
  return r;
}

async function contar(inv: string, lote: string, contado: number) {
  const r = await registrarContagem(servico(), enf, { inventarioId: inv, loteId: lote, contado });
  if (!r.ok) throw new Error(`contar: ${r.motivo}`);
  return r;
}

async function inventario(inv: string, ator: AtorWeb = enf) {
  const r = await obterInventario(servico(), ator, inv);
  if (!r.ok) throw new Error("inventario");
  return r.inventario;
}

/** Casa isolada para o teste: todo lote com saldo entra no inventário. */
beforeAll(async () => {
  app = criarPoolApp(8);
  migrador = criarPoolMigrador();
  casaB = await criarCasa(migrador, "Casa B Inventário");
});

/** Uma casa nova por teste: o inventário abrange todos os lotes da casa, então ela não pode ter sobras. */
beforeEach(async () => {
  agora = T("2026-03-10T10:00:00Z");
  casaA = await criarCasa(migrador, "Casa A Inventário");
  enf = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
  enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
  cuidador = await criarAtorTablet(servico, migrador, casaA);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("abrir o inventário", () => {
  it("sem nenhum lote com saldo, não há o que contar", async () => {
    await fecharInventarios();
    expect(await iniciarInventario(servico(), enf)).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
  });

  it("entram todos os lotes com saldo (vencidos também) e nenhum esgotado", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const b = await entrarLote(servico(), enf, m, 5, { validade: "2026-03-11" });
    const zerado = await entrarLote(servico(), enf, m, 2);
    await consumirDoLote(app, casaA, enf.usuarioId, zerado, 2);
    agora = T("2026-03-20T10:00:00Z"); // b já venceu
    try {
      const r = await abrir();
      const inv = await inventario(r.inventarioId);
      expect(inv.status).toBe("aberto");
      expect(inv.itens.map((i) => i.loteId).sort()).toEqual([a, b].sort());
      expect(inv.itens.find((i) => i.loteId === zerado)).toBeUndefined();
      expect(inv.resumo).toMatchObject({ contados: 0, comDivergencia: 0 });
      for (const i of inv.itens) {
        expect([i.esperado, i.contado, i.divergencia]).toEqual([null, null, null]);
      }
      expect(await acoesDeAuditoria(app, casaA, r.inventarioId)).toEqual([
        "estoque.inventario_iniciado",
      ]);
    } finally {
      agora = T("2026-03-10T10:00:00Z");
      await fecharInventarios();
    }
  });

  it("só pode haver um inventário aberto; depois de fechado, outro pode começar", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 10);
    const primeiro = await abrir();
    expect(await iniciarInventario(servico(), enf)).toEqual({
      ok: false,
      motivo: "inventario_aberto",
    });
    expect(
      (await cancelarInventario(servico(), enf, { inventarioId: primeiro.inventarioId })).ok,
    ).toBe(true);
    const segundo = await iniciarInventario(servico(), enf);
    expect(segundo.ok).toBe(true);
    await fecharInventarios();
  });

  it("duas aberturas simultâneas: só uma vale", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 10);
    const r = await Promise.all([
      iniciarInventario(servico(), enf),
      iniciarInventario(servico(), enf),
      iniciarInventario(servico(), enf),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok && x.motivo === "inventario_aberto")).toHaveLength(2);
    await fecharInventarios();
  });
});

describe("contagem", () => {
  it("guarda o saldo do sistema no instante da contagem e aponta a divergência", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const b = await entrarLote(servico(), enf, m, 5);
    const { inventarioId } = await abrir();
    expect(await contar(inventarioId, a, 8)).toEqual({
      ok: true,
      esperado: 10,
      contado: 8,
      divergencia: -2,
    });
    expect(await contar(inventarioId, b, 5.5)).toEqual({
      ok: true,
      esperado: 5,
      contado: 5.5,
      divergencia: 0.5,
    });
    const inv = await inventario(inventarioId);
    const item = (id: string) => inv.itens.find((i) => i.loteId === id);
    expect(item(a)).toMatchObject({ esperado: 10, contado: 8, divergencia: -2, saldoAtual: 10 });
    expect(item(b)).toMatchObject({ contado: 5.5, divergencia: 0.5 });
    expect(inv.resumo).toMatchObject({ contados: 2, comDivergencia: 2 });
    // Contar não mexe no saldo: só o fechamento lança ajuste.
    expect(await saldo(a)).toBe(10);
    await fecharInventarios();
  });

  it("pode recontar, e zero é uma contagem válida", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 7);
    expect((await contar(inventarioId, a, 0)).divergencia).toBe(-10);
    expect((await contar(inventarioId, a, 10)).divergencia).toBe(0);
    expect((await inventario(inventarioId)).itens.find((i) => i.loteId === a)?.contado).toBe(10);
    await fecharInventarios();
  });

  it("recusa contagem inválida, de lote fora do inventário, de inventário alheio ou já fechado", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const { inventarioId } = await abrir();
    const depois = await entrarLote(servico(), enf, m, 4); // chegou depois da abertura
    const tenta = (inv: string, lote: string, contado: number, ator: AtorWeb = enf) =>
      registrarContagem(servico(), ator, { inventarioId: inv, loteId: lote, contado });
    expect(await tenta(inventarioId, a, 5.3)).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
    expect(await tenta(inventarioId, a, -1)).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
    expect(await tenta(inventarioId, a, Number.NaN)).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
    expect(await tenta(inventarioId, depois, 4)).toEqual({
      ok: false,
      motivo: "lote_fora_do_inventario",
    });
    expect(await tenta("00000000-0000-4000-8000-000000000007", a, 1)).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(await tenta(inventarioId, a, 1, enfB)).toEqual({ ok: false, motivo: "nao_encontrado" });
    await cancelarInventario(servico(), enf, { inventarioId });
    expect(await tenta(inventarioId, a, 10)).toEqual({ ok: false, motivo: "inventario_encerrado" });
    expect((await inventario(inventarioId)).itens.every((i) => i.contado === null)).toBe(true);
  });

  it("o consumo que acontece durante a contagem não vira divergência, e não é apagado no fechamento", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 8); // esperado 10 na hora da contagem
    await consumirDoLote(app, casaA, enf.usuarioId, a, 1); // alguém administra depois de contado
    expect((await inventario(inventarioId)).itens[0]).toMatchObject({
      esperado: 10,
      contado: 8,
      divergencia: -2,
      saldoAtual: 9,
    });
    const fim = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas: { [a]: "Dois comprimidos a menos na prateleira" },
    });
    expect(fim).toEqual({ ok: true, ajustes: 1, naoContados: 0 });
    // 10 − 1 (consumo) − 2 (divergência) = 7, e não "8 igual ao contado".
    expect(await saldo(a)).toBe(7);
  });

  it("cuidador não conta, e uma casa não conta o inventário da outra", async () => {
    await expect(
      registrarContagem(servico(), cuidador, {
        inventarioId: "00000000-0000-4000-8000-000000000008",
        loteId: "00000000-0000-4000-8000-000000000009",
        contado: 1,
      }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
  });
});

describe("concluir o inventário", () => {
  it("cada divergência vira um ajuste justificado, ligado ao inventário e à auditoria", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const b = await entrarLote(servico(), enf, m, 5);
    const c = await entrarLote(servico(), enf, m, 7);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 8);
    await contar(inventarioId, b, 5.5);
    await contar(inventarioId, c, 7); // sem divergência
    const fim = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas: {
        [a]: "  Dois comprimidos a menos  ",
        [b]: "Meio comprimido a mais na caixa",
        [c]: "não usada",
      },
    });
    expect(fim).toEqual({ ok: true, ajustes: 2, naoContados: 0 });
    expect(await saldo(a)).toBe(8);
    expect(await saldo(b)).toBe(5.5);
    expect(await saldo(c)).toBe(7);
    expect((await movimentosDoLote(app, casaA, a)).at(-1)).toEqual({
      tipo: "ajuste",
      quantidade: -2,
      motivo: "Dois comprimidos a menos",
      parId: null,
    });
    expect((await movimentosDoLote(app, casaA, c)).map((x) => x.tipo)).toEqual(["entrada"]);

    const inv = await inventario(inventarioId);
    expect(inv.status).toBe("concluido");
    expect(inv.encerradoEm).toBe(agora.toISOString());
    expect(inv.itens.find((i) => i.loteId === a)).toMatchObject({
      justificativa: "Dois comprimidos a menos",
    });
    expect(inv.itens.find((i) => i.loteId === a)?.ajusteId).toBeTruthy();
    expect(inv.itens.find((i) => i.loteId === c)?.ajusteId).toBeNull();
    expect(await acoesDeAuditoria(app, casaA, a)).toContain("estoque.ajuste");
    expect(await acoesDeAuditoria(app, casaA, inventarioId)).toEqual([
      "estoque.inventario_iniciado",
      "estoque.inventario_contagem",
      "estoque.inventario_contagem",
      "estoque.inventario_contagem",
      "estoque.inventario_concluido",
    ]);
    // Depois de concluído, não se conta nem se conclui de novo.
    expect(
      await registrarContagem(servico(), enf, { inventarioId, loteId: a, contado: 1 }),
    ).toEqual({ ok: false, motivo: "inventario_encerrado" });
    expect(
      await concluirInventario(servico(), confirmado(enf), { inventarioId, justificativas: {} }),
    ).toEqual({ ok: false, motivo: "inventario_encerrado" });
    expect(await cancelarInventario(servico(), enf, { inventarioId })).toEqual({
      ok: false,
      motivo: "inventario_encerrado",
    });
  });

  it("sem justificativa para alguma divergência, nada é lançado e o inventário continua aberto", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const b = await entrarLote(servico(), enf, m, 5);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 8);
    await contar(inventarioId, b, 4);
    const r = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas: { [a]: "Dois a menos", [b]: "ab" }, // a de b é curta demais
    });
    expect(r).toEqual({ ok: false, motivo: "justificativa_faltando", lotes: [b] });
    expect(await saldo(a)).toBe(10);
    expect(await saldo(b)).toBe(5);
    expect((await inventario(inventarioId)).status).toBe("aberto");
    const semNada = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas: {},
    });
    expect(semNada).toMatchObject({ ok: false, motivo: "justificativa_faltando" });
    expect((semNada as { lotes: string[] }).lotes.sort()).toEqual([a, b].sort());
    // Justificativa de lote sem divergência é ignorada, e a que vale basta.
    await fecharInventarios();
  });

  it("lote sem contagem trava o fechamento, a menos que a equipe aceite deixá-lo de fora", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const b = await entrarLote(servico(), enf, m, 5);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 9);
    const justificativas = { [a]: "Um comprimido a menos" };
    const pendente = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas,
    });
    expect(pendente).toMatchObject({ ok: false, motivo: "itens_sem_contagem" });
    expect((pendente as { lotes: string[] }).lotes).toContain(b);
    expect((await inventario(inventarioId)).status).toBe("aberto");
    const fim = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas,
      aceitarNaoContados: true,
    });
    expect(fim.ok && fim.naoContados).toBeGreaterThanOrEqual(1);
    expect(await saldo(a)).toBe(9);
    expect(await saldo(b)).toBe(5);
  });

  it("pede a senha de novo para concluir", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 9);
    const pedido = {
      inventarioId,
      justificativas: { [a]: "Um a menos" },
      aceitarNaoContados: true,
    };
    await expect(
      concluirInventario(servico(), { ...enf, reautenticadoEm: null }, pedido),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    await expect(concluirInventario(servico(), cuidador, pedido)).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
    expect(await saldo(a)).toBe(10);
    expect((await inventario(inventarioId)).status).toBe("aberto");
    await fecharInventarios();
  });

  it("se o saldo mudou e o ajuste não cabe mais, nada é aplicado e a equipe precisa recontar", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const b = await entrarLote(servico(), enf, m, 5);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 0); // esperado 10 → ajuste de −10
    await contar(inventarioId, b, 4); // esperado 5 → ajuste de −1
    await consumirDoLote(app, casaA, enf.usuarioId, a, 6); // agora só restam 4
    const r = await concluirInventario(servico(), confirmado(enf), {
      inventarioId,
      justificativas: { [a]: "Prateleira vazia", [b]: "Um a menos" },
      aceitarNaoContados: true,
    });
    expect(r).toEqual({ ok: false, motivo: "saldo_insuficiente" });
    expect(await saldo(a)).toBe(4);
    expect(await saldo(b)).toBe(5); // o ajuste de b também foi desfeito
    expect((await inventario(inventarioId)).status).toBe("aberto");
    await fecharInventarios();
  });

  it("inventário de outra casa ou inexistente não se conclui nem se cancela", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    await entrarLote(servico(), enf, m, 10);
    const { inventarioId } = await abrir();
    const inexistente = "00000000-0000-4000-8000-00000000000a";
    for (const id of [inventarioId, inexistente]) {
      expect(
        await concluirInventario(servico(), confirmado(enfB), {
          inventarioId: id,
          justificativas: {},
        }),
      ).toEqual({ ok: false, motivo: "nao_encontrado" });
      expect(await cancelarInventario(servico(), enfB, { inventarioId: id })).toEqual({
        ok: false,
        motivo: "nao_encontrado",
      });
      expect(await obterInventario(servico(), enfB, id)).toEqual({
        ok: false,
        motivo: "nao_encontrado",
      });
    }
    expect((await inventario(inventarioId)).status).toBe("aberto");
    expect((await listarInventarios(servico(), enfB)).some((i) => i.id === inventarioId)).toBe(
      false,
    );
    await fecharInventarios();
  });

  it("cancelar deixa o estoque como estava, mas guarda o que foi contado", async () => {
    await fecharInventarios();
    const m = await novoMedicamento(servico(), enf);
    const a = await entrarLote(servico(), enf, m, 10);
    const { inventarioId } = await abrir();
    await contar(inventarioId, a, 3);
    expect((await cancelarInventario(servico(), enf, { inventarioId })).ok).toBe(true);
    expect(await saldo(a)).toBe(10);
    const inv = await inventario(inventarioId);
    expect(inv.status).toBe("cancelado");
    expect(inv.itens.find((i) => i.loteId === a)?.contado).toBe(3);
    expect(await acoesDeAuditoria(app, casaA, inventarioId)).toContain(
      "estoque.inventario_cancelado",
    );
  });

  it("cuidador não abre, não vê e não cancela inventário", async () => {
    await expect(iniciarInventario(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(listarInventarios(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      obterInventario(servico(), cuidador, "00000000-0000-4000-8000-00000000000b"),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      cancelarInventario(servico(), cuidador, {
        inventarioId: "00000000-0000-4000-8000-00000000000b",
      }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
  });
});
