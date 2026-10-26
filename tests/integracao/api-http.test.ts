import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar } from "@/compartilhado/criptografia";
import { gerarCodigo, gerarSegredoTotp, passoDe } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { SENHA_PADRAO, criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador } from "../ajudantes/navegador";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;

const api = () =>
  criarApi({
    servico: () => ({ pool: app, chaveCampos: CHAVE }),
    producao: false,
  });

const codigoAgora = (segredo: string) => gerarCodigo(segredo, passoDe(Date.now()));

/** Cria um gestor com autenticador ativo e faz o login completo pela API. */
async function gestorLogado(
  opcoes: { casaId?: string; reautenticar?: boolean; perfil?: "gestor" | "enfermeiro" } = {},
) {
  const segredo = gerarSegredoTotp();
  const usuario = await criarUsuario(migrador, opcoes.casaId ?? casaA, {
    perfil: opcoes.perfil ?? "gestor",
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  const nav = new Navegador(api());
  expect(
    (await nav.post("/auth/entrar", { email: usuario.email, senha: SENHA_PADRAO })).status,
  ).toBe(200);
  expect((await nav.post("/auth/segundo-fator", { codigo: codigoAgora(segredo) })).status).toBe(
    200,
  );
  if (opcoes.reautenticar ?? true) {
    expect((await nav.post("/auth/reautenticar", { segredo: SENHA_PADRAO })).status).toBe(200);
  }
  return { nav, usuario, segredo };
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  casaA = await criarCasa(migrador, "Casa A da API");
  casaB = await criarCasa(migrador, "Casa B da API");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("login pela API", () => {
  it("senha, segundo fator e então a sessão vale; antes disso, não", async () => {
    const segredo = gerarSegredoTotp();
    const usuario = await criarUsuario(migrador, casaA, {
      perfil: "gestor",
      totpSegredoCifrado: cifrar(segredo, CHAVE),
      totpAtivo: true,
    });
    const nav = new Navegador(api());

    expect((await nav.get("/auth/eu")).status).toBe(401);

    const etapa1 = await nav.post("/auth/entrar", { email: usuario.email, senha: SENHA_PADRAO });
    expect(etapa1.status).toBe(200);
    expect(etapa1.corpo).toEqual({ etapa: "segundo_fator", senhaTrocar: false });
    // O token nunca vai no corpo da resposta: só no cookie.
    expect(JSON.stringify(etapa1.corpo)).not.toMatch(/token/i);

    // Só com a senha ainda não se acessa nada.
    expect((await nav.get("/auth/eu")).status).toBe(401);
    expect((await nav.get("/admin/usuarios")).status).toBe(401);

    const errado = await nav.post("/auth/segundo-fator", { codigo: "000000" });
    expect(errado.status).toBe(401);
    expect(errado.corpo).toEqual({ erro: "credenciais_invalidas" });

    expect((await nav.post("/auth/segundo-fator", { codigo: codigoAgora(segredo) })).status).toBe(
      200,
    );
    const eu = await nav.get("/auth/eu");
    expect(eu.status).toBe(200);
    expect(eu.corpo).toMatchObject({
      usuarioId: usuario.id,
      perfil: "gestor",
      tipo: "web",
      senhaTrocar: false,
    });
  });

  it("e-mail inexistente e senha errada têm resposta idêntica", async () => {
    const { usuario } = await gestorLogado();
    const a = await new Navegador(api()).post("/auth/entrar", {
      email: "ninguem@nao-existe.test",
      senha: "qualquer-senha-123",
    });
    const b = await new Navegador(api()).post("/auth/entrar", {
      email: usuario.email,
      senha: "senha-errada-123",
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.corpo).toEqual(b.corpo);
    expect(a.setCookie).toEqual([]);
    expect(b.setCookie).toEqual([]);
  });

  it("cookie de sessão: HttpOnly, SameSite, sem Secure em dev e com __Host- e Secure em produção", async () => {
    const usuario = await criarUsuario(migrador, casaA, { perfil: "gestor" });

    const dev = await new Navegador(api()).post("/auth/entrar", {
      email: usuario.email,
      senha: SENHA_PADRAO,
    });
    expect(dev.setCookie).toHaveLength(1);
    expect(dev.setCookie[0]).toMatch(
      /^ilpi_sessao=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=300$/,
    );

    const producao = criarApi({
      servico: () => ({ pool: app, chaveCampos: CHAVE }),
      producao: true,
    });
    const r = await new Navegador(producao).post("/auth/entrar", {
      email: usuario.email,
      senha: SENHA_PADRAO,
    });
    const cookie = r.setCookie[0] ?? "";
    expect(cookie).toMatch(/^__Host-ilpi_sessao=/);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("sair invalida o cookie, inclusive se alguém o copiou antes", async () => {
    const { nav } = await gestorLogado();
    const copia = new Map(nav.cookies);
    expect((await nav.get("/auth/eu")).status).toBe(200);

    const r = await nav.post("/auth/sair");
    expect(r.status).toBe(200);
    expect(r.setCookie[0]).toContain("Max-Age=0");
    expect((await nav.get("/auth/eu")).status).toBe(401);

    const ladrao = new Navegador(api());
    for (const [n, v] of copia) ladrao.cookies.set(n, v);
    expect((await ladrao.get("/auth/eu")).status).toBe(401);
  });

  it("primeiro acesso: configura o autenticador pela API e entra", async () => {
    const usuario = await criarUsuario(migrador, casaA, { perfil: "enfermeiro" });
    const nav = new Navegador(api());
    const etapa1 = await nav.post("/auth/entrar", { email: usuario.email, senha: SENHA_PADRAO });
    expect(etapa1.corpo.etapa).toBe("configurar_segundo_fator");

    const inicio = await nav.post("/auth/totp/iniciar");
    expect(inicio.status).toBe(200);
    expect(String(inicio.corpo.uri)).toContain("otpauth://totp/");
    const segredo = String(inicio.corpo.segredo);

    expect((await nav.post("/auth/totp/confirmar", { codigo: "000000" })).status).toBe(401);
    expect((await nav.post("/auth/totp/confirmar", { codigo: codigoAgora(segredo) })).status).toBe(
      200,
    );
    expect((await nav.get("/auth/eu")).corpo).toMatchObject({ perfil: "enfermeiro" });

    // Depois de ativado, não dá para reiniciar a configuração.
    const outraVez = new Navegador(api());
    await outraVez.post("/auth/entrar", { email: usuario.email, senha: SENHA_PADRAO });
    expect((await outraVez.post("/auth/totp/iniciar")).status).toBe(401);
  });
});

describe("proteções gerais da API", () => {
  it("recusa POST sem Origin ou com Origin de outro site (CSRF)", async () => {
    const { nav, usuario } = await gestorLogado();
    const corpo = { email: usuario.email, senha: SENHA_PADRAO };

    const semOrigem = await nav.post("/auth/entrar", corpo, { origem: null });
    expect(semOrigem.status).toBe(403);
    expect(semOrigem.corpo).toEqual({ erro: "origem_invalida" });

    const estranha = await nav.post("/auth/entrar", corpo, { origem: "https://site-malvado.test" });
    expect(estranha.status).toBe(403);

    const fetchSite = await nav.post("/auth/entrar", corpo, {
      origem: null,
      cabecalhos: { "sec-fetch-site": "cross-site" },
    });
    expect(fetchSite.status).toBe(403);

    // Ação de alteração com sessão válida e cookie correto, mas vinda de outro site: bloqueada.
    const forjada = await nav.post(
      "/admin/dispositivos",
      { nome: "Tablet forjado" },
      { origem: "https://site-malvado.test" },
    );
    expect(forjada.status).toBe(403);

    const mesmoSite = await nav.post("/auth/sair", undefined, {
      origem: null,
      cabecalhos: { "sec-fetch-site": "same-origin" },
    });
    expect(mesmoSite.status).toBe(200);
  });

  it("valida o corpo: tipo, formato, campos extras e tamanho", async () => {
    const nav = new Navegador(api());
    const base = { email: "a@b.test", senha: "x" };

    expect((await nav.post("/auth/entrar", base, { tipo: "text/plain" })).status).toBe(415);
    expect((await nav.post("/auth/entrar", base, { tipo: null })).status).toBe(415);
    expect((await nav.post("/auth/entrar", undefined, { brutoCorpo: "{quebrado" })).status).toBe(
      400,
    );
    expect((await nav.post("/auth/entrar", { email: "a@b.test" })).status).toBe(400);
    expect((await nav.post("/auth/entrar", { ...base, perfil: "gestor" })).status).toBe(400);
    expect((await nav.post("/auth/entrar", { email: 123, senha: "x" })).status).toBe(400);
    expect((await nav.post("/auth/entrar", [1, 2])).status).toBe(400);

    const grande = await nav.post("/auth/entrar", undefined, {
      brutoCorpo: JSON.stringify({ ...base, lixo: "x".repeat(40_000) }),
    });
    expect(grande.status).toBe(413);

    // A resposta de erro não repete nada do que foi enviado.
    const eco = await nav.post("/auth/entrar", { email: "segredo-na-resposta@x.test", extra: 1 });
    expect(JSON.stringify(eco.corpo)).not.toContain("segredo-na-resposta");
  });

  it("todas as respostas proíbem cache", async () => {
    const { nav } = await gestorLogado();
    for (const r of [
      await nav.get("/auth/eu"),
      await nav.get("/admin/usuarios"),
      await nav.get("/rota-que-nao-existe"),
      await new Navegador(api()).post("/auth/entrar", { email: "x@y.test", senha: "z" }),
    ]) {
      expect(r.cabecalhos.get("cache-control")).toBe("no-store");
    }
  });

  it("rota inexistente é 404, método errado é 405, id que não é UUID é 404", async () => {
    const { nav } = await gestorLogado();
    expect((await nav.get("/nao-existe")).status).toBe(404);
    expect((await nav.get("/auth/entrar")).status).toBe(405);
    expect((await nav.post("/admin/usuarios/nao-e-uuid/desativar")).status).toBe(404);
    expect((await nav.post("/admin/usuarios/../auth/sair")).status).toBe(404);
    const fora = await new Navegador(api()).chamar("GET", "/x", {});
    expect(fora.status).toBe(404);
  });

  it("falha interna vira 500 genérico, sem vazar detalhes", async () => {
    const poolFechado = criarPoolApp(1);
    await poolFechado.end();
    const quebrada = criarApi({
      servico: () => ({ pool: poolFechado, chaveCampos: CHAVE }),
      producao: false,
    });
    const r = await new Navegador(quebrada).post("/auth/entrar", {
      email: "alguem@exemplo.test",
      senha: "qualquer-senha-123",
    });
    expect(r.status).toBe(500);
    expect(r.corpo).toEqual({ erro: "erro_interno" });
  });
});

describe("administração pela API", () => {
  it("criar usuário exige confirmar a senha; depois funciona", async () => {
    const { nav } = await gestorLogado({ reautenticar: false });
    const novo = {
      nome: "Helena Enfermeira",
      perfil: "enfermeiro",
      email: `helena-${Date.now()}@exemplo.test`,
      senhaInicial: "provisoria longa 2026",
    };
    const antes = await nav.post("/admin/usuarios", novo);
    expect(antes.status).toBe(403);
    expect(antes.corpo).toEqual({ erro: "reautenticacao_necessaria" });

    expect((await nav.post("/auth/reautenticar", { segredo: "senha-errada-123" })).status).toBe(
      401,
    );
    expect((await nav.post("/auth/reautenticar", { segredo: SENHA_PADRAO })).status).toBe(200);

    const criado = await nav.post("/admin/usuarios", novo);
    expect(criado.status).toBe(201);
    expect(criado.corpo.usuarioId).toEqual(expect.any(String));

    const repetido = await nav.post("/admin/usuarios", novo);
    expect(repetido.status).toBe(409);
    expect(repetido.corpo).toEqual({ erro: "email_em_uso" });

    const fraca = await nav.post("/admin/usuarios", {
      ...novo,
      email: "outro@exemplo.test",
      senhaInicial: "curta",
    });
    expect(fraca.status).toBe(400);
    expect(fraca.corpo.erro).toBe("dados_invalidos");
    expect(Array.isArray(fraca.corpo.problemas)).toBe(true);

    const lista = await nav.get("/admin/usuarios");
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.corpo)).toContain("Helena Enfermeira");
    expect(JSON.stringify(lista.corpo)).not.toMatch(/argon2|hash/i);
  });

  it("enfermeiro recebe 403 nas rotas de administração", async () => {
    const { nav } = await gestorLogado({ perfil: "enfermeiro" });
    for (const r of [
      await nav.get("/admin/usuarios"),
      await nav.get("/admin/dispositivos"),
      await nav.post("/admin/dispositivos", { nome: "Tablet" }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.corpo).toEqual({ erro: "sem_permissao" });
    }
  });

  it("sem sessão, tudo na administração é 401", async () => {
    const nav = new Navegador(api());
    expect((await nav.get("/admin/usuarios")).status).toBe(401);
    expect((await nav.post("/admin/usuarios", { nome: "X" })).status).toBe(401);
    expect((await nav.post("/admin/dispositivos", { nome: "X" })).status).toBe(401);
  });

  it("usuário de outra casa aparece como não encontrado", async () => {
    const { nav } = await gestorLogado();
    const deB = await criarUsuario(migrador, casaB, { perfil: "enfermeiro" });
    const r = await nav.post(`/admin/usuarios/${deB.id}/desativar`);
    expect(r.status).toBe(404);
    expect(r.corpo).toEqual({ erro: "usuario_nao_encontrado" });
  });

  it("credencial provisória: bloqueia todo o resto até a pessoa trocá-la", async () => {
    const { nav: gestor } = await gestorLogado();
    const email = `provisorio-${Date.now()}@exemplo.test`;
    const criado = await gestor.post("/admin/usuarios", {
      nome: "Paulo Provisório",
      perfil: "gestor",
      email,
      senhaInicial: "provisoria longa 2026",
    });
    expect(criado.status).toBe(201);

    const novo = new Navegador(api());
    const etapa1 = await novo.post("/auth/entrar", { email, senha: "provisoria longa 2026" });
    expect(etapa1.corpo).toEqual({ etapa: "configurar_segundo_fator", senhaTrocar: true });
    const inicio = await novo.post("/auth/totp/iniciar");
    const segredo = String(inicio.corpo.segredo);
    expect((await novo.post("/auth/totp/confirmar", { codigo: codigoAgora(segredo) })).status).toBe(
      200,
    );

    // Logado, mas preso à troca de senha.
    expect((await novo.get("/auth/eu")).corpo).toMatchObject({ senhaTrocar: true });
    const bloqueado = await novo.get("/admin/usuarios");
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.corpo).toEqual({ erro: "troca_obrigatoria" });

    const trocada = await novo.post("/auth/trocar-senha", {
      senhaAtual: "provisoria longa 2026",
      novaSenha: "minha frase nova e longa 77",
    });
    expect(trocada.status).toBe(200);
    expect((await novo.get("/admin/usuarios")).status).toBe(200);
  });
});

describe("tablet pela API", () => {
  it("gestor aprova o aparelho, o tablet ativa, o cuidador entra com PIN", async () => {
    const { nav: gestor } = await gestorLogado();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: "846201" });

    const criado = await gestor.post("/admin/dispositivos", { nome: "Tablet do posto" });
    expect(criado.status).toBe(201);
    const codigo = String(criado.corpo.codigo);

    const tablet = new Navegador(api());
    // Sem o cookie do aparelho, nem a lista de usuários aparece.
    expect((await tablet.get("/tablet/usuarios")).status).toBe(401);
    expect(
      (await tablet.post("/tablet/entrar", { usuarioId: cuidador.id, pin: "846201" })).status,
    ).toBe(401);

    expect((await tablet.post("/tablet/ativar", { codigo: "ERRADO12345" })).status).toBe(400);
    const ativado = await tablet.post("/tablet/ativar", { codigo });
    expect(ativado.status).toBe(200);
    expect(ativado.setCookie[0]).toMatch(/^ilpi_dispositivo=.*HttpOnly.*Max-Age=31536000/);
    // O mesmo código não ativa um segundo aparelho.
    expect((await new Navegador(api()).post("/tablet/ativar", { codigo })).status).toBe(400);

    const lista = await tablet.get("/tablet/usuarios");
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.corpo)).toContain(cuidador.id);

    expect(
      (await tablet.post("/tablet/entrar", { usuarioId: cuidador.id, pin: "000001" })).status,
    ).toBe(401);
    const entrou = await tablet.post("/tablet/entrar", { usuarioId: cuidador.id, pin: "846201" });
    expect(entrou.status).toBe(200);
    expect(entrou.corpo).toMatchObject({
      ok: true,
      usuario: { id: cuidador.id, perfil: "cuidador" },
    });

    const eu = await tablet.get("/auth/eu");
    expect(eu.corpo).toMatchObject({ usuarioId: cuidador.id, tipo: "tablet", perfil: "cuidador" });
    // Cuidador não administra nada.
    expect((await tablet.get("/admin/usuarios")).status).toBe(403);
  });

  it("PIN provisório deixa o cuidador preso à troca de PIN", async () => {
    const { nav: gestor } = await gestorLogado();
    const { codigo } = (await gestor.post("/admin/dispositivos", { nome: "Tablet" })).corpo as {
      codigo: string;
    };
    const tablet = new Navegador(api());
    await tablet.post("/tablet/ativar", { codigo });

    const criado = await gestor.post("/admin/usuarios", {
      nome: "Rita Cuidadora",
      perfil: "cuidador",
      pinInicial: "846201",
    });
    const usuarioId = String(criado.corpo.usuarioId);
    const entrou = await tablet.post("/tablet/entrar", { usuarioId, pin: "846201" });
    expect(entrou.corpo).toMatchObject({ ok: true, pinTrocar: true });

    expect((await tablet.get("/admin/usuarios")).corpo).toEqual({ erro: "troca_obrigatoria" });
    expect(
      (await tablet.post("/auth/trocar-pin", { pinAtual: "846201", novoPin: "735194" })).status,
    ).toBe(200);
    expect((await tablet.get("/admin/usuarios")).corpo).toEqual({ erro: "sem_permissao" });
  });

  it("revogar o aparelho derruba a sessão do tablet na mesma hora", async () => {
    const { nav: gestor } = await gestorLogado();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: "846201" });
    const criado = await gestor.post("/admin/dispositivos", { nome: "Tablet perdido" });
    const tablet = new Navegador(api());
    await tablet.post("/tablet/ativar", { codigo: String(criado.corpo.codigo) });
    await tablet.post("/tablet/entrar", { usuarioId: cuidador.id, pin: "846201" });
    expect((await tablet.get("/auth/eu")).status).toBe(200);

    const revogar = await gestor.post(
      `/admin/dispositivos/${String(criado.corpo.dispositivoId)}/revogar`,
    );
    expect(revogar.status).toBe(200);
    expect((await tablet.get("/auth/eu")).status).toBe(401);
    expect((await tablet.get("/tablet/usuarios")).status).toBe(401);

    const lista = await gestor.get("/admin/dispositivos");
    expect(JSON.stringify(lista.corpo)).toContain("revogado");
    expect(
      (await gestor.post(`/admin/dispositivos/${String(criado.corpo.dispositivoId)}/revogar`))
        .status,
    ).toBe(404);
  });
});

describe("rastro de auditoria", () => {
  it("login e administração pela API ficam registrados com o IP informado pelo proxy", async () => {
    const segredo = gerarSegredoTotp();
    const usuario = await criarUsuario(migrador, casaA, {
      perfil: "gestor",
      totpSegredoCifrado: cifrar(segredo, CHAVE),
      totpAtivo: true,
    });
    const nav = new Navegador(api());
    const ip = { "x-forwarded-for": "203.0.113.50, 10.0.0.1" };
    await nav.post(
      "/auth/entrar",
      { email: usuario.email, senha: SENHA_PADRAO },
      { cabecalhos: ip },
    );
    await nav.post("/auth/segundo-fator", { codigo: codigoAgora(segredo) }, { cabecalhos: ip });

    const linhas = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{ acao: string; ip: string | null }>(
        "SELECT acao, ip FROM auditoria WHERE usuario_id = $1 ORDER BY seq",
        [usuario.id],
      );
      return r.rows;
    });
    expect(linhas.map((l) => l.acao)).toEqual(["login.senha_ok", "login.sucesso"]);
    expect(linhas.every((l) => l.ip === "203.0.113.50")).toBe(true);
  });

  it("um IP malformado no cabeçalho é ignorado, não gravado", async () => {
    const usuario = await criarUsuario(migrador, casaA, { perfil: "gestor" });
    const nav = new Navegador(api());
    await nav.post(
      "/auth/entrar",
      { email: usuario.email, senha: SENHA_PADRAO },
      { cabecalhos: { "x-forwarded-for": "'); DROP TABLE usuario; --" } },
    );
    const linhas = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{ ip: string | null }>(
        "SELECT ip FROM auditoria WHERE usuario_id = $1",
        [usuario.id],
      );
      return r.rows;
    });
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => l.ip === null)).toBe(true);
  });
});
