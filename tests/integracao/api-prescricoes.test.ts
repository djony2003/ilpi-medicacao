import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArmazenamentoEmMemoria } from "@/compartilhado/armazenamento";
import { cifrar } from "@/compartilhado/criptografia";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let enf: Navegador;
let tablet: Navegador;
let armazenamento: ArmazenamentoEmMemoria;
let n = 0;

const PDF = Buffer.from("%PDF-1.7\nRECEITA-DA-API-CONFIDENCIAL");

const prescricao = (medicamentoId: string, extra: Record<string, unknown> = {}) => ({
  medicamentoId,
  tipo: "regular",
  dose: 1,
  unidade: "comprimido",
  via: "oral",
  inicio: "2026-03-10",
  altoRisco: false,
  horarios: [{ hora: "08:00" }, { hora: "20:00", diasSemana: [1, 2, 3] }],
  ...extra,
});

async function medicamento(extra: Record<string, unknown> = {}) {
  n += 1;
  const r = await enf.post("/medicamentos", {
    nomeComercial: `API Remedio ${n}`,
    principioAtivo: `ApiSubstancia${n}z`,
    forma: "comprimido",
    ...extra,
  });
  expect(r.status).toBe(201);
  return String(r.corpo.medicamentoId);
}

async function idoso(alergias: unknown[] = []) {
  n += 1;
  const r = await enf.post("/idosos", {
    nome: `Idoso API ${n}`,
    dataNascimento: "1940-01-01",
    alergias,
  });
  expect(r.status).toBe(201);
  return String(r.corpo.idosoId);
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  armazenamento = new ArmazenamentoEmMemoria();
  const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, armazenamento });
  const api = criarApi({ servico, producao: false });
  const casa = await criarCasa(migrador, "Casa da API de prescrições");

  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casa, {
    perfil: "enfermeiro",
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  enf = new Navegador(api);
  await entrarNaApi(enf, u.email ?? "", segredo, { confirmarSenha: true });

  const sg = gerarSegredoTotp();
  const g = await criarUsuario(migrador, casa, {
    perfil: "gestor",
    totpSegredoCifrado: cifrar(sg, CHAVE),
    totpAtivo: true,
  });
  const gestor = new Navegador(api);
  await entrarNaApi(gestor, g.email ?? "", sg, { confirmarSenha: true });
  const aparelho = await gestor.post("/admin/dispositivos", { nome: "Tablet" });
  tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(aparelho.corpo.codigo) });
  const c = await criarUsuario(migrador, casa, { perfil: "cuidador", pin: "846201" });
  expect((await tablet.post("/tablet/entrar", { usuarioId: c.id, pin: "846201" })).status).toBe(
    200,
  );
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("API de medicamentos e prescrições", () => {
  it("fluxo completo: catálogo, prescrever, consultar, nova versão e encerrar", async () => {
    const med = await medicamento();
    const id = await idoso();

    const criada = await enf.post(
      `/idosos/${id}/prescricoes`,
      prescricao(med, { dose: 1.5, instrucoes: "Com água" }),
    );
    expect(criada.status).toBe(201);
    const pid = String(criada.corpo.prescricaoId);

    const lista = await enf.get(`/idosos/${id}/prescricoes`);
    expect(lista.status).toBe(200);
    expect(lista.corpo.prescricoes).toEqual([
      expect.objectContaining({
        id: pid,
        dose: 1.5,
        status: "ativa",
        situacao: "vigente",
        horarios: [
          { hora: "08:00", diasSemana: [1, 2, 3, 4, 5, 6, 7] },
          { hora: "20:00", diasSemana: [1, 2, 3] },
        ],
      }),
    ]);

    const v2 = await enf.post(`/prescricoes/${pid}/nova-versao`, {
      justificativa: "Ajuste de dose",
      conteudo: prescricao(med, { dose: 2, instrucoes: "Com água" }),
    });
    expect(v2.status).toBe(201);
    expect(v2.corpo).toMatchObject({ versao: 2, camposAlterados: ["dose"] });
    const novoId = String(v2.corpo.prescricaoId);

    const detalhe = await enf.get(`/prescricoes/${novoId}`);
    expect((detalhe.corpo.historico as Array<{ versao: number }>).map((h) => h.versao)).toEqual([
      2, 1,
    ]);

    expect(
      (await enf.post(`/prescricoes/${novoId}/encerrar`, { motivo: "Tratamento concluído" }))
        .status,
    ).toBe(200);
    const repetido = await enf.post(`/prescricoes/${novoId}/encerrar`, { motivo: "De novo" });
    expect(repetido.status).toBe(409);
    expect(repetido.corpo).toEqual({ erro: "nao_ativa" });
    expect(
      ((await enf.get(`/idosos/${id}/prescricoes`)).corpo.prescricoes as unknown[]).length,
    ).toBe(0);
    expect(
      ((await enf.get(`/idosos/${id}/prescricoes?inativas=1`)).corpo.prescricoes as unknown[])
        .length,
    ).toBe(2);
  });

  it("traduz as recusas em códigos HTTP claros", async () => {
    const med = await medicamento();
    const id = await idoso();
    const alto = await medicamento({ altoRisco: true });

    expect(
      (
        await enf.post("/medicamentos", {
          nomeComercial: "API Remedio 1",
          principioAtivo: "ApiSubstancia1z",
          forma: "comprimido",
        })
      ).status,
    ).toBe(409);
    const invalida = await enf.post(`/idosos/${id}/prescricoes`, prescricao(med, { dose: 0 }));
    expect(invalida.status).toBe(400);
    expect(invalida.corpo.erro).toBe("dados_invalidos");
    expect((invalida.corpo.problemas as string[]).join()).toMatch(/dose/i);
    expect(
      (await enf.post(`/idosos/${id}/prescricoes`, { ...prescricao(med), campoInventado: 1 }))
        .status,
    ).toBe(400);
    expect((await enf.post(`/idosos/${id}/prescricoes`, prescricao(alto))).status).toBe(422);
    expect(
      (
        await enf.post(
          `/idosos/${id}/prescricoes`,
          prescricao("00000000-0000-4000-8000-0000000000aa"),
        )
      ).status,
    ).toBe(422);
    expect((await enf.post(`/idosos/${id}/prescricoes`, prescricao(med))).status).toBe(201);
    expect((await enf.post(`/idosos/${id}/prescricoes`, prescricao(med))).status).toBe(409);
  });

  it("conflito de alergia devolve 409 com as alergias, e a confirmação com justificativa grava", async () => {
    const id = await idoso([{ substancia: "Dipirona", gravidade: "grave" }]);
    const med = await medicamento({ principioAtivo: "Dipirona sódica" });
    const aviso = await enf.post(`/idosos/${id}/prescricoes`, prescricao(med));
    expect(aviso.status).toBe(409);
    expect(aviso.corpo).toMatchObject({
      erro: "conflito_alergia",
      conflitos: [{ substancia: "Dipirona", gravidade: "grave" }],
    });
    const ok = await enf.post(
      `/idosos/${id}/prescricoes`,
      prescricao(med, { justificativaAlergia: "Médico ciente do risco" }),
    );
    expect(ok.status).toBe(201);
    expect(ok.corpo.conflitosConfirmados).toHaveLength(1);
  });

  it("o tablet do cuidador não alcança medicamentos, prescrições nem receitas", async () => {
    const med = await medicamento();
    const id = await idoso();
    const p = await enf.post(`/idosos/${id}/prescricoes`, prescricao(med));
    const pid = String(p.corpo.prescricaoId);
    for (const [metodo, caminho] of [
      ["GET", "/medicamentos"],
      ["POST", "/medicamentos"],
      ["GET", `/idosos/${id}/prescricoes`],
      ["POST", `/idosos/${id}/prescricoes`],
      ["GET", `/prescricoes/${pid}`],
      ["POST", `/prescricoes/${pid}/encerrar`],
      ["GET", `/prescricoes/${pid}/receitas`],
    ] as const) {
      const r = await tablet.chamar(metodo, caminho, { corpo: metodo === "POST" ? {} : undefined });
      expect(r.status, `${metodo} ${caminho}`).toBe(403);
    }
  });
});

describe("API de receitas", () => {
  async function prescricaoNova() {
    const p = await enf.post(
      `/idosos/${await idoso()}/prescricoes`,
      prescricao(await medicamento()),
    );
    return String(p.corpo.prescricaoId);
  }

  it("envia o arquivo, lista e baixa com cabeçalhos que impedem execução e cache", async () => {
    const pid = await prescricaoNova();
    const envio = await enf.chamar("POST", `/prescricoes/${pid}/receitas`, {
      binario: PDF,
      tipo: "application/pdf",
    });
    expect(envio.status).toBe(201);
    expect(envio.corpo).toMatchObject({ tipoMime: "application/pdf", tamanhoBytes: PDF.length });
    const rid = String(envio.corpo.receitaId);

    expect((await enf.get(`/prescricoes/${pid}/receitas`)).corpo.receitas).toEqual([
      expect.objectContaining({ id: rid, versao: 1 }),
    ]);

    const baixa = await enf.get(`/prescricoes/${pid}/receitas/${rid}`);
    expect(baixa.status).toBe(200);
    expect(baixa.bytes.equals(PDF)).toBe(true);
    expect(baixa.cabecalhos.get("content-type")).toBe("application/pdf");
    expect(baixa.cabecalhos.get("cache-control")).toContain("no-store");
    expect(baixa.cabecalhos.get("x-content-type-options")).toBe("nosniff");
    expect(baixa.cabecalhos.get("content-security-policy")).toContain("sandbox");

    for (const guardado of armazenamento.objetos.values()) {
      expect(Buffer.from(guardado).includes("RECEITA-DA-API-CONFIDENCIAL")).toBe(false);
    }
  });

  it("recusa tipo declarado fora da lista, conteúdo que não é o declarado, vazio e grande demais", async () => {
    const pid = await prescricaoNova();
    const enviar = (corpo: Uint8Array, tipo: string | null) =>
      enf.chamar("POST", `/prescricoes/${pid}/receitas`, { binario: corpo, tipo });
    expect((await enviar(PDF, "text/html")).status).toBe(415);
    expect((await enviar(PDF, "image/svg+xml")).status).toBe(415);
    expect((await enviar(PDF, null)).status).toBe(415);
    // Declara JPEG mas o conteúdo é HTML: vale o conteúdo.
    const mentiroso = await enviar(
      Buffer.from("<html><script>alert(1)</script></html>"),
      "image/jpeg",
    );
    expect(mentiroso.status).toBe(415);
    expect(mentiroso.corpo).toEqual({ erro: "arquivo_invalido" });
    expect((await enviar(Buffer.alloc(0), "application/pdf")).status).toBe(400);
    const grande = await enviar(
      Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(10 * 1024 * 1024)]),
      "application/pdf",
    );
    expect(grande.status).toBe(413);
    expect((await enf.get(`/prescricoes/${pid}/receitas`)).corpo.receitas).toEqual([]);
  });

  it("receita de outra prescrição ou inexistente dá 404", async () => {
    const a = await prescricaoNova();
    const b = await prescricaoNova();
    const r = await enf.chamar("POST", `/prescricoes/${a}/receitas`, {
      binario: PDF,
      tipo: "application/pdf",
    });
    const rid = String(r.corpo.receitaId);
    expect((await enf.get(`/prescricoes/${b}/receitas/${rid}`)).status).toBe(404);
    expect(
      (await enf.get(`/prescricoes/${a}/receitas/00000000-0000-4000-8000-0000000000aa`)).status,
    ).toBe(404);
    expect((await enf.get(`/prescricoes/${a}/receitas/não-é-uuid`)).status).toBe(404);
    expect(
      (await enf.get(`/prescricoes/00000000-0000-4000-8000-0000000000aa/receitas`)).status,
    ).toBe(404);
  });
});
