import type { PoolClient } from "pg";
import { registrarAuditoria } from "@/modules/auditoria";
import { POLITICA } from "../dominio/politica";
import { revogarSessoesDoUsuario } from "./sessao";

// Contador de falhas compartilhado por senha, segundo fator, PIN e reautenticação.
// Um contador só (e não um por método) impede que quem erra a senha 4 vezes ganhe mais 4 chutes
// no PIN, e depois mais 4 no código. Todo acesso ao contador acontece com a linha do usuário
// travada (FOR UPDATE), então tentativas simultâneas se enfileiram e não furam o limite.

export type UsuarioParaLogin = {
  id: string;
  nome: string;
  perfil: "gestor" | "enfermeiro" | "cuidador";
  email: string | null;
  senha_hash: string | null;
  senha_trocar: boolean;
  pin_hash: string | null;
  pin_trocar: boolean;
  ativo: boolean;
  totp_ativo: boolean;
  totp_segredo_cifrado: string | null;
  totp_ultimo_passo: string | null;
  tentativas_falhas: number;
  bloqueado_ate: Date | null;
  casa_ativa: boolean;
};

export async function carregarUsuarioTravado(
  c: PoolClient,
  usuarioId: string,
): Promise<UsuarioParaLogin | null> {
  const r = await c.query<UsuarioParaLogin>(
    `SELECT u.id, u.nome, u.perfil, u.email, u.senha_hash, u.senha_trocar, u.pin_hash,
            u.pin_trocar, u.ativo, u.totp_ativo, u.totp_segredo_cifrado,
            u.totp_ultimo_passo::text AS totp_ultimo_passo,
            u.tentativas_falhas, u.bloqueado_ate, k.ativa AS casa_ativa
       FROM usuario u
       JOIN casa k ON k.id = u.casa_id
      WHERE u.id = $1
      FOR UPDATE OF u`,
    [usuarioId],
  );
  return r.rows[0] ?? null;
}

export function estaBloqueado(u: UsuarioParaLogin, agora: Date): boolean {
  return u.bloqueado_ate !== null && u.bloqueado_ate.getTime() > agora.getTime();
}

export type AcaoDeFalha =
  | "login.falha"
  | "login.mfa_falha"
  | "login.pin_falha"
  | "reautenticacao.falha"
  | "confirmacao.pin_falha";

/**
 * Soma uma falha. Ao atingir o limite, bloqueia a conta por um período e encerra as sessões
 * abertas dela. Devolve true se esta falha causou o bloqueio.
 */
export async function registrarFalha(
  c: PoolClient,
  u: UsuarioParaLogin,
  agora: Date,
  acao: AcaoDeFalha,
  extra: { ip?: string | null; dispositivoId?: string | null } = {},
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
    dispositivoId: extra.dispositivoId,
    ip: extra.ip,
  });
  if (bloqueia) {
    await registrarAuditoria(c, {
      acao: "login.conta_bloqueada",
      entidade: "usuario",
      entidadeId: u.id,
      depois: { bloqueioMinutos: POLITICA.bloqueioMs / 60_000 },
      dispositivoId: extra.dispositivoId,
      ip: extra.ip,
    });
  }
  return bloqueia;
}
