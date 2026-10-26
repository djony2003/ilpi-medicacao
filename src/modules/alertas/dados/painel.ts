import { comContexto, ehUuid } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import type { Destino, Gravidade, TipoDeAlerta } from "../dominio/reconciliacao";
import { INFORMATIVOS } from "./verificacao";

// Painel de alertas (spec 6.4 e T52): o que está aberto, quem já leu, e o fechamento à mão com
// justificativa. Enfermagem e gestão.

const contexto = (ator: SessaoAutenticada) => ({ casaId: ator.casaId, usuarioId: ator.usuarioId });

export type AlertaDoPainel = {
  id: string;
  tipo: TipoDeAlerta;
  gravidade: Gravidade;
  destino: Destino;
  titulo: string;
  detalhe: string | null;
  entidade: string | null;
  entidadeId: string | null;
  estado: "aberto" | "resolvido";
  abertoEm: string;
  escalado: boolean;
  resolvidoEm: string | null;
  resolucao: "automatica" | "lido" | "manual" | null;
  resolvidoPor: string | null;
  justificativa: string | null;
  /** Fecha quando alguém lê (informativo), em vez de fechar sozinho quando a condição some. */
  informativo: boolean;
  lidoPorMim: boolean;
  leituras: Array<{ nome: string; lidoEm: string }>;
};

export type FiltroDoPainel = { estado?: "aberto" | "resolvido"; limite?: number };

export async function listarAlertas(
  servico: Servico,
  ator: SessaoAutenticada,
  filtro: FiltroDoPainel = {},
): Promise<AlertaDoPainel[]> {
  exigirPermissao(ator.perfil, "alertas.ver");
  const estado = filtro.estado ?? "aberto";
  const limite = Math.min(Math.max(Math.trunc(filtro.limite ?? 200), 1), 500);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      id: string;
      tipo: TipoDeAlerta;
      gravidade: Gravidade;
      destino: Destino;
      titulo: string;
      detalhe: string | null;
      entidade: string | null;
      entidade_id: string | null;
      estado: "aberto" | "resolvido";
      aberto_em: Date;
      escalado_em: Date | null;
      resolvido_em: Date | null;
      resolucao: AlertaDoPainel["resolucao"];
      resolvido_por_nome: string | null;
      justificativa: string | null;
      leituras: Array<{ usuario_id: string; nome: string; lido_em: string }> | null;
    }>(
      `SELECT a.id, a.tipo, a.gravidade, a.destino, a.titulo, a.detalhe, a.entidade, a.entidade_id,
              a.estado, a.aberto_em, a.escalado_em, a.resolvido_em, a.resolucao,
              r.nome AS resolvido_por_nome, a.justificativa,
              (SELECT json_agg(json_build_object('usuario_id', l.usuario_id, 'nome', u.nome,
                                                 'lido_em', l.lido_em) ORDER BY l.lido_em)
                 FROM alerta_leitura l JOIN usuario u ON u.id = l.usuario_id
                WHERE l.alerta_id = a.id) AS leituras
         FROM alerta a
         LEFT JOIN usuario r ON r.id = a.resolvido_por
        WHERE a.estado = $1
        ORDER BY ${estado === "aberto" ? "(a.gravidade = 'urgente') DESC, a.aberto_em DESC" : "a.resolvido_em DESC"}
        LIMIT ${limite}`,
      [estado],
    );
    return r.rows.map((a) => ({
      id: a.id,
      tipo: a.tipo,
      gravidade: a.gravidade,
      destino: a.destino,
      titulo: a.titulo,
      detalhe: a.detalhe,
      entidade: a.entidade,
      entidadeId: a.entidade_id,
      estado: a.estado,
      abertoEm: a.aberto_em.toISOString(),
      escalado: a.escalado_em !== null,
      resolvidoEm: a.resolvido_em?.toISOString() ?? null,
      resolucao: a.resolucao,
      resolvidoPor: a.resolvido_por_nome,
      justificativa: a.justificativa,
      informativo: INFORMATIVOS.has(a.tipo),
      lidoPorMim: (a.leituras ?? []).some((l) => l.usuario_id === ator.usuarioId),
      leituras: (a.leituras ?? []).map((l) => ({
        nome: l.nome,
        lidoEm: new Date(l.lido_em).toISOString(),
      })),
    }));
  });
}

export type ResumoDosAlertas = { abertos: number; urgentes: number; naoLidosPorMim: number };

/** Contagem para o selo do menu e do tablet. */
export async function resumoDosAlertas(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<ResumoDosAlertas> {
  exigirPermissao(ator.perfil, "alertas.ver");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<ResumoDosAlertas>(
      `SELECT count(*)::int AS abertos,
              count(*) FILTER (WHERE gravidade = 'urgente')::int AS urgentes,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM alerta_leitura l WHERE l.alerta_id = a.id AND l.usuario_id = $1
              ))::int AS "naoLidosPorMim"
         FROM alerta a WHERE estado = 'aberto'`,
      [ator.usuarioId],
    );
    return r.rows[0] ?? { abertos: 0, urgentes: 0, naoLidosPorMim: 0 };
  });
}

/**
 * Marca como lido por quem está vendo (a leitura conta para o escalonamento e para o reaviso).
 * Alerta informativo fecha na primeira leitura.
 */
export async function marcarComoLido(
  servico: Servico,
  ator: SessaoAutenticada,
  e: { alertaId: string; ip?: string | null },
): Promise<{ ok: true; fechado: boolean } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "alertas.ver");
  if (!ehUuid(e.alertaId)) return falha("nao_encontrado");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const a = await c.query<{ tipo: TipoDeAlerta; estado: string }>(
      "SELECT tipo, estado FROM alerta WHERE id = $1 FOR UPDATE",
      [e.alertaId],
    );
    const alerta = a.rows[0];
    if (!alerta) return falha("nao_encontrado");
    await c.query(
      `INSERT INTO alerta_leitura (alerta_id, casa_id, usuario_id, lido_em)
       VALUES ($1, app_casa_id(), $2, $3)
       ON CONFLICT (alerta_id, usuario_id) DO NOTHING`,
      [e.alertaId, ator.usuarioId, agora],
    );
    let fechado = false;
    if (alerta.estado === "aberto" && INFORMATIVOS.has(alerta.tipo)) {
      await c.query(
        `UPDATE alerta SET estado = 'resolvido', resolvido_em = $2, resolucao = 'lido',
                           resolvido_por = $3
          WHERE id = $1`,
        [e.alertaId, agora, ator.usuarioId],
      );
      fechado = true;
    }
    return { ok: true, fechado } as const;
  });
}

/**
 * Fecha à mão, com justificativa ("compra feita, chega amanhã", "dose verificada na folha"). A
 * mesma condição não reabre por 7 dias, salvo se piorar.
 */
export async function encerrarAlerta(
  servico: Servico,
  ator: SessaoAutenticada,
  e: { alertaId: string; justificativa: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"nao_encontrado" | "dados_invalidos" | "ja_resolvido">> {
  exigirPermissao(ator.perfil, "alertas.ver");
  if (!ehUuid(e.alertaId)) return falha("nao_encontrado");
  const justificativa = e.justificativa.trim();
  if (justificativa.length < 5 || justificativa.length > 500) {
    return dadosInvalidos("Explique em poucas palavras como o alerta foi tratado.");
  }
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const a = await c.query<{ estado: string; tipo: string }>(
      "SELECT estado, tipo FROM alerta WHERE id = $1 FOR UPDATE",
      [e.alertaId],
    );
    const alerta = a.rows[0];
    if (!alerta) return falha("nao_encontrado");
    if (alerta.estado !== "aberto") return falha("ja_resolvido");
    await c.query(
      `UPDATE alerta SET estado = 'resolvido', resolvido_em = $2, resolucao = 'manual',
                         resolvido_por = $3, justificativa = $4
        WHERE id = $1`,
      [e.alertaId, agora, ator.usuarioId, justificativa],
    );
    await c.query(
      `INSERT INTO alerta_leitura (alerta_id, casa_id, usuario_id, lido_em)
       VALUES ($1, app_casa_id(), $2, $3) ON CONFLICT (alerta_id, usuario_id) DO NOTHING`,
      [e.alertaId, ator.usuarioId, agora],
    );
    await c.query(
      "UPDATE envio_alerta SET estado = 'descartado' WHERE alerta_id = $1 AND estado = 'pendente'",
      [e.alertaId],
    );
    // A justificativa é texto livre (pode citar residente): fica na tabela do alerta, sob RLS;
    // a trilha guarda só o fato.
    await registrarAuditoria(c, {
      acao: "alerta.encerrado",
      entidade: "alerta",
      entidadeId: e.alertaId,
      depois: { tipo: alerta.tipo },
      dispositivoId: ator.dispositivoId,
      ip: e.ip,
    });
    return { ok: true } as const;
  });
}
