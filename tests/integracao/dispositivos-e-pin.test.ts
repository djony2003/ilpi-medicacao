import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar } from "@/compartilhado/criptografia";
import { hashDeToken } from "@/compartilhado/tokens";
import {
  ErroDePermissao,
  ErroDeReautenticacao,
  POLITICA,
  ativarDispositivo,
  autenticarSessao,
  criarDispositivo,
  entrar,
  entrarComPin,
  gerarCodigo,
  gerarSegredoTotp,
  listarDispositivos,
  listarUsuariosParaPin,
  localizarDispositivo,
  passoDe,
  reautenticar,
  revogarDispositivo,
  verificarSegundoFator,
  type Servico,
} from "@/modules/identidade";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { SENHA_PADRAO, criarCasa, criarUsuario } from "../ajudantes/dados";
import { criarAtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const PIN = "482916";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let agora: Date;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });

/** Entra na web (senha + segundo fator) e devolve a sessão autenticada da casa A. */
const atorWeb = (
  perfil: "gestor" | "enfermeiro" = "gestor",
  opcoes: { reautenticado?: boolean } = {},
) => criarAtorWeb(servico, migrador, casaA, perfil, opcoes);

/** Cria e ativa um tablet na casa A. */
async function tabletAtivo(nome = "Tablet do posto") {
  const gestor = await atorWeb("gestor", { reautenticado: true });
  const { codigo, dispositivoId } = await criarDispositivo(servico(), gestor, { nome });
  const ativacao = await ativarDispositivo(servico(), { codigo });
  if (!ativacao.ok) throw new Error("ativação deveria funcionar");
  return { gestor, dispositivoId, tokenDoTablet: ativacao.token, codigo };
}

async function auditoria(acao: string) {
  return comContexto(app, { casaId: casaA }, async (c) => {
    const r = await c.query<{ usuario_id: string | null; dispositivo_id: string | null }>(
      "SELECT usuario_id, dispositivo_id FROM auditoria WHERE acao = $1",
      [acao],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  casaA = await criarCasa(migrador, "Casa A dos Aparelhos");
  casaB = await criarCasa(migrador, "Casa B dos Aparelhos");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("aprovação de aparelhos", () => {
  it("só gestor cria aparelho", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const enfermeiro = await atorWeb("enfermeiro", { reautenticado: true });
    await expect(
      criarDispositivo(servico(), enfermeiro, { nome: "Tablet" }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(listarDispositivos(servico(), enfermeiro)).rejects.toBeInstanceOf(ErroDePermissao);
  });

  it("exige senha digitada de novo há pouco tempo", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const semConfirmar = await atorWeb("gestor");
    await expect(
      criarDispositivo(servico(), semConfirmar, { nome: "Tablet" }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);

    const confirmado = await atorWeb("gestor", { reautenticado: true });
    await expect(
      criarDispositivo(servico(), confirmado, { nome: "Tablet" }),
    ).resolves.toBeDefined();

    // A confirmação vale por poucos minutos.
    agora = new Date(agora.getTime() + POLITICA.reautenticacaoMs + 1000);
    const renovada = await autenticarSessao(servico(), confirmado.token);
    if (!renovada) throw new Error("sessão deveria valer");
    await expect(criarDispositivo(servico(), renovada, { nome: "Tablet" })).rejects.toBeInstanceOf(
      ErroDeReautenticacao,
    );
  });

  it("senha errada na confirmação não vale e conta como tentativa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await atorWeb("gestor");
    expect((await reautenticar(servico(), gestor, { segredo: "senha-errada-123" })).ok).toBe(false);
    const depois = await autenticarSessao(servico(), gestor.token);
    expect(depois?.reautenticadoEm).toBeNull();
    const falhas = await auditoria("reautenticacao.falha");
    expect(falhas.some((f) => f.usuario_id === gestor.usuarioId)).toBe(true);
  });

  it("valida o nome do aparelho", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await atorWeb("gestor", { reautenticado: true });
    await expect(criarDispositivo(servico(), gestor, { nome: "   " })).rejects.toThrow(/nome/);
    await expect(criarDispositivo(servico(), gestor, { nome: "x".repeat(81) })).rejects.toThrow(
      /nome/,
    );
  });

  it("o código ativa uma vez só e vira token; o banco guarda apenas hashes", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await atorWeb("gestor", { reautenticado: true });
    const { codigo, dispositivoId, expiraEm } = await criarDispositivo(servico(), gestor, {
      nome: "Tablet 1",
    });
    expect(codigo).toMatch(/^[A-Z2-9]{10}$/);
    expect(expiraEm.getTime()).toBe(agora.getTime() + POLITICA.codigoDeAtivacaoMs);

    const aguardando = await listarDispositivos(servico(), gestor);
    expect(aguardando.find((d) => d.id === dispositivoId)?.situacao).toBe("aguardando_ativacao");

    // Quem digita o código no tablet pode usar minúsculas, espaços e hífens.
    const digitado = `${codigo.slice(0, 5).toLowerCase()} - ${codigo.slice(5)}`;
    const ativacao = await ativarDispositivo(servico(), { codigo: digitado });
    expect(ativacao).toMatchObject({ ok: true, dispositivoId, nome: "Tablet 1" });
    if (!ativacao.ok) return;

    // O mesmo código não serve de novo.
    expect(await ativarDispositivo(servico(), { codigo })).toEqual({
      ok: false,
      motivo: "codigo_invalido",
    });

    const linha = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query<{
        token_hash: string;
        codigo_ativacao_hash: string | null;
        codigo_expira_em: Date | null;
      }>(
        "SELECT token_hash, codigo_ativacao_hash, codigo_expira_em FROM dispositivo WHERE id = $1",
        [dispositivoId],
      );
      return r.rows[0];
    });
    expect(linha?.token_hash).toBe(hashDeToken(ativacao.token));
    expect(linha?.codigo_ativacao_hash).toBeNull();
    expect(linha?.codigo_expira_em).toBeNull();

    const ativo = await listarDispositivos(servico(), gestor);
    expect(ativo.find((d) => d.id === dispositivoId)?.situacao).toBe("ativo");
    expect(await localizarDispositivo(servico(), ativacao.token)).toMatchObject({
      id: dispositivoId,
      casaId: casaA,
    });
  });

  it("código expirado, inexistente ou de tamanho errado não ativa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await atorWeb("gestor", { reautenticado: true });
    const { codigo } = await criarDispositivo(servico(), gestor, { nome: "Tablet vencido" });

    agora = new Date(agora.getTime() + POLITICA.codigoDeAtivacaoMs + 1000);
    for (const tentativa of [codigo, "AAAAAAAAAA", "", "CURTO", `${codigo}${codigo}`]) {
      expect((await ativarDispositivo(servico(), { codigo: tentativa })).ok).toBe(false);
    }
  });

  it("dois tablets digitando o mesmo código ao mesmo tempo: só um ativa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await atorWeb("gestor", { reautenticado: true });
    const { codigo } = await criarDispositivo(servico(), gestor, { nome: "Disputado" });
    const resultados = await Promise.all(
      Array.from({ length: 4 }, () => ativarDispositivo(servico(), { codigo })),
    );
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
  });

  it("token de aparelho inexistente, vazio ou gigante não vale", async () => {
    for (const token of ["", "nao-existe", "a".repeat(5000)]) {
      expect(await localizarDispositivo(servico(), token)).toBeNull();
    }
  });
});

describe("login por PIN no tablet", () => {
  it("lista só quem tem PIN e está ativo, da casa do aparelho", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const comPin = await criarUsuario(migrador, casaA, {
      perfil: "cuidador",
      nome: "Ana Cuidadora",
      pin: PIN,
    });
    const semPin = await criarUsuario(migrador, casaA, { perfil: "cuidador", nome: "Sem PIN" });
    const inativo = await criarUsuario(migrador, casaA, {
      perfil: "cuidador",
      nome: "Inativo",
      pin: PIN,
    });
    await comContexto(migrador, { casaId: casaA }, (c) =>
      c.query("UPDATE usuario SET ativo = false WHERE id = $1", [inativo.id]),
    );
    const deOutraCasa = await criarUsuario(migrador, casaB, {
      perfil: "cuidador",
      nome: "Outra Casa",
      pin: PIN,
    });

    const lista = await listarUsuariosParaPin(servico(), tokenDoTablet);
    const ids = lista?.map((u) => u.id) ?? [];
    expect(ids).toContain(comPin.id);
    expect(ids).not.toContain(semPin.id);
    expect(ids).not.toContain(inativo.id);
    expect(ids).not.toContain(deOutraCasa.id);
    // A lista traz só o necessário para a tela do PIN.
    expect(Object.keys(lista?.find((u) => u.id === comPin.id) ?? {}).sort()).toEqual([
      "id",
      "nome",
      "perfil",
    ]);

    expect(await listarUsuariosParaPin(servico(), "token-falso")).toBeNull();
  });

  it("PIN certo abre sessão do tablet, ligada ao aparelho e auditada", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet, dispositivoId } = await tabletAtivo();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });

    const r = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: cuidador.id,
      pin: PIN,
      ip: "198.51.100.4",
    });
    expect(r).toMatchObject({ ok: true, pinTrocar: false });
    if (!r.ok) return;

    expect(await autenticarSessao(servico(), r.token)).toMatchObject({
      casaId: casaA,
      usuarioId: cuidador.id,
      perfil: "cuidador",
      tipo: "tablet",
      dispositivoId,
    });

    const eventos = await auditoria("login.pin_sucesso");
    expect(
      eventos.some((e) => e.usuario_id === cuidador.id && e.dispositivo_id === dispositivoId),
    ).toBe(true);
  });

  it("avisa quando o PIN foi definido pelo gestor e precisa ser trocado", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const novo = await criarUsuario(migrador, casaA, {
      perfil: "cuidador",
      pin: PIN,
      pinTrocar: true,
    });
    const r = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: novo.id,
      pin: PIN,
    });
    expect(r).toMatchObject({ ok: true, pinTrocar: true });
    if (!r.ok) return;
    expect((await autenticarSessao(servico(), r.token))?.pinTrocar).toBe(true);
  });

  it("PIN errado: mesma resposta para qualquer motivo de recusa", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    const semPin = await criarUsuario(migrador, casaA, { perfil: "cuidador" });
    const naoExiste = "00000000-0000-4000-8000-000000000000";

    const respostas = await Promise.all([
      entrarComPin(servico(), {
        tokenDoDispositivo: tokenDoTablet,
        usuarioId: cuidador.id,
        pin: "000001",
      }),
      entrarComPin(servico(), {
        tokenDoDispositivo: tokenDoTablet,
        usuarioId: semPin.id,
        pin: PIN,
      }),
      entrarComPin(servico(), {
        tokenDoDispositivo: tokenDoTablet,
        usuarioId: naoExiste,
        pin: PIN,
      }),
      entrarComPin(servico(), {
        tokenDoDispositivo: "token-falso",
        usuarioId: cuidador.id,
        pin: PIN,
      }),
    ]);
    for (const r of respostas) expect(r).toEqual({ ok: false, motivo: "credenciais_invalidas" });
  });

  it("recusa PIN malformado e identificador que não é UUID", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    for (const pin of ["", "12345", "1234567", "abcdef", "48291 ", "' OR 1=1 --"]) {
      expect(
        (
          await entrarComPin(servico(), {
            tokenDoDispositivo: tokenDoTablet,
            usuarioId: cuidador.id,
            pin,
          })
        ).ok,
      ).toBe(false);
    }
    expect(
      (
        await entrarComPin(servico(), {
          tokenDoDispositivo: tokenDoTablet,
          usuarioId: "nao-uuid",
          pin: PIN,
        })
      ).ok,
    ).toBe(false);
  });

  it("5 PINs errados bloqueiam o usuário; passado o prazo ele volta", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    const entrada = (pin: string) => ({
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: cuidador.id,
      pin,
    });

    for (let i = 0; i < POLITICA.tablet.maximoDeFalhasDePin; i += 1) {
      expect((await entrarComPin(servico(), entrada("000001"))).ok).toBe(false);
    }
    // Bloqueado: nem o PIN certo entra.
    expect((await entrarComPin(servico(), entrada(PIN))).ok).toBe(false);

    agora = new Date(agora.getTime() + POLITICA.bloqueioMs + 1000);
    expect((await entrarComPin(servico(), entrada(PIN))).ok).toBe(true);

    const bloqueios = await auditoria("login.conta_bloqueada");
    expect(bloqueios.some((b) => b.usuario_id === cuidador.id && b.dispositivo_id !== null)).toBe(
      true,
    );
  });

  it("5 chutes simultâneos de PIN não passam do limite", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    const chutes = Array.from({ length: 12 }, (_, i) =>
      entrarComPin(servico(), {
        tokenDoDispositivo: tokenDoTablet,
        usuarioId: cuidador.id,
        pin: String(100000 + i),
      }),
    );
    await Promise.all(chutes);
    const falhas = (await auditoria("login.pin_falha")).filter((e) => e.usuario_id === cuidador.id);
    expect(falhas).toHaveLength(POLITICA.tablet.maximoDeFalhasDePin);
  });

  it("aparelho da casa A não abre usuário da casa B", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const deB = await criarUsuario(migrador, casaB, { perfil: "cuidador", pin: PIN });
    const r = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: deB.id,
      pin: PIN,
    });
    expect(r).toEqual({ ok: false, motivo: "credenciais_invalidas" });
    // E o contador do usuário da outra casa não foi mexido.
    const falhas = await comContexto(migrador, { casaId: casaB }, async (c) => {
      const x = await c.query("SELECT tentativas_falhas FROM usuario WHERE id = $1", [deB.id]);
      return x.rows[0]?.tentativas_falhas;
    });
    expect(falhas).toBe(0);
  });

  it("sessão do tablet expira em 2 minutos sem uso, e cada toque renova", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    const r = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: cuidador.id,
      pin: PIN,
    });
    if (!r.ok) throw new Error("PIN deveria ser aceito");

    expect(POLITICA.tablet.inatividadeSegundos).toBe(120);
    agora = new Date(agora.getTime() + 100_000);
    expect(await autenticarSessao(servico(), r.token)).not.toBeNull();
    agora = new Date(agora.getTime() + 100_000);
    expect(await autenticarSessao(servico(), r.token)).not.toBeNull();
    agora = new Date(agora.getTime() + 121_000);
    expect(await autenticarSessao(servico(), r.token)).toBeNull();
  });

  it("quem assume o posto encerra a sessão de quem estava antes", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const turnoA = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    const turnoB = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: "735194" });

    const a = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: turnoA.id,
      pin: PIN,
    });
    const b = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: turnoB.id,
      pin: "735194",
    });
    if (!a.ok || !b.ok) throw new Error("PINs deveriam ser aceitos");
    expect(await autenticarSessao(servico(), a.token)).toBeNull();
    expect(await autenticarSessao(servico(), b.token)).not.toBeNull();
  });

  it("PIN do tablet confirma identidade para ação sensível", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { tokenDoTablet } = await tabletAtivo();
    const enfermeira = await criarUsuario(migrador, casaA, { perfil: "enfermeiro", pin: PIN });
    const r = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: enfermeira.id,
      pin: PIN,
    });
    if (!r.ok) throw new Error("PIN deveria ser aceito");
    const sessao = await autenticarSessao(servico(), r.token);
    if (!sessao) throw new Error("sessão deveria valer");

    // Na sessão do tablet a confirmação é pelo PIN, não pela senha.
    expect((await reautenticar(servico(), sessao, { segredo: SENHA_PADRAO })).ok).toBe(false);
    expect((await reautenticar(servico(), sessao, { segredo: PIN })).ok).toBe(true);
    expect((await autenticarSessao(servico(), r.token))?.reautenticadoEm).not.toBeNull();
  });
});

describe("revogação de aparelho", () => {
  it("derruba as sessões do tablet e impede novo uso na hora", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { gestor, dispositivoId, tokenDoTablet } = await tabletAtivo("Tablet perdido");
    const cuidador = await criarUsuario(migrador, casaA, { perfil: "cuidador", pin: PIN });
    const r = await entrarComPin(servico(), {
      tokenDoDispositivo: tokenDoTablet,
      usuarioId: cuidador.id,
      pin: PIN,
    });
    if (!r.ok) throw new Error("PIN deveria ser aceito");
    expect(await autenticarSessao(servico(), r.token)).not.toBeNull();

    expect(await revogarDispositivo(servico(), gestor, { dispositivoId })).toBe(true);

    expect(await autenticarSessao(servico(), r.token)).toBeNull();
    expect(await localizarDispositivo(servico(), tokenDoTablet)).toBeNull();
    expect(await listarUsuariosParaPin(servico(), tokenDoTablet)).toBeNull();
    expect(
      (
        await entrarComPin(servico(), {
          tokenDoDispositivo: tokenDoTablet,
          usuarioId: cuidador.id,
          pin: PIN,
        })
      ).ok,
    ).toBe(false);

    const lista = await listarDispositivos(servico(), gestor);
    expect(lista.find((d) => d.id === dispositivoId)?.situacao).toBe("revogado");
    // Revogar duas vezes não faz mal nem repete a auditoria.
    expect(await revogarDispositivo(servico(), gestor, { dispositivoId })).toBe(false);
    const revogacoes = await auditoria("dispositivo.revogado");
    expect(revogacoes.filter((e) => e.usuario_id === gestor.usuarioId)).toHaveLength(1);
  });

  it("revogar também cancela um código que ainda não foi usado", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const gestor = await atorWeb("gestor", { reautenticado: true });
    const { codigo, dispositivoId } = await criarDispositivo(servico(), gestor, {
      nome: "Cancelado",
    });
    expect(await revogarDispositivo(servico(), gestor, { dispositivoId })).toBe(true);
    expect((await ativarDispositivo(servico(), { codigo })).ok).toBe(false);
  });

  it("exige gestor e confirmação de senha", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { dispositivoId } = await tabletAtivo();
    const enfermeiro = await atorWeb("enfermeiro", { reautenticado: true });
    await expect(
      revogarDispositivo(servico(), enfermeiro, { dispositivoId }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    const semConfirmar = await atorWeb("gestor");
    await expect(
      revogarDispositivo(servico(), semConfirmar, { dispositivoId }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
  });

  it("um gestor da casa B não enxerga nem revoga aparelhos da casa A", async () => {
    agora = new Date("2026-03-10T12:00:00Z");
    const { dispositivoId, tokenDoTablet } = await tabletAtivo();

    const segredo = gerarSegredoTotp();
    const gestorB = await criarUsuario(migrador, casaB, {
      perfil: "gestor",
      totpSegredoCifrado: cifrar(segredo, CHAVE),
      totpAtivo: true,
    });
    const e1 = await entrar(servico(), { email: gestorB.email ?? "", senha: SENHA_PADRAO });
    if (!e1.ok) throw new Error("senha deveria ser aceita");
    await verificarSegundoFator(servico(), {
      token: e1.token,
      codigo: gerarCodigo(segredo, passoDe(agora.getTime())),
    });
    const sessaoB0 = await autenticarSessao(servico(), e1.token);
    if (!sessaoB0) throw new Error("sessão deveria valer");
    await reautenticar(servico(), sessaoB0, { segredo: SENHA_PADRAO });
    const sessaoB = await autenticarSessao(servico(), e1.token);
    if (!sessaoB) throw new Error("sessão deveria valer");

    expect((await listarDispositivos(servico(), sessaoB)).map((d) => d.id)).not.toContain(
      dispositivoId,
    );
    expect(await revogarDispositivo(servico(), sessaoB, { dispositivoId })).toBe(false);
    expect(await localizarDispositivo(servico(), tokenDoTablet)).not.toBeNull();
  });
});
