import type { PoolClient } from "pg";
import { acharSegredo } from "../dominio/segredos";

export type EventoDeAuditoria = {
  /** Ação no formato "dominio.verbo", por exemplo "login.sucesso" ou "prescricao.criada". */
  acao: string;
  entidade: string;
  entidadeId?: string;
  antes?: unknown;
  depois?: unknown;
  /** Quem agiu. Se omitido, usa o usuário do contexto da transação. */
  usuarioId?: string | null;
  dispositivoId?: string | null;
  ip?: string | null;
};

const FORMATO_ACAO = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Registra um evento na trilha de auditoria, dentro da transação do chamador.
 *
 * Deve ser chamada na MESMA transação da ação auditada: se a ação desfaz, o registro também
 * desfaz, e nunca existe ação sem rastro. A casa vem do contexto (app_casa_id()), então a
 * chamada falha fora de comContexto.
 */
export async function registrarAuditoria(
  cliente: PoolClient,
  evento: EventoDeAuditoria,
): Promise<void> {
  if (!FORMATO_ACAO.test(evento.acao)) {
    throw new Error(`Ação de auditoria inválida: "${evento.acao}". Use o formato "dominio.verbo".`);
  }
  for (const [nome, valor] of [
    ["antes", evento.antes],
    ["depois", evento.depois],
  ] as const) {
    const segredo = acharSegredo(valor);
    if (segredo) {
      throw new Error(`Auditoria recusou um segredo em "${nome}": campo "${segredo}".`);
    }
  }

  await cliente.query(
    `INSERT INTO auditoria
       (casa_id, usuario_id, acao, entidade, entidade_id, antes, depois, dispositivo_id, ip)
     VALUES
       (app_casa_id(), COALESCE($1::uuid, app_usuario_id()), $2, $3, $4, $5::jsonb, $6::jsonb, $7::uuid, $8)`,
    [
      evento.usuarioId ?? null,
      evento.acao,
      evento.entidade,
      evento.entidadeId ?? null,
      evento.antes === undefined ? null : JSON.stringify(evento.antes),
      evento.depois === undefined ? null : JSON.stringify(evento.depois),
      evento.dispositivoId ?? null,
      evento.ip ?? null,
    ],
  );
}
