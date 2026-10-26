import type { PoolClient } from "pg";
import { ehUuid } from "@/compartilhado/banco/transacao";
import { extrairCodigo } from "@/compartilhado/qr";
import type { UnidadeDeDose } from "@/modules/prescricoes";

// Leitura do lote na conferência e baixa do consumo. Chamadas de dentro da transação do registro
// da administração (módulo administracao), que já conferiu a permissão de quem registra.

export type LoteNaConferencia = {
  id: string;
  medicamentoId: string;
  idosoId: string | null;
  numeroLote: string;
  validade: string;
  unidade: UnidadeDeDose;
  saldo: number;
};

export type LeituraDeLote =
  { situacao: "lida"; lote: LoteNaConferencia } | { situacao: "invalida" | "desconhecida" };

const SELECT = `SELECT l.id, l.medicamento_id, l.idoso_id, l.numero_lote, l.validade::text AS validade,
                       l.unidade, coalesce(s.saldo, 0)::text AS saldo
                  FROM lote_estoque l
                  LEFT JOIN saldo_lote s ON s.lote_id = l.id`;

type Linha = {
  id: string;
  medicamento_id: string;
  idoso_id: string | null;
  numero_lote: string;
  validade: string;
  unidade: UnidadeDeDose;
  saldo: string;
};

const deLinha = (l: Linha): LoteNaConferencia => ({
  id: l.id,
  medicamentoId: l.medicamento_id,
  idosoId: l.idoso_id,
  numeroLote: l.numero_lote,
  validade: l.validade,
  unidade: l.unidade,
  saldo: Number(l.saldo),
});

/** Lote pela leitura da etiqueta (QR ou código digitado). Lote de outra casa não existe aqui. */
export async function lerLote(c: PoolClient, leitura: string): Promise<LeituraDeLote> {
  const codigo = leitura.length <= 100 ? extrairCodigo(leitura, "lote") : null;
  if (!codigo) return { situacao: "invalida" };
  const r = await c.query<Linha>(`${SELECT} WHERE l.codigo_qr = $1`, [codigo]);
  const l = r.rows[0];
  return l ? { situacao: "lida", lote: deLinha(l) } : { situacao: "desconhecida" };
}

/** Lote escolhido à mão (exceção de conferência, quando a etiqueta não lê). */
export async function loteParaConferencia(
  c: PoolClient,
  loteId: string,
): Promise<LoteNaConferencia | null> {
  if (!ehUuid(loteId)) return null;
  const r = await c.query<Linha>(`${SELECT} WHERE l.id = $1`, [loteId]);
  const l = r.rows[0];
  return l ? deLinha(l) : null;
}

/**
 * Baixa do lote pela administração. O gatilho do banco recusa saldo negativo (com bloqueio por
 * lote), então dois registros simultâneos no mesmo lote não furam o saldo: quem chama traduz o
 * erro com `ehSaldoInsuficiente`.
 */
export async function consumirParaAdministracao(
  c: PoolClient,
  m: { loteId: string; quantidade: number; administracaoId: string; usuarioId: string; em: Date },
): Promise<void> {
  await c.query(
    `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, usuario_id, administracao_id, criado_em)
     VALUES (app_casa_id(), $1, 'consumo', $2, $3, $4, $5)`,
    [m.loteId, -m.quantidade, m.usuarioId, m.administracaoId, m.em],
  );
}

/**
 * Lotes com saldo que podem atender um idoso (o estoque individual dele e o comum), na ordem em
 * que devem ser usados: o que vence primeiro sai primeiro. Serve à exceção de conferência, em
 * que a etiqueta não lê e o lote é escolhido à mão.
 */
export async function lotesParaUso(
  c: PoolClient,
  medicamentoId: string,
  idosoId: string,
): Promise<LoteNaConferencia[]> {
  const r = await c.query<Linha>(
    `${SELECT}
      WHERE l.medicamento_id = $1 AND (l.idoso_id IS NULL OR l.idoso_id = $2)
        AND coalesce(s.saldo, 0) > 0
      ORDER BY l.validade, l.criado_em`,
    [medicamentoId, idosoId],
  );
  return r.rows.map(deLinha);
}
