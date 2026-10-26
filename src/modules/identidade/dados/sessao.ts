import type { PoolClient } from "pg";
import { comBusca } from "@/compartilhado/banco/busca";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarToken, hashDeToken } from "@/compartilhado/tokens";
import { registrarAuditoria } from "@/modules/auditoria";
import type { Perfil } from "../dominio/permissoes";
import { relogio, type Servico } from "./servico";

// Sessões ficam no banco. O navegador guarda só o token; o banco guarda só o hash dele.
// Assim, quem lê o banco não consegue se passar por uma sessão, e encerrar uma sessão é apagar
// a confiança no servidor (diferente de um token assinado, que vale até expirar).

export type NovaSessao = {
  casaId: string;
  usuarioId: string;
  dispositivoId?: string | null;
  tipo: "web" | "tablet";
  mfaOk: boolean;
  duracaoMs: number;
  inatividadeSegundos: number;
  ip?: string | null;
  agora: Date;
};

/** Cria a sessão dentro da transação do chamador e devolve o token (aparece só aqui). */
export async function criarSessao(cliente: PoolClient, nova: NovaSessao): Promise<string> {
  const token = gerarToken();
  await cliente.query(
    `INSERT INTO sessao
       (casa_id, usuario_id, dispositivo_id, tipo, token_hash, mfa_ok, criada_em, ultimo_uso_em,
        expira_em, inatividade_segundos, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
    [
      nova.casaId,
      nova.usuarioId,
      nova.dispositivoId ?? null,
      nova.tipo,
      hashDeToken(token),
      nova.mfaOk,
      nova.agora,
      new Date(nova.agora.getTime() + nova.duracaoMs),
      nova.inatividadeSegundos,
      nova.ip ?? null,
    ],
  );
  return token;
}

/** Revoga todas as sessões abertas de um usuário (troca de senha, desativação, bloqueio). */
export async function revogarSessoesDoUsuario(
  cliente: PoolClient,
  usuarioId: string,
  agora: Date,
): Promise<number> {
  const r = await cliente.query(
    "UPDATE sessao SET revogada_em = $2 WHERE usuario_id = $1 AND revogada_em IS NULL",
    [usuarioId, agora],
  );
  return r.rowCount ?? 0;
}

export type SessaoAutenticada = {
  sessaoId: string;
  casaId: string;
  usuarioId: string;
  perfil: Perfil;
  tipo: "web" | "tablet";
  dispositivoId: string | null;
  senhaTrocar: boolean;
  /** Quando a pessoa digitou a senha de novo pela última vez, para ações sensíveis. */
  pinTrocar: boolean;
  reautenticadoEm: Date | null;
};

type LinhaDeSessao = {
  id: string;
  usuario_id: string;
  casa_id: string;
};

/** Acha a sessão pelo token ainda sem saber a casa (ver ADR-002). */
export async function localizarSessao(
  servico: Servico,
  token: string,
): Promise<LinhaDeSessao | null> {
  if (token.length === 0 || token.length > 200) return null;
  return comBusca(servico.pool, "sessao_hash", hashDeToken(token), async (c) => {
    const r = await c.query<LinhaDeSessao>(
      "SELECT id, usuario_id, casa_id FROM sessao WHERE token_hash = $1",
      [hashDeToken(token)],
    );
    return r.rows[0] ?? null;
  });
}

/**
 * Valida o token de uma requisição e renova o prazo de inatividade.
 * Devolve null se a sessão não existe, foi encerrada, expirou, está inativa há tempo demais,
 * não concluiu o segundo fator, ou se o usuário (ou a casa) foi desativado.
 */
export async function autenticarSessao(
  servico: Servico,
  token: string,
): Promise<SessaoAutenticada | null> {
  const achada = await localizarSessao(servico, token);
  if (!achada) return null;
  const agora = relogio(servico);

  return comContexto(
    servico.pool,
    { casaId: achada.casa_id, usuarioId: achada.usuario_id },
    async (c) => {
      const r = await c.query<{
        id: string;
        tipo: "web" | "tablet";
        dispositivo_id: string | null;
        mfa_ok: boolean;
        ultimo_uso_em: Date;
        expira_em: Date;
        inatividade_segundos: number;
        revogada_em: Date | null;
        reautenticado_em: Date | null;
        perfil: Perfil;
        usuario_ativo: boolean;
        senha_trocar: boolean;
        pin_trocar: boolean;
        casa_ativa: boolean;
        dispositivo_revogado_em: Date | null;
      }>(
        `SELECT s.id, s.tipo, s.dispositivo_id, s.mfa_ok, s.ultimo_uso_em, s.expira_em,
                s.inatividade_segundos, s.revogada_em, s.reautenticado_em,
                u.perfil, u.ativo AS usuario_ativo, u.senha_trocar, u.pin_trocar,
                k.ativa AS casa_ativa, d.revogado_em AS dispositivo_revogado_em
           FROM sessao s
           JOIN usuario u ON u.id = s.usuario_id
           JOIN casa k ON k.id = s.casa_id
           LEFT JOIN dispositivo d ON d.id = s.dispositivo_id
          WHERE s.id = $1
          FOR UPDATE OF s`,
        [achada.id],
      );
      const s = r.rows[0];
      if (!s || s.revogada_em || !s.mfa_ok || !s.usuario_ativo || !s.casa_ativa) return null;
      if (s.dispositivo_revogado_em) return null;

      const venceuPorTempo = s.expira_em.getTime() <= agora.getTime();
      const venceuPorInatividade =
        s.ultimo_uso_em.getTime() + s.inatividade_segundos * 1000 <= agora.getTime();
      if (venceuPorTempo || venceuPorInatividade) {
        await c.query("UPDATE sessao SET revogada_em = $2 WHERE id = $1", [s.id, agora]);
        return null;
      }

      await c.query("UPDATE sessao SET ultimo_uso_em = $2 WHERE id = $1", [s.id, agora]);
      return {
        sessaoId: s.id,
        casaId: achada.casa_id,
        usuarioId: achada.usuario_id,
        perfil: s.perfil,
        tipo: s.tipo,
        dispositivoId: s.dispositivo_id,
        senhaTrocar: s.senha_trocar,
        pinTrocar: s.pin_trocar,
        reautenticadoEm: s.reautenticado_em,
      };
    },
  );
}

/** Encerra a sessão do token. Silencioso se o token já não valia. */
export async function sair(servico: Servico, token: string, ip?: string | null): Promise<void> {
  const achada = await localizarSessao(servico, token);
  if (!achada) return;
  const agora = relogio(servico);
  await comContexto(
    servico.pool,
    { casaId: achada.casa_id, usuarioId: achada.usuario_id },
    async (c) => {
      const r = await c.query(
        "UPDATE sessao SET revogada_em = $2 WHERE id = $1 AND revogada_em IS NULL",
        [achada.id, agora],
      );
      if ((r.rowCount ?? 0) > 0) {
        await registrarAuditoria(c, {
          acao: "sessao.encerrada",
          entidade: "sessao",
          entidadeId: achada.id,
          ip,
        });
      }
    },
  );
}
