import type { PoolClient } from "pg";
import { comBusca } from "@/compartilhado/banco/busca";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar, decifrar } from "@/compartilhado/criptografia";
import { registrarAuditoria } from "@/modules/auditoria";
import { POLITICA } from "../dominio/politica";
import { TAMANHO_MAXIMO_SENHA } from "../dominio/senha";
import { gerarSegredoTotp, montarUriTotp, verificarCodigo } from "../dominio/totp";
import { gastarTempoDeVerificacao, verificarSenhaHash } from "./hash-senha";
import { criarSessao, localizarSessao, revogarSessoesDoUsuario } from "./sessao";
import { relogio, type Servico } from "./servico";

// Login de gestor e enfermeiro na web: senha, depois segundo fator (aplicativo autenticador).
//
// Princípios:
// - A resposta ao usuário nunca diz se o e-mail existe, se a conta está bloqueada ou qual passo
//   falhou. Quem precisa do motivo exato é a auditoria, que registra tudo.
// - Falhas de senha e de segundo fator contam no MESMO contador. Sem isso, o código de 6 dígitos
//   poderia ser adivinhado à vontade por quem já tem a senha.
// - O contador só zera quando o login COMPLETO termina. Entrar com a senha certa não o zera.
// - Cada tentativa trava a linha do usuário (FOR UPDATE): tentativas simultâneas se enfileiram e
//   não conseguem passar do limite correndo em paralelo.

const NEGADO = { ok: false, motivo: "credenciais_invalidas" } as const;

export type ResultadoDaSenha =
  | {
      ok: true;
      /** Token da sessão ainda incompleta. Só serve para a etapa seguinte. */
      token: string;
      etapa: "segundo_fator" | "configurar_segundo_fator";
      senhaTrocar: boolean;
    }
  | typeof NEGADO;

export type ResultadoDoSegundoFator =
  { ok: true; token: string; senhaTrocar: boolean } | typeof NEGADO;

type UsuarioParaLogin = {
  id: string;
  perfil: "gestor" | "enfermeiro" | "cuidador";
  email: string | null;
  senha_hash: string | null;
  senha_trocar: boolean;
  ativo: boolean;
  totp_ativo: boolean;
  totp_segredo_cifrado: string | null;
  totp_ultimo_passo: string | null;
  tentativas_falhas: number;
  bloqueado_ate: Date | null;
  casa_ativa: boolean;
};

async function carregarUsuarioTravado(
  c: PoolClient,
  usuarioId: string,
): Promise<UsuarioParaLogin | null> {
  const r = await c.query<UsuarioParaLogin>(
    `SELECT u.id, u.perfil, u.email, u.senha_hash, u.senha_trocar, u.ativo, u.totp_ativo,
            u.totp_segredo_cifrado, u.totp_ultimo_passo::text AS totp_ultimo_passo,
            u.tentativas_falhas, u.bloqueado_ate, k.ativa AS casa_ativa
       FROM usuario u
       JOIN casa k ON k.id = u.casa_id
      WHERE u.id = $1
      FOR UPDATE OF u`,
    [usuarioId],
  );
  return r.rows[0] ?? null;
}

function podeEntrar(u: UsuarioParaLogin | null): u is UsuarioParaLogin {
  return u !== null && u.ativo && u.casa_ativa && u.perfil !== "cuidador";
}

/**
 * Soma uma falha. Ao atingir o limite, bloqueia a conta por um período e encerra as sessões
 * abertas dela. Devolve true se esta falha causou o bloqueio.
 */
async function registrarFalha(
  c: PoolClient,
  u: UsuarioParaLogin,
  agora: Date,
  acao: "login.falha" | "login.mfa_falha",
  ip: string | null | undefined,
): Promise<boolean> {
  const falhas = u.tentativas_falhas + 1;
  const bloqueia = falhas >= POLITICA.maximoDeFalhas;

  if (bloqueia) {
    await c.query("UPDATE usuario SET tentativas_falhas = 0, bloqueado_ate = $2 WHERE id = $1", [
      u.id,
      new Date(agora.getTime() + POLITICA.bloqueioMs),
    ]);
    await revogarSessoesDoUsuario(c, u.id, agora);
  } else {
    await c.query("UPDATE usuario SET tentativas_falhas = $2 WHERE id = $1", [u.id, falhas]);
  }

  await registrarAuditoria(c, {
    acao,
    entidade: "usuario",
    entidadeId: u.id,
    depois: { tentativas: falhas },
    ip,
  });
  if (bloqueia) {
    await registrarAuditoria(c, {
      acao: "login.conta_bloqueada",
      entidade: "usuario",
      entidadeId: u.id,
      depois: { bloqueioMinutos: POLITICA.bloqueioMs / 60_000 },
      ip,
    });
  }
  return bloqueia;
}

function estaBloqueado(u: UsuarioParaLogin, agora: Date): boolean {
  return u.bloqueado_ate !== null && u.bloqueado_ate.getTime() > agora.getTime();
}

/** Etapa 1: e-mail e senha. Se der certo, abre uma sessão incompleta (sem acesso a nada). */
export async function entrar(
  servico: Servico,
  entrada: { email: string; senha: string; ip?: string | null },
): Promise<ResultadoDaSenha> {
  const email = entrada.email.trim().toLowerCase();
  const { senha, ip } = entrada;

  // Limites de tamanho evitam gastar processamento de hash com entradas absurdas.
  if (
    email.length === 0 ||
    email.length > 254 ||
    senha.length === 0 ||
    senha.length > TAMANHO_MAXIMO_SENHA
  ) {
    await gastarTempoDeVerificacao(senha.slice(0, TAMANHO_MAXIMO_SENHA));
    return NEGADO;
  }

  const achado = await comBusca(servico.pool, "login_email", email, async (c) => {
    const r = await c.query<{ id: string; casa_id: string }>(
      "SELECT id, casa_id FROM usuario WHERE email = $1",
      [email],
    );
    return r.rows[0] ?? null;
  });
  if (!achado) {
    await gastarTempoDeVerificacao(senha);
    return NEGADO;
  }

  const agora = relogio(servico);
  return comContexto(
    servico.pool,
    { casaId: achado.casa_id, usuarioId: achado.id },
    async (c): Promise<ResultadoDaSenha> => {
      const u = await carregarUsuarioTravado(c, achado.id);
      if (!podeEntrar(u) || u.senha_hash === null) {
        await gastarTempoDeVerificacao(senha);
        if (u) {
          await registrarAuditoria(c, {
            acao: "login.recusado",
            entidade: "usuario",
            entidadeId: u.id,
            depois: { motivo: u.ativo ? "sem_acesso" : "usuario_inativo" },
            ip,
          });
        }
        return NEGADO;
      }

      if (estaBloqueado(u, agora)) {
        await gastarTempoDeVerificacao(senha);
        await registrarAuditoria(c, {
          acao: "login.bloqueado",
          entidade: "usuario",
          entidadeId: u.id,
          ip,
        });
        return NEGADO;
      }

      if (!(await verificarSenhaHash(u.senha_hash, senha))) {
        await registrarFalha(c, u, agora, "login.falha", ip);
        return NEGADO;
      }

      const token = await criarSessao(c, {
        casaId: achado.casa_id,
        usuarioId: u.id,
        tipo: "web",
        mfaOk: false,
        duracaoMs: POLITICA.web.segundoFatorMs,
        inatividadeSegundos: POLITICA.web.inatividadeSegundos,
        ip,
        agora,
      });
      await registrarAuditoria(c, {
        acao: "login.senha_ok",
        entidade: "usuario",
        entidadeId: u.id,
        ip,
      });
      return {
        ok: true,
        token,
        etapa: u.totp_ativo ? "segundo_fator" : "configurar_segundo_fator",
        senhaTrocar: u.senha_trocar,
      };
    },
  );
}

type SessaoPendente = { id: string };

/**
 * Executa uma etapa que só vale para sessão incompleta: web, não revogada, dentro do prazo e
 * ainda sem segundo fator. Trava usuário e sessão, e devolve NEGADO em qualquer outro caso.
 */
async function naSessaoPendente<T>(
  servico: Servico,
  token: string,
  fn: (c: PoolClient, u: UsuarioParaLogin, sessao: SessaoPendente, agora: Date) => Promise<T>,
): Promise<T | typeof NEGADO> {
  const achada = await localizarSessao(servico, token);
  if (!achada) return NEGADO;
  const agora = relogio(servico);

  return comContexto(
    servico.pool,
    { casaId: achada.casa_id, usuarioId: achada.usuario_id },
    async (c) => {
      const u = await carregarUsuarioTravado(c, achada.usuario_id);
      if (!podeEntrar(u)) return NEGADO;

      const r = await c.query<{
        id: string;
        tipo: string;
        mfa_ok: boolean;
        expira_em: Date;
        revogada_em: Date | null;
      }>("SELECT id, tipo, mfa_ok, expira_em, revogada_em FROM sessao WHERE id = $1 FOR UPDATE", [
        achada.id,
      ]);
      const s = r.rows[0];
      if (
        !s ||
        s.tipo !== "web" ||
        s.mfa_ok ||
        s.revogada_em !== null ||
        s.expira_em.getTime() <= agora.getTime() ||
        estaBloqueado(u, agora)
      ) {
        return NEGADO;
      }
      return fn(c, u, { id: s.id }, agora);
    },
  );
}

async function concluirLogin(
  c: PoolClient,
  u: UsuarioParaLogin,
  sessaoId: string,
  passo: number,
  agora: Date,
  casaId: string,
  ip: string | null | undefined,
): Promise<void> {
  await c.query(
    `UPDATE usuario
        SET totp_ultimo_passo = $2, tentativas_falhas = 0, bloqueado_ate = NULL
      WHERE id = $1`,
    [u.id, passo],
  );
  await c.query(
    `UPDATE sessao
        SET mfa_ok = true, ultimo_uso_em = $2, expira_em = $3, inatividade_segundos = $4
      WHERE id = $1`,
    [
      sessaoId,
      agora,
      new Date(agora.getTime() + POLITICA.web.duracaoMaximaMs),
      POLITICA.web.inatividadeSegundos,
    ],
  );
  await registrarAuditoria(c, {
    acao: "login.sucesso",
    entidade: "usuario",
    entidadeId: u.id,
    depois: { casaId },
    ip,
  });
}

/** Etapa 2: código do aplicativo autenticador. Completa a sessão aberta na etapa 1. */
export async function verificarSegundoFator(
  servico: Servico,
  entrada: { token: string; codigo: string; ip?: string | null },
): Promise<ResultadoDoSegundoFator> {
  const { token, codigo, ip } = entrada;
  const achada = await localizarSessao(servico, token);
  if (!achada) return NEGADO;

  const resultado = await naSessaoPendente<ResultadoDoSegundoFator>(
    servico,
    token,
    async (c, u, sessao, agora) => {
      if (!u.totp_ativo || u.totp_segredo_cifrado === null) return NEGADO;

      const segredo = decifrar(u.totp_segredo_cifrado, servico.chaveCampos);
      const passo = verificarCodigo(segredo, codigo, agora.getTime(), {
        ultimoPasso: u.totp_ultimo_passo === null ? null : Number(u.totp_ultimo_passo),
      });
      if (passo === null) {
        await registrarFalha(c, u, agora, "login.mfa_falha", ip);
        return NEGADO;
      }

      await concluirLogin(c, u, sessao.id, passo, agora, achada.casa_id, ip);
      return { ok: true, token, senhaTrocar: u.senha_trocar };
    },
  );
  return resultado;
}

export type InicioDaConfiguracaoTotp = {
  /** Segredo para digitar no aplicativo autenticador, caso a pessoa não leia o QR code. */
  segredo: string;
  /** URI otpauth:// que vira o QR code. */
  uri: string;
};

/**
 * Primeiro acesso: gera o segredo do aplicativo autenticador e o guarda cifrado, ainda inativo.
 * Só vale na sessão incompleta de quem ainda não ativou o segundo fator.
 */
export async function iniciarConfiguracaoTotp(
  servico: Servico,
  entrada: { token: string; ip?: string | null },
): Promise<InicioDaConfiguracaoTotp | typeof NEGADO> {
  return naSessaoPendente(servico, entrada.token, async (c, u) => {
    if (u.totp_ativo || u.email === null) return NEGADO;

    const segredo = gerarSegredoTotp();
    await c.query("UPDATE usuario SET totp_segredo_cifrado = $2 WHERE id = $1", [
      u.id,
      cifrar(segredo, servico.chaveCampos),
    ]);
    await registrarAuditoria(c, {
      acao: "totp.configuracao_iniciada",
      entidade: "usuario",
      entidadeId: u.id,
      ip: entrada.ip,
    });
    return {
      segredo,
      uri: montarUriTotp({ segredoBase32: segredo, emissor: "ILPI Medicação", conta: u.email }),
    };
  });
}

/** Confere o primeiro código, ativa o segundo fator e completa o login. */
export async function confirmarConfiguracaoTotp(
  servico: Servico,
  entrada: { token: string; codigo: string; ip?: string | null },
): Promise<ResultadoDoSegundoFator> {
  const { token, codigo, ip } = entrada;
  const achada = await localizarSessao(servico, token);
  if (!achada) return NEGADO;

  return naSessaoPendente<ResultadoDoSegundoFator>(servico, token, async (c, u, sessao, agora) => {
    if (u.totp_ativo || u.totp_segredo_cifrado === null) return NEGADO;

    const segredo = decifrar(u.totp_segredo_cifrado, servico.chaveCampos);
    const passo = verificarCodigo(segredo, codigo, agora.getTime());
    if (passo === null) {
      await registrarFalha(c, u, agora, "login.mfa_falha", ip);
      return NEGADO;
    }

    await c.query("UPDATE usuario SET totp_ativo = true WHERE id = $1", [u.id]);
    await registrarAuditoria(c, {
      acao: "totp.ativado",
      entidade: "usuario",
      entidadeId: u.id,
      ip,
    });
    await concluirLogin(c, u, sessao.id, passo, agora, achada.casa_id, ip);
    return { ok: true, token, senhaTrocar: u.senha_trocar };
  });
}
