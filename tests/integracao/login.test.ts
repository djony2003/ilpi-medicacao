import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashDeToken } from "@/compartilhado/tokens";
import { cifrar } from "@/compartilhado/criptografia";
import { comContexto } from "@/compartilhado/banco/transacao";
import {
  POLITICA,
  autenticarSessao,
  confirmarConfiguracaoTotp,
  entrar,
  gerarCodigo,
  gerarSegredoTotp,
  iniciarConfiguracaoTotp,
  passoDe,
  sair,
  verificarSegundoFator,
  type Servico,
} from "@/modules/identidade";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { SENHA_PADRAO, criarCasa, criarUsuario, type UsuarioDeTeste } from "../ajudantes/dados";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const MIN = 60_000;

let app: pg.Pool;
let migrador: pg.Pool;
let casaId: string;
let agora: Date;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const codigoDe = (segredo: string, deslocamento = 0) =>
  gerarCodigo(segredo, passoDe(agora.getTime()) + deslocamento);

/** Cria um gestor com autenticador já ativo. */
async function gestorComTotp(
  opcoes: { perfil?: "gestor" | "enfermeiro" } = {},
): Promise<{ usuario: UsuarioDeTeste; segredo: string }> {
  const segredo = gerarSegredoTotp();
  const usuario = await criarUsuario(migrador, casaId, {
    perfil: opcoes.perfil ?? "gestor",
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  return { usuario, segredo };
}

async function lerUsuario(usuarioId: string) {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query(
      `SELECT tentativas_falhas, bloqueado_ate, totp_ativo, totp_segredo_cifrado,
              totp_ultimo_passo::text AS totp_ultimo_passo
         FROM usuario WHERE id = $1`,
      [usuarioId],
    );
    return r.rows[0] as {
      tentativas_falhas: number;
      bloqueado_ate: Date | null;
      totp_ativo: boolean;
      totp_segredo_cifrado: string | null;
      totp_ultimo_passo: string | null;
    };
  });
}

async function acoesDeAuditoria(usuarioId: string): Promise<string[]> {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{ acao: string }>(
      "SELECT acao FROM auditoria WHERE entidade_id = $1 OR usuario_id = $1::uuid ORDER BY seq",
      [usuarioId],
    );
    return r.rows.map((l) => l.acao);
  });
}

async function loginCompleto(u: UsuarioDeTeste, segredo: string) {
  const etapa1 = await entrar(servico(), { email: u.email ?? "", senha: SENHA_PADRAO });
  if (!etapa1.ok) throw new Error("senha deveria ser aceita");
  const etapa2 = await verificarSegundoFator(servico(), {
    token: etapa1.token,
    codigo: codigoDe(segredo),
  });
  if (!etapa2.ok) throw new Error("segundo fator deveria ser aceito");
  return etapa2.token;
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  casaId = await criarCasa(migrador, "Casa do Login");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("login em duas etapas", () => {
  it("quem já tem autenticador: senha, depois código, depois sessão válida", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();

    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    expect(etapa1).toMatchObject({ ok: true, etapa: "segundo_fator" });
    if (!etapa1.ok) return;

    // Com a sessão incompleta (só a senha) ainda não se acessa nada.
    expect(await autenticarSessao(servico(), etapa1.token)).toBeNull();

    const etapa2 = await verificarSegundoFator(servico(), {
      token: etapa1.token,
      codigo: codigoDe(segredo),
    });
    expect(etapa2.ok).toBe(true);

    const sessao = await autenticarSessao(servico(), etapa1.token);
    expect(sessao).toMatchObject({
      casaId,
      usuarioId: usuario.id,
      perfil: "gestor",
      tipo: "web",
      dispositivoId: null,
    });
  });

  it("primeiro acesso: configura o autenticador e já fica logado", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const usuario = await criarUsuario(migrador, casaId, { perfil: "enfermeiro" });

    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    expect(etapa1).toMatchObject({ ok: true, etapa: "configurar_segundo_fator" });
    if (!etapa1.ok) return;

    const inicio = await iniciarConfiguracaoTotp(servico(), { token: etapa1.token });
    if (!("segredo" in inicio)) throw new Error("deveria iniciar a configuração");
    expect(inicio.uri).toContain("otpauth://totp/");
    expect(inicio.uri).toContain(inicio.segredo);

    // Antes de confirmar, o segundo fator ainda não está ativo e o segredo está cifrado.
    const antes = await lerUsuario(usuario.id);
    expect(antes.totp_ativo).toBe(false);
    expect(antes.totp_segredo_cifrado).toMatch(/^v1:/);
    expect(antes.totp_segredo_cifrado).not.toContain(inicio.segredo);

    const errado = await confirmarConfiguracaoTotp(servico(), {
      token: etapa1.token,
      codigo: codigoDe(inicio.segredo) === "000000" ? "000001" : "000000",
    });
    expect(errado.ok).toBe(false);

    const confirmado = await confirmarConfiguracaoTotp(servico(), {
      token: etapa1.token,
      codigo: codigoDe(inicio.segredo),
    });
    expect(confirmado.ok).toBe(true);
    expect((await lerUsuario(usuario.id)).totp_ativo).toBe(true);
    expect(await autenticarSessao(servico(), etapa1.token)).toMatchObject({
      usuarioId: usuario.id,
      perfil: "enfermeiro",
    });
  });

  it("não deixa reiniciar a configuração de quem já tem autenticador ativo", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario } = await gestorComTotp();
    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    if (!etapa1.ok) throw new Error("senha deveria ser aceita");
    const r = await iniciarConfiguracaoTotp(servico(), { token: etapa1.token });
    expect("segredo" in r).toBe(false);
  });

  it("e-mail em maiúsculas e com espaços também entra", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario } = await gestorComTotp();
    const r = await entrar(servico(), {
      email: `  ${(usuario.email ?? "").toUpperCase()}  `,
      senha: SENHA_PADRAO,
    });
    expect(r.ok).toBe(true);
  });

  it("o banco guarda só o hash do token da sessão", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const token = await loginCompleto(usuario, segredo);

    const linhas = await comContexto(app, { casaId }, async (c) => {
      const r = await c.query<{ token_hash: string }>(
        "SELECT token_hash FROM sessao WHERE usuario_id = $1",
        [usuario.id],
      );
      return r.rows;
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.token_hash).toBe(hashDeToken(token));
    expect(linhas[0]?.token_hash).not.toBe(token);
  });
});

describe("respostas que não entregam informação", () => {
  it("e-mail inexistente e senha errada recebem exatamente a mesma resposta", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario } = await gestorComTotp();
    const inexistente = await entrar(servico(), {
      email: "ninguem@nao-existe.test",
      senha: SENHA_PADRAO,
    });
    const senhaErrada = await entrar(servico(), {
      email: usuario.email ?? "",
      senha: "senha-errada-qualquer",
    });
    expect(inexistente).toEqual(senhaErrada);
    expect(inexistente).toEqual({ ok: false, motivo: "credenciais_invalidas" });
  });

  it("entradas vazias ou gigantes são recusadas sem derrubar nada", async () => {
    for (const entrada of [
      { email: "", senha: SENHA_PADRAO },
      { email: "a@b.test", senha: "" },
      { email: "a@b.test", senha: "x".repeat(5000) },
      { email: `${"a".repeat(300)}@b.test`, senha: SENHA_PADRAO },
    ]) {
      expect(await entrar(servico(), entrada)).toEqual({
        ok: false,
        motivo: "credenciais_invalidas",
      });
    }
  });

  it("cuidador, usuário desativado e casa desativada não entram pela web", async () => {
    agora = new Date("2026-03-10T12:00:00Z");

    const cuidador = await criarUsuario(migrador, casaId, { perfil: "cuidador", pin: "482916" });
    expect(cuidador.email).toBeNull();

    const inativo = (await gestorComTotp()).usuario;
    await comContexto(migrador, { casaId }, (c) =>
      c.query("UPDATE usuario SET ativo = false, desativado_em = now() WHERE id = $1", [
        inativo.id,
      ]),
    );
    expect((await entrar(servico(), { email: inativo.email ?? "", senha: SENHA_PADRAO })).ok).toBe(
      false,
    );
    expect(await acoesDeAuditoria(inativo.id)).toContain("login.recusado");

    const outraCasa = await criarCasa(migrador, "Casa Desativada");
    const deOutra = await criarUsuario(migrador, outraCasa, { perfil: "gestor" });
    await comContexto(migrador, { casaId: outraCasa }, (c) =>
      c.query("UPDATE casa SET ativa = false WHERE id = $1", [outraCasa]),
    );
    expect((await entrar(servico(), { email: deOutra.email ?? "", senha: SENHA_PADRAO })).ok).toBe(
      false,
    );
  });

  it("usuário sem senha cadastrada não entra", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const semSenha = await criarUsuario(migrador, casaId, { perfil: "enfermeiro", senha: null });
    expect((await entrar(servico(), { email: semSenha.email ?? "", senha: SENHA_PADRAO })).ok).toBe(
      false,
    );
  });
});

describe("bloqueio por tentativas", () => {
  it("5 senhas erradas bloqueiam; a senha certa não adianta; passado o prazo volta", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario } = await gestorComTotp();
    const errada = () =>
      entrar(servico(), { email: usuario.email ?? "", senha: "senha-errada-123" });

    for (let i = 1; i < POLITICA.maximoDeFalhas; i += 1) {
      expect((await errada()).ok).toBe(false);
      expect((await lerUsuario(usuario.id)).tentativas_falhas).toBe(i);
    }
    expect((await errada()).ok).toBe(false); // a quinta bloqueia
    const bloqueado = await lerUsuario(usuario.id);
    expect(bloqueado.bloqueado_ate?.getTime()).toBe(agora.getTime() + POLITICA.bloqueioMs);

    // Durante o bloqueio, nem a senha certa entra.
    const certa = () => entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    expect((await certa()).ok).toBe(false);
    agora = new Date(agora.getTime() + POLITICA.bloqueioMs - MIN);
    expect((await certa()).ok).toBe(false);

    // Passado o prazo, volta ao normal.
    agora = new Date(agora.getTime() + 2 * MIN);
    expect((await certa()).ok).toBe(true);

    const acoes = await acoesDeAuditoria(usuario.id);
    expect(acoes.filter((a) => a === "login.falha")).toHaveLength(POLITICA.maximoDeFalhas);
    expect(acoes).toContain("login.conta_bloqueada");
    expect(acoes.filter((a) => a === "login.bloqueado")).toHaveLength(2);
  });

  it("falhas de senha e de segundo fator somam no mesmo contador", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();

    // 2 senhas erradas + senha certa + 3 códigos errados = 5 falhas.
    for (let i = 0; i < 2; i += 1) {
      await entrar(servico(), { email: usuario.email ?? "", senha: "senha-errada-123" });
    }
    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    if (!etapa1.ok) throw new Error("senha deveria ser aceita");
    // Entrar com a senha certa não zera o contador.
    expect((await lerUsuario(usuario.id)).tentativas_falhas).toBe(2);

    const certo = codigoDe(segredo);
    const erradoA = certo === "111111" ? "222222" : "111111";
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await verificarSegundoFator(servico(), { token: etapa1.token, codigo: erradoA })).ok,
      ).toBe(false);
    }
    expect((await lerUsuario(usuario.id)).bloqueado_ate).not.toBeNull();

    // O bloqueio derruba a sessão incompleta: nem o código certo serve mais.
    expect(
      (await verificarSegundoFator(servico(), { token: etapa1.token, codigo: certo })).ok,
    ).toBe(false);
  });

  it("login completo zera o contador", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    await entrar(servico(), { email: usuario.email ?? "", senha: "senha-errada-123" });
    await entrar(servico(), { email: usuario.email ?? "", senha: "senha-errada-123" });
    expect((await lerUsuario(usuario.id)).tentativas_falhas).toBe(2);
    await loginCompleto(usuario, segredo);
    expect((await lerUsuario(usuario.id)).tentativas_falhas).toBe(0);
  });

  it("tentativas simultâneas não passam do limite", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario } = await gestorComTotp();
    const tentativas = Array.from({ length: 12 }, () =>
      entrar(servico(), { email: usuario.email ?? "", senha: "senha-errada-123" }),
    );
    const resultados = await Promise.all(tentativas);
    expect(resultados.every((r) => !r.ok)).toBe(true);

    const acoes = await acoesDeAuditoria(usuario.id);
    // Exatamente 5 chegam a ser conferidas; as outras já encontram a conta bloqueada.
    expect(acoes.filter((a) => a === "login.falha")).toHaveLength(POLITICA.maximoDeFalhas);
    expect(acoes.filter((a) => a === "login.bloqueado")).toHaveLength(12 - POLITICA.maximoDeFalhas);
  });
});

describe("segundo fator", () => {
  it("o mesmo código não vale duas vezes", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    await loginCompleto(usuario, segredo);

    // Alguém que viu o código por cima do ombro tenta reutilizá-lo.
    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    if (!etapa1.ok) throw new Error("senha deveria ser aceita");
    const repetido = await verificarSegundoFator(servico(), {
      token: etapa1.token,
      codigo: codigoDe(segredo),
    });
    expect(repetido.ok).toBe(false);

    // Mais de 30 segundos depois, o código do passo seguinte funciona.
    agora = new Date(agora.getTime() + 30_000);
    const seguinte = await verificarSegundoFator(servico(), {
      token: etapa1.token,
      codigo: codigoDe(segredo),
    });
    expect(seguinte.ok).toBe(true);
  });

  it("código de passo anterior ao último aceito é recusado mesmo dentro da janela", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    await loginCompleto(usuario, segredo);

    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    if (!etapa1.ok) throw new Error("senha deveria ser aceita");
    const anterior = await verificarSegundoFator(servico(), {
      token: etapa1.token,
      codigo: codigoDe(segredo, -1),
    });
    expect(anterior.ok).toBe(false);
  });

  it("token de sessão desconhecido ou de outra etapa é recusado", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    expect(
      (await verificarSegundoFator(servico(), { token: "token-que-nao-existe", codigo: "123456" }))
        .ok,
    ).toBe(false);

    // Sessão já completa não pode ser "completada" de novo.
    const token = await loginCompleto(usuario, segredo);
    agora = new Date(agora.getTime() + 30_000);
    expect((await verificarSegundoFator(servico(), { token, codigo: codigoDe(segredo) })).ok).toBe(
      false,
    );
  });

  it("a sessão incompleta expira em poucos minutos", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
    if (!etapa1.ok) throw new Error("senha deveria ser aceita");
    agora = new Date(agora.getTime() + POLITICA.web.segundoFatorMs + 1000);
    expect(
      (await verificarSegundoFator(servico(), { token: etapa1.token, codigo: codigoDe(segredo) }))
        .ok,
    ).toBe(false);
  });
});

describe("vida da sessão", () => {
  it("expira por inatividade, mas cada uso renova o prazo", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const token = await loginCompleto(usuario, segredo);

    const inatividade = POLITICA.web.inatividadeSegundos * 1000;
    agora = new Date(agora.getTime() + inatividade - MIN);
    expect(await autenticarSessao(servico(), token)).not.toBeNull(); // renova
    agora = new Date(agora.getTime() + inatividade - MIN);
    expect(await autenticarSessao(servico(), token)).not.toBeNull(); // renova de novo
    agora = new Date(agora.getTime() + inatividade + MIN);
    expect(await autenticarSessao(servico(), token)).toBeNull();
    // E uma vez vencida, não ressuscita.
    agora = new Date(agora.getTime() - inatividade);
    expect(await autenticarSessao(servico(), token)).toBeNull();
  });

  it("expira pela duração máxima, mesmo com uso constante", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const token = await loginCompleto(usuario, segredo);

    const inicio = agora.getTime();
    const passo = 20 * MIN;
    while (agora.getTime() - inicio + passo < POLITICA.web.duracaoMaximaMs) {
      agora = new Date(agora.getTime() + passo);
      expect(await autenticarSessao(servico(), token)).not.toBeNull();
    }
    agora = new Date(inicio + POLITICA.web.duracaoMaximaMs + 1000);
    expect(await autenticarSessao(servico(), token)).toBeNull();
  });

  it("sair encerra a sessão para sempre", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const token = await loginCompleto(usuario, segredo);
    expect(await autenticarSessao(servico(), token)).not.toBeNull();

    await sair(servico(), token);
    expect(await autenticarSessao(servico(), token)).toBeNull();
    await sair(servico(), token); // repetir não dá erro
    await sair(servico(), "token-inexistente");

    const acoes = await acoesDeAuditoria(usuario.id);
    expect(acoes.filter((a) => a === "sessao.encerrada")).toHaveLength(1);
  });

  it("desativar o usuário derruba a sessão que já estava aberta", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const token = await loginCompleto(usuario, segredo);
    await comContexto(migrador, { casaId }, (c) =>
      c.query("UPDATE usuario SET ativo = false WHERE id = $1", [usuario.id]),
    );
    expect(await autenticarSessao(servico(), token)).toBeNull();
  });

  it("token adulterado ou de tamanho absurdo não autentica", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    const token = await loginCompleto(usuario, segredo);
    expect(await autenticarSessao(servico(), `${token}x`)).toBeNull();
    expect(await autenticarSessao(servico(), token.slice(1))).toBeNull();
    expect(await autenticarSessao(servico(), "")).toBeNull();
    expect(await autenticarSessao(servico(), "a".repeat(10_000))).toBeNull();
  });
});

describe("trilha de auditoria do login", () => {
  it("registra o caminho completo e nunca grava senha, código nem token", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { usuario, segredo } = await gestorComTotp();
    await entrar(servico(), {
      email: usuario.email ?? "",
      senha: "senha-errada-123",
      ip: "203.0.113.7",
    });
    const token = await loginCompleto(usuario, segredo);
    await sair(servico(), token, "203.0.113.7");

    const acoes = await acoesDeAuditoria(usuario.id);
    expect(acoes).toEqual(
      expect.arrayContaining(["login.falha", "login.senha_ok", "login.sucesso"]),
    );

    const tudo = await comContexto(app, { casaId }, async (c) => {
      const r = await c.query("SELECT to_jsonb(a) AS linha FROM auditoria a");
      return JSON.stringify(r.rows);
    });
    for (const proibido of [SENHA_PADRAO, "senha-errada-123", segredo, token, codigoDe(segredo)]) {
      expect(tudo).not.toContain(proibido);
    }
    expect(tudo).toContain("203.0.113.7");
  });
});
