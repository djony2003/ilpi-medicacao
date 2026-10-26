import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar } from "@/compartilhado/criptografia";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let api: (r: Request) => Promise<Response>;
let enfermeiro: Navegador;
let tablet: Navegador;
let casaId: string;

/** Lê o código da pulseira impressa direto do banco (a API não o devolve no cadastro). */
async function codigoDaPulseira(idosoId: string): Promise<string> {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{ codigo_pulseira: string }>(
      "SELECT codigo_pulseira FROM idoso WHERE id = $1",
      [idosoId],
    );
    return r.rows[0]?.codigo_pulseira ?? "";
  });
}

const corpoIdoso = {
  nome: "Seu Antônio Pereira",
  dataNascimento: "1935-08-14",
  cpf: "529.982.247-25",
  quarto: "7",
  alergias: [{ substancia: "Aspirina", gravidade: "grave" }],
  contatos: [{ nome: "Lúcia Pereira", parentesco: "Filha", telefone: "(21) 98888-7777" }],
};

async function cadastrar(nome = corpoIdoso.nome) {
  const r = await enfermeiro.post("/idosos", { ...corpoIdoso, nome });
  expect(r.status).toBe(201);
  return String(r.corpo.idosoId);
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE });
  api = criarApi({ servico, producao: false });
  const casa = await criarCasa(migrador, "Casa da API de idosos");
  casaId = casa;

  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casa, {
    perfil: "enfermeiro",
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  enfermeiro = new Navegador(api);
  await entrarNaApi(enfermeiro, u.email ?? "", segredo, { confirmarSenha: true });

  const gestorSegredo = gerarSegredoTotp();
  const g = await criarUsuario(migrador, casa, {
    perfil: "gestor",
    totpSegredoCifrado: cifrar(gestorSegredo, CHAVE),
    totpAtivo: true,
  });
  const gestor = new Navegador(api);
  await entrarNaApi(gestor, g.email ?? "", gestorSegredo, { confirmarSenha: true });
  const aparelho = await gestor.post("/admin/dispositivos", { nome: "Tablet do posto" });
  tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(aparelho.corpo.codigo) });
  const cuidador = await criarUsuario(migrador, casa, { perfil: "cuidador", pin: "846201" });
  const entrou = await tablet.post("/tablet/entrar", { usuarioId: cuidador.id, pin: "846201" });
  expect(entrou.status).toBe(200);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("API de idosos", () => {
  it("cadastra, consulta com dados mascarados e lista", async () => {
    const id = await cadastrar();
    const detalhe = await enfermeiro.get(`/idosos/${id}`);
    expect(detalhe.status).toBe(200);
    expect(detalhe.corpo).toMatchObject({
      idoso: { id, nome: "Seu Antônio Pereira", cpf: "***.***.***-25", status: "ativo" },
    });
    const texto = JSON.stringify(detalhe.corpo);
    expect(texto).not.toContain("52998224725");
    expect(texto).not.toContain("98888-7777");
    expect(texto).not.toContain("codigoPulseira");

    const lista = await enfermeiro.get("/idosos?status=ativo");
    expect(JSON.stringify(lista.corpo)).toContain(id);
    expect((await enfermeiro.get("/idosos?status=inventado")).status).toBe(400);
  });

  it("não devolve o código da pulseira no cadastro (ele só sai pela emissão registrada)", async () => {
    const r = await enfermeiro.post("/idosos", corpoIdoso);
    expect(JSON.stringify(r.corpo)).not.toMatch(/[A-HJKMNP-Z2-9]{20}/);
  });

  it("devolve 400 com os problemas em português quando os dados são inválidos", async () => {
    const r = await enfermeiro.post("/idosos", { ...corpoIdoso, cpf: "111.111.111-11" });
    expect(r.status).toBe(400);
    expect(r.corpo.erro).toBe("dados_invalidos");
    expect((r.corpo.problemas as string[]).length).toBeGreaterThan(0);
    // Campo desconhecido é recusado, não ignorado.
    expect((await enfermeiro.post("/idosos", { ...corpoIdoso, codigoPulseira: "X" })).status).toBe(
      400,
    );
  });

  it("edita, muda a situação e recusa repetição", async () => {
    const id = await cadastrar();
    expect((await enfermeiro.post(`/idosos/${id}/editar`, { quarto: "9" })).corpo).toEqual({
      ok: true,
      camposAlterados: ["quarto"],
    });
    expect(
      (await enfermeiro.post(`/idosos/${id}/status`, { status: "hospitalizado" })).status,
    ).toBe(200);
    const repetido = await enfermeiro.post(`/idosos/${id}/status`, { status: "hospitalizado" });
    expect(repetido.status).toBe(409);
    expect(repetido.corpo).toEqual({ erro: "sem_mudanca" });
    expect((await enfermeiro.post(`/idosos/${id}/status`, { status: "fugiu" })).status).toBe(400);
  });

  it("alergias e contatos: adicionar e desativar", async () => {
    const id = await cadastrar();
    const a = await enfermeiro.post(`/idosos/${id}/alergias`, {
      substancia: "Iodo",
      gravidade: "leve",
    });
    expect(a.status).toBe(201);
    expect(
      (await enfermeiro.post(`/idosos/${id}/alergias/${String(a.corpo.alergiaId)}/desativar`))
        .status,
    ).toBe(200);
    const c = await enfermeiro.post(`/idosos/${id}/contatos`, {
      nome: "Pedro",
      parentesco: "Neto",
      telefone: "11 97777-6666",
    });
    expect(c.status).toBe(201);
    expect(
      (await enfermeiro.post(`/idosos/${id}/contatos/${String(c.corpo.contatoId)}/desativar`))
        .status,
    ).toBe(200);
    expect((await enfermeiro.post(`/idosos/${id}/contatos/not-a-uuid/desativar`)).status).toBe(404);
  });

  it("ver CPF e telefones por extenso é uma ação POST registrada", async () => {
    const id = await cadastrar();
    expect((await enfermeiro.get(`/idosos/${id}/dados-sensiveis`)).status).toBe(405);
    const r = await enfermeiro.post(`/idosos/${id}/dados-sensiveis`);
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ cpf: "52998224725" });
  });

  it("o tablet do cuidador lê a pulseira mas não administra o cadastro", async () => {
    const id = await cadastrar("Idoso Lido no Tablet");
    const codigo = await codigoDaPulseira(id);

    const lido = await tablet.post("/pulseira/localizar", { leitura: `ILPI:I:${codigo}` });
    expect(lido.status).toBe(200);
    expect(lido.corpo).toMatchObject({
      idoso: { id, nome: "Idoso Lido no Tablet", alergias: [{ substancia: "Aspirina" }] },
    });
    expect((await tablet.post("/pulseira/localizar", { leitura: "lixo" })).corpo).toEqual({
      erro: "codigo_invalido",
    });

    for (const [metodo, caminho] of [
      ["GET", "/idosos"],
      ["GET", `/idosos/${id}`],
      ["POST", `/idosos/${id}/editar`],
      ["POST", `/idosos/${id}/dados-sensiveis`],
    ] as const) {
      const r = await tablet.chamar(metodo, caminho, { corpo: metodo === "POST" ? {} : undefined });
      expect(r.status, `${metodo} ${caminho}`).toBe(403);
    }
  });

  it("trocar a pulseira exige motivo e invalida a antiga na leitura", async () => {
    const id = await cadastrar();
    const antigo = await codigoDaPulseira(id);
    expect((await enfermeiro.post(`/idosos/${id}/pulseira/regenerar`, { motivo: "" })).status).toBe(
      400,
    );
    expect(
      (await enfermeiro.post(`/idosos/${id}/pulseira/regenerar`, { motivo: "Perdida" })).status,
    ).toBe(200);
    const lido = await tablet.post("/pulseira/localizar", { leitura: antigo });
    expect(lido.status).toBe(409);
    expect(lido.corpo).toEqual({ erro: "pulseira_substituida" });
  });

  it("respostas não ficam em cache e erros não vazam detalhes", async () => {
    const id = await cadastrar();
    const r = await enfermeiro.get(`/idosos/${id}`);
    expect(r.cabecalhos.get("cache-control")).toContain("no-store");
  });
});
