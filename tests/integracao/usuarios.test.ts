import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import {
  ErroDePermissao,
  ErroDeReautenticacao,
  POLITICA,
  autenticarSessao,
  criarDispositivo,
  criarUsuario,
  ativarDispositivo,
  desativarUsuario,
  desbloquearUsuario,
  entrar,
  entrarComPin,
  listarUsuarios,
  reativarUsuario,
  redefinirPin,
  redefinirSegundoFator,
  redefinirSenha,
  trocarMeuPin,
  trocarMinhaSenha,
  type Servico,
} from "@/modules/identidade";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { SENHA_PADRAO, criarCasa, criarUsuario as criarUsuarioDeTeste } from "../ajudantes/dados";
import { criarAtorWeb, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const SENHA_NOVA = "outra frase bem longa 2026";
const PIN_NOVO = "273915";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let agora: Date;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const gestorA = (confirmado = true) =>
  criarAtorWeb(servico, migrador, casaA, "gestor", { reautenticado: confirmado });

const dadosDoEnfermeiro = (sufixo = Math.random().toString(36).slice(2, 8)) => ({
  nome: "Carla Enfermeira",
  perfil: "enfermeiro" as const,
  email: `carla-${sufixo}@exemplo.test`,
  senhaInicial: "provisoria longa 2026",
});

async function lerUsuario(casaId: string, id: string) {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{
      ativo: boolean;
      senha_trocar: boolean;
      pin_trocar: boolean;
      totp_ativo: boolean;
      tentativas_falhas: number;
      bloqueado_ate: Date | null;
    }>(
      `SELECT ativo, senha_trocar, pin_trocar, totp_ativo, tentativas_falhas, bloqueado_ate
         FROM usuario WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  });
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  casaA = await criarCasa(migrador, "Casa A dos Usuários");
  casaB = await criarCasa(migrador, "Casa B dos Usuários");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("criar usuário", () => {
  it("cria enfermeiro com senha provisória que precisa ser trocada", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const dados = dadosDoEnfermeiro();
    const r = await criarUsuario(servico(), gestor, dados);
    expect(r.ok).toBe(true);

    // A pessoa já consegue entrar com a senha provisória e é avisada de que precisa trocá-la.
    const login = await entrar(servico(), { email: dados.email, senha: dados.senhaInicial });
    expect(login).toMatchObject({ ok: true, senhaTrocar: true });
    if (r.ok) expect((await lerUsuario(casaA, r.usuarioId))?.senha_trocar).toBe(true);
  });

  it("cria cuidador só com PIN provisório, sem e-mail nem senha", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const r = await criarUsuario(servico(), gestor, {
      nome: "Beto Cuidador",
      perfil: "cuidador",
      pinInicial: "846201",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = (await listarUsuarios(servico(), gestor)).find((x) => x.id === r.usuarioId);
    expect(u).toMatchObject({ email: null, perfil: "cuidador", temPin: true, ativo: true });
    expect((await lerUsuario(casaA, r.usuarioId))?.pin_trocar).toBe(true);
  });

  it("recusa dados inválidos dizendo o que corrigir", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const casos: Array<[string, Parameters<typeof criarUsuario>[2], RegExp]> = [
      ["nome curto", { ...dadosDoEnfermeiro(), nome: "A" }, /nome/i],
      ["e-mail inválido", { ...dadosDoEnfermeiro(), email: "sem-arroba" }, /e-mail/i],
      [
        "sem e-mail",
        { nome: "Sem Email", perfil: "gestor", senhaInicial: "senha longa e boa 1" },
        /e-mail/i,
      ],
      ["senha fraca", { ...dadosDoEnfermeiro(), senhaInicial: "curta" }, /pelo menos 12/],
      [
        "senha com o nome",
        { ...dadosDoEnfermeiro(), nome: "Carla Souza", senhaInicial: "carla-souza-2026" },
        /nome/i,
      ],
      ["sem senha", { ...dadosDoEnfermeiro(), senhaInicial: undefined }, /senha provisória/i],
      ["cuidador sem PIN", { nome: "Sem Pin", perfil: "cuidador" }, /PIN/],
      [
        "PIN fraco",
        { nome: "Pin Fraco", perfil: "cuidador", pinInicial: "123456" },
        /fácil demais/,
      ],
      [
        "cuidador com e-mail",
        { nome: "Com Email", perfil: "cuidador", pinInicial: "846201", email: "x@y.test" },
        /e-mail/i,
      ],
      ["perfil inexistente", { ...dadosDoEnfermeiro(), perfil: "dono" as never }, /perfil/i],
    ];
    for (const [nome, dados, esperado] of casos) {
      const r = await criarUsuario(servico(), gestor, dados);
      expect(r.ok, nome).toBe(false);
      if (!r.ok && r.motivo === "dados_invalidos") {
        expect(r.problemas.join(" "), nome).toMatch(esperado);
      } else {
        expect.unreachable(`${nome}: esperava dados_invalidos`);
      }
    }
  });

  it("e-mail repetido é recusado, mesmo em maiúsculas ou de outra casa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const dados = dadosDoEnfermeiro();
    expect((await criarUsuario(servico(), gestor, dados)).ok).toBe(true);
    expect(
      await criarUsuario(servico(), gestor, { ...dados, email: dados.email.toUpperCase() }),
    ).toEqual({
      ok: false,
      motivo: "email_em_uso",
    });

    const gestorB = await criarAtorWeb(servico, migrador, casaB, "gestor", { reautenticado: true });
    expect(await criarUsuario(servico(), gestorB, dados)).toEqual({
      ok: false,
      motivo: "email_em_uso",
    });
  });

  it("só gestor cria, e só depois de confirmar a senha", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const enfermeiro = await criarAtorWeb(servico, migrador, casaA, "enfermeiro", {
      reautenticado: true,
    });
    await expect(criarUsuario(servico(), enfermeiro, dadosDoEnfermeiro())).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
    const semConfirmar = await gestorA(false);
    await expect(criarUsuario(servico(), semConfirmar, dadosDoEnfermeiro())).rejects.toBeInstanceOf(
      ErroDeReautenticacao,
    );
  });

  it("a lista de usuários mostra só a própria casa e nunca expõe credenciais", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const deB = await criarUsuarioDeTeste(migrador, casaB, { perfil: "gestor" });
    const lista = await listarUsuarios(servico(), gestor);
    expect(lista.map((u) => u.id)).toContain(gestor.usuarioId);
    expect(lista.map((u) => u.id)).not.toContain(deB.id);
    const texto = JSON.stringify(lista);
    expect(texto).not.toMatch(/argon2|hash|segredo|senha_/i);

    const enfermeiro = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    await expect(listarUsuarios(servico(), enfermeiro)).rejects.toBeInstanceOf(ErroDePermissao);
  });
});

describe("desativar e reativar", () => {
  it("desativar derruba a sessão aberta e impede novo login; reativar devolve o acesso", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const alvo = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    expect(await autenticarSessao(servico(), alvo.token)).not.toBeNull();

    expect(await desativarUsuario(servico(), gestor, { usuarioId: alvo.usuarioId })).toEqual({
      ok: true,
    });
    expect(await autenticarSessao(servico(), alvo.token)).toBeNull();
    expect(
      (await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_PADRAO })).ok,
    ).toBe(false);

    expect(await reativarUsuario(servico(), gestor, { usuarioId: alvo.usuarioId })).toEqual({
      ok: true,
    });
    // Reativar devolve o direito de entrar, mas não ressuscita a sessão que foi encerrada.
    expect(await autenticarSessao(servico(), alvo.token)).toBeNull();
    expect(
      (await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_PADRAO })).ok,
    ).toBe(true);
  });

  it("ninguém desativa a si mesmo", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    expect(await desativarUsuario(servico(), gestor, { usuarioId: gestor.usuarioId })).toEqual({
      ok: false,
      motivo: "proprio_usuario",
    });
  });

  it("a casa nunca fica sem gestor ativo, nem com dois gestores desativando um ao outro", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    // A corrida é repetida em casas novas: uma única rodada poderia passar por sorte de tempo.
    for (let rodada = 0; rodada < 15; rodada += 1) {
      const casa = await criarCasa(migrador, `Casa da corrida ${rodada}`);
      const g1 = await criarAtorWeb(servico, migrador, casa, "gestor", { reautenticado: true });
      const g2 = await criarAtorWeb(servico, migrador, casa, "gestor", { reautenticado: true });

      const resultados = await Promise.all([
        desativarUsuario(servico(), g1, { usuarioId: g2.usuarioId }),
        desativarUsuario(servico(), g2, { usuarioId: g1.usuarioId }),
      ]);
      expect(
        resultados.filter((r) => r.ok),
        `rodada ${rodada}`,
      ).toHaveLength(1);
      expect(
        resultados.filter((r) => !r.ok && r.motivo === "ultimo_gestor"),
        `rodada ${rodada}`,
      ).toHaveLength(1);

      const ativos = await comContexto(app, { casaId: casa }, async (c) => {
        const r = await c.query("SELECT 1 FROM usuario WHERE perfil = 'gestor' AND ativo");
        return r.rowCount;
      });
      expect(ativos, `rodada ${rodada}`).toBe(1);
    }
  });

  it("não alcança usuário de outra casa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const deB = await criarUsuarioDeTeste(migrador, casaB, { perfil: "enfermeiro" });
    const esperado = { ok: false, motivo: "usuario_nao_encontrado" };
    expect(await desativarUsuario(servico(), gestor, { usuarioId: deB.id })).toEqual(esperado);
    expect(await reativarUsuario(servico(), gestor, { usuarioId: deB.id })).toEqual(esperado);
    expect(await desbloquearUsuario(servico(), gestor, { usuarioId: deB.id })).toEqual(esperado);
    expect(
      await redefinirSenha(servico(), gestor, { usuarioId: deB.id, novaSenha: SENHA_NOVA }),
    ).toEqual(esperado);
    expect(await redefinirPin(servico(), gestor, { usuarioId: deB.id, novoPin: PIN_NOVO })).toEqual(
      esperado,
    );
    expect(await redefinirSegundoFator(servico(), gestor, { usuarioId: deB.id })).toEqual(esperado);
    expect((await lerUsuario(casaB, deB.id))?.ativo).toBe(true);
  });
});

describe("desbloquear e redefinir credenciais", () => {
  it("o gestor desbloqueia quem errou demais", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const alvo = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    for (let i = 0; i < POLITICA.maximoDeFalhas; i += 1) {
      await entrar(servico(), { email: alvo.usuario.email ?? "", senha: "senha-errada-123" });
    }
    expect((await lerUsuario(casaA, alvo.usuarioId))?.bloqueado_ate).not.toBeNull();
    expect(
      (await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_PADRAO })).ok,
    ).toBe(false);

    expect(await desbloquearUsuario(servico(), gestor, { usuarioId: alvo.usuarioId })).toEqual({
      ok: true,
    });
    expect(
      (await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_PADRAO })).ok,
    ).toBe(true);
  });

  it("redefinir a senha derruba as sessões, troca a senha e obriga a trocar de novo", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const alvo = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");

    expect(
      await redefinirSenha(servico(), gestor, { usuarioId: alvo.usuarioId, novaSenha: SENHA_NOVA }),
    ).toEqual({ ok: true });

    expect(await autenticarSessao(servico(), alvo.token)).toBeNull();
    expect(
      (await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_PADRAO })).ok,
    ).toBe(false);
    expect(
      await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_NOVA }),
    ).toMatchObject({ ok: true, senhaTrocar: true });
  });

  it("recusa senha fraca, senha com o nome e senha para cuidador", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const alvo = await criarUsuarioDeTeste(migrador, casaA, {
      perfil: "enfermeiro",
      nome: "Marcelo Tavares",
    });
    const cuidador = await criarUsuarioDeTeste(migrador, casaA, {
      perfil: "cuidador",
      pin: "846201",
    });

    for (const senha of ["curta", "marcelo-tavares-2026"]) {
      const r = await redefinirSenha(servico(), gestor, { usuarioId: alvo.id, novaSenha: senha });
      expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    }
    expect(
      await redefinirSenha(servico(), gestor, { usuarioId: cuidador.id, novaSenha: SENHA_NOVA }),
    ).toMatchObject({ ok: false, motivo: "dados_invalidos" });
  });

  it("redefinir o PIN desbloqueia, derruba sessões e obriga a trocar no tablet", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const { codigo } = await criarDispositivo(servico(), gestor, { nome: "Tablet" });
    const ativacao = await ativarDispositivo(servico(), { codigo });
    if (!ativacao.ok) throw new Error("ativação deveria funcionar");
    const cuidador = await criarUsuarioDeTeste(migrador, casaA, {
      perfil: "cuidador",
      pin: "846201",
    });

    expect(
      await redefinirPin(servico(), gestor, { usuarioId: cuidador.id, novoPin: "123456" }),
    ).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
    expect(
      await redefinirPin(servico(), gestor, { usuarioId: cuidador.id, novoPin: PIN_NOVO }),
    ).toEqual({
      ok: true,
    });

    const antigo = await entrarComPin(servico(), {
      tokenDoDispositivo: ativacao.token,
      usuarioId: cuidador.id,
      pin: "846201",
    });
    expect(antigo.ok).toBe(false);
    const novo = await entrarComPin(servico(), {
      tokenDoDispositivo: ativacao.token,
      usuarioId: cuidador.id,
      pin: PIN_NOVO,
    });
    expect(novo).toMatchObject({ ok: true, pinTrocar: true });
  });

  it("celular perdido: apagar o autenticador derruba as sessões e pede novo cadastro", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const alvo = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    expect(await redefinirSegundoFator(servico(), gestor, { usuarioId: alvo.usuarioId })).toEqual({
      ok: true,
    });
    expect(await autenticarSessao(servico(), alvo.token)).toBeNull();
    expect((await lerUsuario(casaA, alvo.usuarioId))?.totp_ativo).toBe(false);
    expect(
      await entrar(servico(), { email: alvo.usuario.email ?? "", senha: SENHA_PADRAO }),
    ).toMatchObject({ ok: true, etapa: "configurar_segundo_fator" });
  });

  it("todas essas ações exigem gestor com a senha confirmada", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const alvo = await criarUsuarioDeTeste(migrador, casaA, { perfil: "enfermeiro" });
    const enfermeiro = await criarAtorWeb(servico, migrador, casaA, "enfermeiro", {
      reautenticado: true,
    });
    const semConfirmar = await gestorA(false);

    const acoes = [
      (a: AtorWeb) => desativarUsuario(servico(), a, { usuarioId: alvo.id }),
      (a: AtorWeb) => reativarUsuario(servico(), a, { usuarioId: alvo.id }),
      (a: AtorWeb) => desbloquearUsuario(servico(), a, { usuarioId: alvo.id }),
      (a: AtorWeb) => redefinirSenha(servico(), a, { usuarioId: alvo.id, novaSenha: SENHA_NOVA }),
      (a: AtorWeb) => redefinirPin(servico(), a, { usuarioId: alvo.id, novoPin: PIN_NOVO }),
      (a: AtorWeb) => redefinirSegundoFator(servico(), a, { usuarioId: alvo.id }),
    ];
    for (const acao of acoes) {
      await expect(acao(enfermeiro)).rejects.toBeInstanceOf(ErroDePermissao);
      await expect(acao(semConfirmar)).rejects.toBeInstanceOf(ErroDeReautenticacao);
    }
    expect((await lerUsuario(casaA, alvo.id))?.ativo).toBe(true);
  });
});

describe("trocar a própria senha e PIN", () => {
  it("troca a senha, mantém a sessão atual e derruba as outras", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const ator = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    // Segunda sessão da mesma pessoa (outro navegador).
    const outra = await entrar(servico(), { email: ator.usuario.email ?? "", senha: SENHA_PADRAO });
    expect(outra.ok).toBe(true);

    const r = await trocarMinhaSenha(servico(), ator, {
      senhaAtual: SENHA_PADRAO,
      novaSenha: SENHA_NOVA,
    });
    expect(r).toEqual({ ok: true });

    expect(await autenticarSessao(servico(), ator.token)).toMatchObject({ senhaTrocar: false });
    if (outra.ok) {
      expect(
        (
          await comContexto(app, { casaId: casaA }, (c) =>
            c.query(
              "SELECT revogada_em FROM sessao WHERE usuario_id = $1 AND revogada_em IS NULL",
              [ator.usuarioId],
            ),
          )
        ).rowCount,
      ).toBe(1);
    }
    expect(
      (await entrar(servico(), { email: ator.usuario.email ?? "", senha: SENHA_PADRAO })).ok,
    ).toBe(false);
    expect(
      (await entrar(servico(), { email: ator.usuario.email ?? "", senha: SENHA_NOVA })).ok,
    ).toBe(true);
  });

  it("senha atual errada não troca e conta como tentativa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const ator = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    const r = await trocarMinhaSenha(servico(), ator, {
      senhaAtual: "senha-errada-123",
      novaSenha: SENHA_NOVA,
    });
    expect(r).toEqual({ ok: false, motivo: "credencial_atual_incorreta" });
    expect((await lerUsuario(casaA, ator.usuarioId))?.tentativas_falhas).toBe(1);
  });

  it("recusa nova senha fraca ou igual à atual", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const ator = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
    expect(
      await trocarMinhaSenha(servico(), ator, { senhaAtual: SENHA_PADRAO, novaSenha: "curta" }),
    ).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    expect(
      await trocarMinhaSenha(servico(), ator, {
        senhaAtual: SENHA_PADRAO,
        novaSenha: SENHA_PADRAO,
      }),
    ).toMatchObject({ ok: false, motivo: "dados_invalidos" });
  });

  it("no tablet, o cuidador troca o PIN provisório confirmando o atual", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const { codigo } = await criarDispositivo(servico(), gestor, { nome: "Tablet" });
    const ativacao = await ativarDispositivo(servico(), { codigo });
    if (!ativacao.ok) throw new Error("ativação deveria funcionar");
    const criado = await criarUsuario(servico(), gestor, {
      nome: "Dora Cuidadora",
      perfil: "cuidador",
      pinInicial: "846201",
    });
    if (!criado.ok) throw new Error("criação deveria funcionar");

    const entrada = await entrarComPin(servico(), {
      tokenDoDispositivo: ativacao.token,
      usuarioId: criado.usuarioId,
      pin: "846201",
    });
    if (!entrada.ok) throw new Error("PIN deveria ser aceito");
    const sessao = await autenticarSessao(servico(), entrada.token);
    if (!sessao) throw new Error("sessão deveria valer");
    expect(sessao.pinTrocar).toBe(true);

    expect(
      await trocarMeuPin(servico(), sessao, { pinAtual: "000001", novoPin: PIN_NOVO }),
    ).toEqual({
      ok: false,
      motivo: "credencial_atual_incorreta",
    });
    expect(
      await trocarMeuPin(servico(), sessao, { pinAtual: "846201", novoPin: "111111" }),
    ).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
    expect(
      await trocarMeuPin(servico(), sessao, { pinAtual: "846201", novoPin: PIN_NOVO }),
    ).toEqual({
      ok: true,
    });
    expect((await autenticarSessao(servico(), entrada.token))?.pinTrocar).toBe(false);
  });

  it("quem não tem senha (cuidador) não consegue 'trocar' uma senha", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const { codigo } = await criarDispositivo(servico(), gestor, { nome: "Tablet" });
    const ativacao = await ativarDispositivo(servico(), { codigo });
    if (!ativacao.ok) throw new Error("ativação deveria funcionar");
    const cuidador = await criarUsuarioDeTeste(migrador, casaA, {
      perfil: "cuidador",
      pin: "846201",
    });
    const entrada = await entrarComPin(servico(), {
      tokenDoDispositivo: ativacao.token,
      usuarioId: cuidador.id,
      pin: "846201",
    });
    if (!entrada.ok) throw new Error("PIN deveria ser aceito");
    const sessao = await autenticarSessao(servico(), entrada.token);
    if (!sessao) throw new Error("sessão deveria valer");
    expect(
      await trocarMinhaSenha(servico(), sessao, { senhaAtual: "qualquer", novaSenha: SENHA_NOVA }),
    ).toEqual({ ok: false, motivo: "sem_credencial" });
  });
});

describe("auditoria da gestão de usuários", () => {
  it("registra quem fez o quê e nunca grava senha, PIN ou hash", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await gestorA();
    const dados = dadosDoEnfermeiro();
    const criado = await criarUsuario(servico(), gestor, dados);
    if (!criado.ok) throw new Error("criação deveria funcionar");
    await redefinirSenha(servico(), gestor, { usuarioId: criado.usuarioId, novaSenha: SENHA_NOVA });
    await desativarUsuario(servico(), gestor, { usuarioId: criado.usuarioId });

    const linhas = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{ acao: string; usuario_id: string }>(
        "SELECT acao, usuario_id FROM auditoria WHERE entidade_id = $1 ORDER BY seq",
        [criado.usuarioId],
      );
      return r.rows;
    });
    expect(linhas.map((l) => l.acao)).toEqual([
      "usuario.criado",
      "usuario.senha_redefinida",
      "usuario.desativado",
    ]);
    expect(linhas.every((l) => l.usuario_id === gestor.usuarioId)).toBe(true);

    const tudo = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query("SELECT to_jsonb(a) AS linha FROM auditoria a");
      return JSON.stringify(r.rows);
    });
    for (const proibido of [dados.senhaInicial, SENHA_NOVA, SENHA_PADRAO, "$argon2"]) {
      expect(tudo).not.toContain(proibido);
    }
  });
});
