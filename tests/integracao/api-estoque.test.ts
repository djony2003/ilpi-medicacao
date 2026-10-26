import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsQR from "jsqr";
import type pg from "pg";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cifrar } from "@/compartilhado/criptografia";
import { lerPayloadQr } from "@/compartilhado/qr";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let outraCasa: string;
let enf: Navegador; // com a senha confirmada
let enfSemSenha: Navegador; // sem reautenticar
let tablet: Navegador;
let gestorDeOutraCasa: Navegador;
let semSessao: Navegador;
let medicamentoId: string;
let idosoId: string;

async function logar(casaId: string, perfil: "enfermeiro" | "gestor", confirmarSenha: boolean) {
  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casaId, {
    perfil,
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  const api = criarApi({ servico: () => servicoAtual(), producao: false });
  const nav = new Navegador(api);
  await entrarNaApi(nav, u.email ?? "", segredo, { confirmarSenha });
  return { nav, email: u.email ?? "", segredo };
}

const servicoAtual = (): Servico => ({ pool: app, chaveCampos: CHAVE });

function comPdf<T>(pdf: Uint8Array, fn: (arquivo: string, pasta: string) => T): T {
  const pasta = mkdtempSync(join(tmpdir(), "api-estoque-"));
  try {
    const arquivo = join(pasta, "p.pdf");
    writeFileSync(arquivo, pdf);
    return fn(arquivo, pasta);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}
const textoDoPdf = (pdf: Uint8Array) =>
  comPdf(pdf, (a) => execFileSync("pdftotext", ["-layout", a, "-"], { encoding: "utf8" }));
const qrDoPdf = (pdf: Uint8Array) =>
  comPdf(pdf, (arq, pasta) => {
    execFileSync("pdftoppm", [
      "-r",
      "300",
      "-png",
      "-f",
      "1",
      "-l",
      "1",
      "-singlefile",
      arq,
      join(pasta, "q"),
    ]);
    const png = PNG.sync.read(readFileSync(join(pasta, "q.png")));
    return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
  });

const novoLote = async (nav: Navegador, extra: Record<string, unknown> = {}) => {
  const r = await nav.post("/estoque/lotes", {
    medicamentoId,
    numeroLote: `API-${Math.random().toString(36).slice(2, 8)}`,
    validade: "2030-01-31",
    unidade: "comprimido",
    quantidade: 30,
    ...extra,
  });
  expect(r.status, JSON.stringify(r.corpo)).toBe(201);
  return String(r.corpo.loteId);
};

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  casa = await criarCasa(migrador, "Casa da API de estoque");
  outraCasa = await criarCasa(migrador, "Outra casa da API de estoque");
  const api = criarApi({ servico: servicoAtual, producao: false });

  const e = await logar(casa, "enfermeiro", true);
  enf = e.nav;
  enfSemSenha = (await logar(casa, "enfermeiro", false)).nav; // senha não confirmada
  gestorDeOutraCasa = (await logar(outraCasa, "gestor", true)).nav;
  semSessao = new Navegador(api);

  const g = await logar(casa, "gestor", true);
  const aparelho = await g.nav.post("/admin/dispositivos", { nome: "Tablet estoque" });
  tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(aparelho.corpo.codigo) });
  const c = await criarUsuario(migrador, casa, { perfil: "cuidador", pin: "846201" });
  await tablet.post("/tablet/entrar", { usuarioId: c.id, pin: "846201" });

  const m = await enf.post("/medicamentos", {
    nomeComercial: "Remedio da API de Estoque",
    principioAtivo: "SubstanciaApiEstoque",
    concentracao: "25 mg",
    forma: "comprimido",
  });
  medicamentoId = String(m.corpo.medicamentoId);
  const i = await enf.post("/idosos", {
    nome: "Dona Estoque da API",
    dataNascimento: "1938-02-02",
    alergias: [],
  });
  idosoId = String(i.corpo.idosoId);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("API do estoque: lotes", () => {
  it("registra a entrada, lista, detalha e nunca devolve o código do QR", async () => {
    const id = await novoLote(enf, { numeroLote: "API-DETALHE", quantidade: 12 });
    const lista = await enf.get(`/estoque/lotes?medicamentoId=${medicamentoId}`);
    expect(lista.status).toBe(200);
    expect(lista.cabecalhos.get("cache-control")).toBe("no-store");
    const lotes = (lista.corpo as { lotes: Array<{ id: string; saldo: number }> }).lotes;
    expect(lotes.find((l) => l.id === id)?.saldo).toBe(12);

    const d = await enf.get(`/estoque/lotes/${id}`);
    expect(d.status).toBe(200);
    const lote = (d.corpo as { lote: Record<string, unknown> }).lote;
    expect(lote).toMatchObject({ numeroLote: "API-DETALHE", saldo: 12, quantidadeInicial: 12 });
    expect((lote.movimentos as unknown[]).length).toBe(1);
    expect(JSON.stringify(d.corpo).toLowerCase()).not.toContain("codigoqr");
    expect(JSON.stringify(d.corpo)).not.toContain("ILPI:L:");
  });

  it("recusa entrada inválida com a falha certa", async () => {
    const base = {
      medicamentoId,
      numeroLote: "X1",
      validade: "2030-01-31",
      unidade: "comprimido",
      quantidade: 5,
    };
    expect((await enf.post("/estoque/lotes", { ...base, quantidade: 5.3 })).status).toBe(400);
    expect(
      (
        await enf.post("/estoque/lotes", {
          ...base,
          medicamentoId: "00000000-0000-4000-8000-0000000000bb",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await enf.post("/estoque/lotes", {
          ...base,
          idosoId: "00000000-0000-4000-8000-0000000000bb",
        })
      ).status,
    ).toBe(422);
    expect((await enf.post("/estoque/lotes", { ...base, extra: 1 })).status).toBe(400);
    expect((await enf.get("/estoque/lotes?medicamentoId=nao-e-uuid")).status).toBe(400);
    expect((await enf.get("/estoque/lotes?destino=qualquer")).status).toBe(400);
    expect((await enf.get("/estoque/lotes?venceEmDias=-3")).status).toBe(400);
  });

  it("fraciona para um idoso e o lote filho aparece como estoque individual", async () => {
    const id = await novoLote(enf, { quantidade: 20 });
    const r = await enf.post(`/estoque/lotes/${id}/fracionar`, {
      quantidade: 8,
      destinoIdosoId: idosoId,
    });
    expect(r.status).toBe(201);
    const filho = String(r.corpo.loteId);
    const lista = (await enf.get(`/estoque/lotes?idosoId=${idosoId}`)).corpo as {
      lotes: Array<{
        id: string;
        saldo: number;
        origemId: string | null;
        idosoNome: string | null;
      }>;
    };
    expect(lista.lotes.find((l) => l.id === filho)).toMatchObject({
      saldo: 8,
      origemId: id,
      idosoNome: "Dona Estoque da API",
    });
    expect(
      ((await enf.get(`/estoque/lotes/${id}`)).corpo as { lote: { saldo: number } }).lote.saldo,
    ).toBe(12);
    expect((await enf.post(`/estoque/lotes/${id}/fracionar`, { quantidade: 99 })).status).toBe(409);
  });
});

describe("API do estoque: etiqueta", () => {
  it("devolve um PDF com uma página por cópia, cujo QR é o código do lote, e registra a impressão", async () => {
    const id = await novoLote(enf, { numeroLote: "API-ETIQ" });
    const r = await enf.post(`/estoque/lotes/${id}/etiqueta`, { copias: 2 });
    expect(r.status).toBe(200);
    expect(r.cabecalhos.get("content-type")).toBe("application/pdf");
    expect(r.cabecalhos.get("cache-control")).toBe("no-store");
    expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const texto = textoDoPdf(r.bytes);
    expect(texto).toContain("API-ETIQ");
    expect(texto).toContain("Remedio da API de Estoque");
    const leitura = qrDoPdf(r.bytes);
    expect(leitura).not.toBeNull();
    const payload = lerPayloadQr(leitura ?? "");
    expect(payload).toMatchObject({ tipo: "lote" });

    const de = await enf.get(`/estoque/lotes/${id}`);
    expect((de.corpo as { lote: { etiquetasImpressas: number } }).lote.etiquetasImpressas).toBe(1);
    const segunda = await enf.post(`/estoque/lotes/${id}/etiqueta`, {});
    expect(textoDoPdf(segunda.bytes)).toContain("reimpressão");
    expect((await enf.post(`/estoque/lotes/${id}/etiqueta`, { copias: 99 })).status).toBe(400);
  });
});

describe("API do estoque: saídas", () => {
  it("perda, descarte e ajuste pedem a senha de novo, e o saldo só muda depois dela", async () => {
    const id = await novoLote(enf, { quantidade: 10 });
    const corpo = { tipo: "perda", quantidade: 2, motivo: "Caiu no chão durante a troca de turno" };
    const sem = await enfSemSenha.post(`/estoque/lotes/${id}/saidas`, corpo);
    expect(sem.status).toBe(403);
    expect(sem.corpo).toEqual({ erro: "reautenticacao_necessaria" });
    expect(
      ((await enf.get(`/estoque/lotes/${id}`)).corpo as { lote: { saldo: number } }).lote.saldo,
    ).toBe(10);

    const com = await enf.post(`/estoque/lotes/${id}/saidas`, corpo);
    expect(com.status).toBe(201);
    expect(com.corpo).toMatchObject({ ok: true, quantidade: -2, saldo: 8 });
  });

  it("recusa motivo curto, quantidade maior que o saldo e tipo desconhecido", async () => {
    const id = await novoLote(enf, { quantidade: 4 });
    expect(
      (
        await enf.post(`/estoque/lotes/${id}/saidas`, {
          tipo: "perda",
          quantidade: 1,
          motivo: "ab",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await enf.post(`/estoque/lotes/${id}/saidas`, {
          tipo: "perda",
          quantidade: 9,
          motivo: "Quebraram na caixa inteira",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await enf.post(`/estoque/lotes/${id}/saidas`, {
          tipo: "consumo",
          quantidade: 1,
          motivo: "Tentativa de burlar",
        })
      ).status,
    ).toBe(400);
    const tudo = await enf.post(`/estoque/lotes/${id}/saidas`, {
      tipo: "descarte",
      descartarTudo: true,
      motivo: "Lote recolhido pelo fabricante",
    });
    expect(tudo.status).toBe(201);
    expect(tudo.corpo).toMatchObject({ quantidade: -4, saldo: 0 });
  });
});

describe("API do estoque: situação, reposição e sobras", () => {
  it("responde a situação com previsão e traz o lote que acabou de entrar", async () => {
    const m = String(
      (
        await enf.post("/medicamentos", {
          nomeComercial: "Situacao API",
          principioAtivo: "SubstanciaSituacaoApi",
          forma: "comprimido",
        })
      ).corpo.medicamentoId,
    );
    await novoLote(enf, { medicamentoId: m, quantidade: 6 });
    const r = await enf.get(`/estoque/situacao?medicamentoId=${m}`);
    expect(r.status).toBe(200);
    expect(r.cabecalhos.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(r.corpo)).toContain("Situacao API");
    expect((await enf.get("/estoque/sobras")).status).toBe(200);
  });

  it("emite a lista de reposição em JSON e em PDF, validando os parâmetros", async () => {
    const json = await enf.post("/estoque/lista-de-reposicao", {
      coberturaDias: 30,
      diasParaRepor: 7,
    });
    expect(json.status).toBe(200);
    expect(json.corpo).toHaveProperty("lista");
    const pdf = await enf.post("/estoque/lista-de-reposicao/pdf", {});
    expect(pdf.status).toBe(200);
    expect(pdf.cabecalhos.get("content-type")).toBe("application/pdf");
    expect(textoDoPdf(pdf.bytes)).toContain("Casa da API de estoque");
    expect((await enf.post("/estoque/lista-de-reposicao", { coberturaDias: 0 })).status).toBe(400);
    expect((await enf.post("/estoque/lista-de-reposicao", { coberturaDias: 30.5 })).status).toBe(
      400,
    );
    expect((await enf.post("/estoque/lista-de-reposicao", { lixo: 1 })).status).toBe(400);
  });
});

describe("API do estoque: inventário", () => {
  it("abre, conta, conclui (com a senha) e deixa o saldo igual ao contado", async () => {
    // Casa dedicada: o inventário reúne todos os lotes da casa.
    const g = await logar(outraCasa, "enfermeiro", true);
    const m = String(
      (
        await g.nav.post("/medicamentos", {
          nomeComercial: "Inventario API",
          principioAtivo: "SubstanciaInventarioApi",
          forma: "comprimido",
        })
      ).corpo.medicamentoId,
    );
    const lote = String(
      (
        await g.nav.post("/estoque/lotes", {
          medicamentoId: m,
          numeroLote: "INV-1",
          validade: "2030-01-31",
          unidade: "comprimido",
          quantidade: 10,
        })
      ).corpo.loteId,
    );
    // Fecha qualquer inventário aberto por outros testes da mesma casa.
    const lista = (await g.nav.get("/estoque/inventarios")).corpo as {
      inventarios: Array<{ id: string; status: string }>;
    };
    for (const i of lista.inventarios.filter((x) => x.status === "aberto")) {
      await g.nav.post(`/estoque/inventarios/${i.id}/cancelar`, {});
    }
    const aberto = await g.nav.post("/estoque/inventarios", {});
    expect(aberto.status).toBe(201);
    const inv = String(aberto.corpo.inventarioId);
    expect((await g.nav.post("/estoque/inventarios", {})).status).toBe(409);

    const contagem = await g.nav.post(`/estoque/inventarios/${inv}/contagens`, {
      loteId: lote,
      contado: 8,
    });
    expect(contagem.status).toBe(200);
    expect(contagem.corpo).toMatchObject({ esperado: 10, contado: 8, divergencia: -2 });
    expect(
      (await g.nav.post(`/estoque/inventarios/${inv}/contagens`, { loteId: lote, contado: 8.3 }))
        .status,
    ).toBe(400);

    const semJust = await g.nav.post(`/estoque/inventarios/${inv}/concluir`, {
      aceitarNaoContados: true,
    });
    expect(semJust.status).toBe(422);
    expect(semJust.corpo).toMatchObject({ erro: "justificativa_faltando" });
    const fim = await g.nav.post(`/estoque/inventarios/${inv}/concluir`, {
      justificativas: { [lote]: "Dois comprimidos a menos na caixa" },
      aceitarNaoContados: true,
    });
    expect(fim.status).toBe(200);
    expect(fim.corpo).toMatchObject({ ok: true, ajustes: 1 });
    expect(
      ((await g.nav.get(`/estoque/lotes/${lote}`)).corpo as { lote: { saldo: number } }).lote.saldo,
    ).toBe(8);
    expect((await g.nav.post(`/estoque/inventarios/${inv}/concluir`, {})).status).toBe(409);
  });

  it("concluir sem a senha confirmada é recusado e nada muda", async () => {
    const e = await logar(outraCasa, "enfermeiro", false);
    const lista = (await e.nav.get("/estoque/inventarios")).corpo as {
      inventarios: Array<{ id: string; status: string }>;
    };
    for (const i of lista.inventarios.filter((x) => x.status === "aberto")) {
      await e.nav.post(`/estoque/inventarios/${i.id}/cancelar`, {});
    }
    const aberto = await e.nav.post("/estoque/inventarios", {});
    expect(aberto.status).toBe(201);
    const inv = String(aberto.corpo.inventarioId);
    const r = await e.nav.post(`/estoque/inventarios/${inv}/concluir`, {
      aceitarNaoContados: true,
    });
    expect(r.status).toBe(403);
    expect(r.corpo).toEqual({ erro: "reautenticacao_necessaria" });
    expect((await e.nav.post(`/estoque/inventarios/${inv}/cancelar`, {})).status).toBe(200);
  });
});

describe("API do estoque: quem pode e o que é de quem", () => {
  it("sem sessão é 401; cuidador no tablet é 403 em todas as rotas do estoque", async () => {
    const alvos: Array<[string, string]> = [
      ["GET", "/estoque/lotes"],
      ["POST", "/estoque/lotes"],
      ["GET", "/estoque/situacao"],
      ["GET", "/estoque/sobras"],
      ["POST", "/estoque/lista-de-reposicao"],
      ["GET", "/estoque/inventarios"],
      ["POST", "/estoque/inventarios"],
    ];
    for (const [metodo, caminho] of alvos) {
      const corpo = metodo === "POST" ? {} : undefined;
      expect(
        (await semSessao.chamar(metodo as "GET" | "POST", caminho, { corpo })).status,
        `${metodo} ${caminho}`,
      ).toBe(401);
      const t = await tablet.chamar(metodo as "GET" | "POST", caminho, { corpo });
      expect(t.status, `${metodo} ${caminho}`).toBe(403);
      expect(t.corpo).toEqual({ erro: "sem_permissao" });
    }
  });

  it("outra casa não alcança lote nem inventário desta (404, sem efeito)", async () => {
    const id = await novoLote(enf, { quantidade: 10 });
    const alheio = (r: Promise<{ status: number }>) => r;
    expect((await alheio(gestorDeOutraCasa.get(`/estoque/lotes/${id}`))).status).toBe(404);
    expect((await gestorDeOutraCasa.post(`/estoque/lotes/${id}/etiqueta`, {})).status).toBe(404);
    expect(
      (await gestorDeOutraCasa.post(`/estoque/lotes/${id}/fracionar`, { quantidade: 1 })).status,
    ).toBe(404);
    expect(
      (
        await gestorDeOutraCasa.post(`/estoque/lotes/${id}/saidas`, {
          tipo: "perda",
          quantidade: 1,
          motivo: "Tentativa de invasão",
        })
      ).status,
    ).toBe(404);
    const lista = (await gestorDeOutraCasa.get("/estoque/lotes")).corpo as {
      lotes: Array<{ id: string }>;
    };
    expect(lista.lotes.some((l) => l.id === id)).toBe(false);
    expect(
      ((await enf.get(`/estoque/lotes/${id}`)).corpo as { lote: { saldo: number } }).lote.saldo,
    ).toBe(10);
  });
});
