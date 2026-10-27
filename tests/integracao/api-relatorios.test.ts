import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cifrar } from "@/compartilhado/criptografia";
import { celulaCsv, montarCsv } from "@/compartilhado/csv";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { cadastrarIdoso } from "@/modules/idosos";
import { criarApi } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";
import { criarAtorWeb } from "../ajudantes/sessoes";

// Auditoria, exceções e exportação do residente pela API (M7).

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let api: (r: Request) => Promise<Response>;
let gestor: Navegador;
let gestorSemSenha: Navegador;
let enf: Navegador;
let idosoId: string;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE });

async function logar(perfil: "enfermeiro" | "gestor", confirmarSenha: boolean) {
  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casa, {
    perfil,
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  const nav = new Navegador(api);
  await entrarNaApi(nav, u.email ?? "", segredo, { confirmarSenha });
  return nav;
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  api = criarApi({ servico, producao: false });
  casa = await criarCasa(migrador, "Casa da API de relatórios");
  gestor = await logar("gestor", true);
  gestorSemSenha = await logar("gestor", false);
  enf = await logar("enfermeiro", true);
  const ator = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
  const r = await cadastrarIdoso(servico(), ator, {
    nome: "Residente da API de relatórios",
    dataNascimento: "1940-05-05",
    cpf: "529.982.247-25",
  });
  if (!r.ok) throw new Error("idoso");
  idosoId = r.idosoId;
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("planilha (CSV)", () => {
  it("protege contra fórmula, aspas, ponto e vírgula e quebra de linha", () => {
    expect(celulaCsv("=1+1")).toBe("'=1+1");
    expect(celulaCsv("@SOMA(A1)")).toBe("'@SOMA(A1)");
    expect(celulaCsv("-2")).toBe("'-2");
    expect(celulaCsv('diz "oi"; tchau')).toBe('"diz ""oi""; tchau"');
    expect(celulaCsv("linha 1\nlinha 2")).toBe('"linha 1\nlinha 2"');
    expect(celulaCsv(42)).toBe("42");
    expect(celulaCsv(null)).toBe("");
    expect(montarCsv(["a", "b"], [[1, "x;y"]])).toBe('﻿a;b\r\n1;"x;y"\r\n');
  });
});

describe("auditoria pela API", () => {
  it("lista com filtros e devolve a página seguinte", async () => {
    const r = await gestor.get("/admin/auditoria?acao=idoso.&limite=1");
    expect(r.status).toBe(200);
    const registros = r.corpo.registros as Array<{ acao: string; seq: number }>;
    expect(registros).toHaveLength(1);
    expect(registros[0]?.acao.startsWith("idoso.")).toBe(true);
    expect(typeof r.corpo.proximaPagina === "number" || r.corpo.proximaPagina === null).toBe(true);
  });

  it("filtro inválido é 400; sem permissão é 403", async () => {
    expect((await gestor.get("/admin/auditoria?de=2026-03-01")).status).toBe(400);
    expect((await gestor.get("/admin/auditoria?usuarioId=x")).status).toBe(400);
    expect((await enf.get("/admin/auditoria")).status).toBe(403);
    expect((await enf.get("/admin/auditoria/verificar")).status).toBe(403);
    expect((await enf.post("/admin/auditoria/exportar", { formato: "csv" })).status).toBe(403);
  });

  it("verifica a cadeia", async () => {
    const r = await gestor.get("/admin/auditoria/verificar");
    expect(r.status).toBe(200);
    expect(r.corpo.verificacao).toMatchObject({ integra: true, problema: null });
  });

  it("exportar exige a senha confirmada e entrega o arquivo para baixar", async () => {
    const negada = await gestorSemSenha.post("/admin/auditoria/exportar", { formato: "csv" });
    expect(negada.status).toBe(403);
    expect(negada.corpo).toEqual({ erro: "reautenticacao_necessaria" });

    const csv = await gestor.post("/admin/auditoria/exportar", { formato: "csv" });
    expect(csv.status).toBe(200);
    expect(csv.cabecalhos.get("content-type")).toContain("text/csv");
    expect(csv.cabecalhos.get("content-disposition")).toContain("attachment");
    expect(csv.cabecalhos.get("cache-control")).toBe("no-store");
    expect(csv.texto.startsWith("﻿Nº;Data e hora;Pessoa")).toBe(true);

    const pdf = await gestor.post("/admin/auditoria/exportar", {
      formato: "pdf",
      filtro: { acao: "idoso." },
    });
    expect(pdf.status).toBe(200);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejeita formato desconhecido e campos a mais", async () => {
    expect((await gestor.post("/admin/auditoria/exportar", { formato: "xls" })).status).toBe(400);
    expect(
      (await gestor.post("/admin/auditoria/exportar", { formato: "csv", extra: 1 })).status,
    ).toBe(400);
  });
});

describe("exceções pela API", () => {
  it("relatório do gestor, período inválido e acesso negado", async () => {
    const r = await gestor.get("/admin/relatorios/excecoes");
    expect(r.status).toBe(200);
    expect(r.corpo.relatorio).toMatchObject({ total: 0, itens: [] });
    expect(
      (await gestor.get("/admin/relatorios/excecoes?de=2026-05-01&ate=2026-04-01")).status,
    ).toBe(400);
    expect((await enf.get("/admin/relatorios/excecoes")).status).toBe(403);
  });

  it("exportar pede a senha e entrega PDF e planilha", async () => {
    expect(
      (await gestorSemSenha.post("/admin/relatorios/excecoes/exportar", { formato: "pdf" })).status,
    ).toBe(403);
    const pdf = await gestor.post("/admin/relatorios/excecoes/exportar", { formato: "pdf" });
    expect(pdf.status).toBe(200);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const csv = await gestor.post("/admin/relatorios/excecoes/exportar", { formato: "csv" });
    expect(csv.texto).toContain("Data e hora;Residente");
  });
});

describe("exportação do residente pela API", () => {
  it("entrega o arquivo JSON do residente, para baixar", async () => {
    const r = await gestor.post(`/admin/idosos/${idosoId}/exportacao`, {});
    expect(r.status).toBe(200);
    expect(r.cabecalhos.get("content-disposition")).toContain("attachment");
    expect(r.cabecalhos.get("cache-control")).toBe("no-store");
    const arquivo = JSON.parse(r.texto) as { residente: { nome: string; cpf: string } };
    expect(arquivo.residente).toMatchObject({
      nome: "Residente da API de relatórios",
      cpf: "52998224725",
    });
  });

  it("pede a senha, é só do gestor e não acha o que não existe", async () => {
    const corpo = {};
    expect((await gestorSemSenha.post(`/admin/idosos/${idosoId}/exportacao`, corpo)).status).toBe(
      403,
    );
    expect((await enf.post(`/admin/idosos/${idosoId}/exportacao`, corpo)).status).toBe(403);
    expect(
      (await gestor.post("/admin/idosos/11111111-1111-4111-8111-111111111111/exportacao", corpo))
        .status,
    ).toBe(404);
    expect((await gestor.post("/admin/idosos/nao-uuid/exportacao", corpo)).status).toBe(404);
  });
});
