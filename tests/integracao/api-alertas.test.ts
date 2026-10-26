import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cifrar } from "@/compartilhado/criptografia";
import { verificarAlertasDaCasa } from "@/modules/alertas";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import {
  idosoComPulseira,
  linhas,
  lote,
  medicamento,
  prescreverComDose,
} from "../ajudantes/administracao";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";
import { criarAtorWeb } from "../ajudantes/sessoes";

// Painel de alertas pela API: listar, resumo, ler, encerrar e configurar.

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let api: (r: Request) => Promise<Response>;
let enf: Navegador;
let gestor: Navegador;
let tablet: Navegador;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE });

async function logar(perfil: "enfermeiro" | "gestor") {
  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casa, {
    perfil,
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  const nav = new Navegador(api);
  await entrarNaApi(nav, u.email ?? "", segredo, { confirmarSenha: true });
  return nav;
}

type Alerta = {
  id: string;
  tipo: string;
  gravidade: string;
  titulo: string;
  lidoPorMim: boolean;
  leituras: unknown[];
};

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  api = criarApi({ servico, producao: false });
  casa = await criarCasa(migrador, "Casa da API de alertas");
  enf = await logar("enfermeiro");
  gestor = await logar("gestor");
  const aparelho = await gestor.post("/admin/dispositivos", { nome: "Tablet" });
  tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(aparelho.corpo.codigo) });
  const c = await criarUsuario(migrador, casa, { perfil: "cuidador", pin: "846201" });
  await tablet.post("/tablet/entrar", { usuarioId: c.id, pin: "846201" });

  // Uma dose das 08:00 de 10/03, verificada às 11:00 locais: dose sem registro (urgente).
  const prevista = new Date("2026-03-10T11:00:00Z");
  const quando = {
    pool: app,
    chaveCampos: CHAVE,
    agora: () => new Date(prevista.getTime() - 3_600_000),
  };
  const ator = await criarAtorWeb(() => quando, migrador, casa, "enfermeiro");
  const idoso = await idosoComPulseira(quando, ator, "Residente do Painel");
  const med = await medicamento(quando, ator, { nome: "Remedio do Painel" });
  await lote(quando, app, ator, med, 500);
  await prescreverComDose(quando, ator, idoso.id, med);
  await verificarAlertasDaCasa(
    { pool: app, agora: () => new Date(prevista.getTime() + 3 * 3_600_000) },
    casa,
  );
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("API dos alertas", () => {
  it("lista os abertos (urgentes primeiro), com o resumo para o selo", async () => {
    const r = await enf.get("/alertas");
    expect(r.status).toBe(200);
    expect(r.cabecalhos.get("cache-control")).toBe("no-store");
    const lista = (r.corpo as { alertas: Alerta[] }).alertas;
    expect(lista[0]).toMatchObject({
      tipo: "dose_sem_registro",
      gravidade: "urgente",
      lidoPorMim: false,
    });
    expect(lista[0]?.titulo).toContain("Residente do Painel");
    expect((await enf.get("/alertas/resumo")).corpo).toEqual({
      resumo: { abertos: 1, urgentes: 1, naoLidosPorMim: 1 },
    });
    expect((await enf.get("/alertas?estado=talvez")).status).toBe(400);
  });

  it("marca como lido (por pessoa) e encerra com justificativa", async () => {
    const id = ((await enf.get("/alertas")).corpo as { alertas: Alerta[] }).alertas[0]?.id ?? "";
    expect((await enf.post(`/alertas/${id}/lido`, {})).corpo).toEqual({ ok: true, fechado: false });
    expect((await enf.get("/alertas/resumo")).corpo).toMatchObject({
      resumo: { naoLidosPorMim: 0 },
    });
    expect((await gestor.get("/alertas/resumo")).corpo).toMatchObject({
      resumo: { naoLidosPorMim: 1 },
    });
    expect((await gestor.post(`/alertas/${id}/encerrar`, { justificativa: "x" })).status).toBe(400);
    const r = await gestor.post(`/alertas/${id}/encerrar`, {
      justificativa: "Conferido na folha: dose dada às 08:10",
    });
    expect(r.corpo).toEqual({ ok: true });
    expect(
      (await gestor.post(`/alertas/${id}/encerrar`, { justificativa: "De novo, por engano" }))
        .status,
    ).toBe(409);
    const resolvidos = (
      (await gestor.get("/alertas?estado=resolvido")).corpo as { alertas: Alerta[] }
    ).alertas;
    expect(resolvidos[0]).toMatchObject({ id, resolucao: "manual" });
    expect(
      (await linhas(app, casa, "SELECT 1 FROM auditoria WHERE acao = 'alerta.encerrado'")).length,
    ).toBe(1);
  });

  it("configuração dos limites: o gestor lê e muda; validação clara", async () => {
    const atual = await gestor.get("/admin/configuracoes/alertas");
    expect(atual.corpo).toMatchObject({
      configuracao: { estoqueAvisoDias: 7, fimDosPlantoes: ["07:00", "19:00"] },
    });
    const r = await gestor.post("/admin/configuracoes/alertas", {
      fimDosPlantoes: ["06:00", "18:00"],
      emailParaAvisos: true,
    });
    expect(r.corpo).toMatchObject({
      configuracao: { fimDosPlantoes: ["06:00", "18:00"], emailParaAvisos: true },
    });
    const ruim = await gestor.post("/admin/configuracoes/alertas", { estoqueAvisoDias: 500 });
    expect(ruim.status).toBe(400);
    expect(ruim.corpo).toMatchObject({ erro: "dados_invalidos" });
    expect((await gestor.post("/admin/configuracoes/alertas", { lixo: 1 })).status).toBe(400);
  });

  it("cuidador no tablet não vê alertas; enfermeiro não configura", async () => {
    for (const caminho of ["/alertas", "/alertas/resumo"]) {
      expect((await tablet.get(caminho)).status).toBe(403);
    }
    expect((await enf.get("/admin/configuracoes/alertas")).status).toBe(403);
    expect(
      (await enf.post("/admin/configuracoes/alertas", { emailParaAvisos: false })).status,
    ).toBe(403);
  });
});
