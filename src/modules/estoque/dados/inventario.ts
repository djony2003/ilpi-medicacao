import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import type { UnidadeDeDose } from "@/modules/prescricoes";
import { problemaDeQuantidade, subtrair } from "../dominio/quantidade";
import { problemaDeMotivo } from "../dominio/validacao";
import { traduzirSaldoInsuficiente } from "./saldo";

// Inventário por contagem manual (spec 6.6): a equipe conta o que há na prateleira, lote a lote;
// o sistema aponta as divergências e, ao concluir, lança um ajuste justificado para cada uma.
//
// A divergência é medida contra o saldo do sistema NO INSTANTE DA CONTAGEM, não no da abertura:
// uma dose administrada enquanto a equipe conta não vira "sumiço". E o ajuste é a diferença
// (contado − esperado), somada ao saldo de agora, em vez de "igualar ao contado": o consumo que
// aconteceu depois da contagem não é apagado.

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

/** Mesma chave do gatilho de saldo: ler o saldo e gravar a contagem sem movimento no meio. */
const TRAVA_DO_LOTE =
  "SELECT pg_advisory_xact_lock(hashtextextended('lote_estoque:' || $1::text, 0))";

export type ItemDoInventario = {
  loteId: string;
  medicamento: string;
  concentracao: string | null;
  numeroLote: string;
  validade: string;
  unidade: UnidadeDeDose;
  idosoNome: string | null;
  saldoAtual: number;
  esperado: number | null;
  contado: number | null;
  divergencia: number | null;
  justificativa: string | null;
  ajusteId: string | null;
};

export type DetalheDoInventario = {
  id: string;
  status: "aberto" | "concluido" | "cancelado";
  iniciadoEm: string;
  encerradoEm: string | null;
  itens: ItemDoInventario[];
  resumo: { total: number; contados: number; comDivergencia: number };
};

type LinhaDeItem = {
  lote_id: string;
  nome_comercial: string;
  concentracao: string | null;
  numero_lote: string;
  validade: string;
  unidade: UnidadeDeDose;
  idoso_nome: string | null;
  saldo: string;
  esperado: string | null;
  contado: string | null;
  justificativa: string | null;
  ajuste_id: string | null;
};

function itemDe(l: LinhaDeItem): ItemDoInventario {
  const esperado = l.esperado === null ? null : Number(l.esperado);
  const contado = l.contado === null ? null : Number(l.contado);
  return {
    loteId: l.lote_id,
    medicamento: l.nome_comercial,
    concentracao: l.concentracao,
    numeroLote: l.numero_lote,
    validade: l.validade,
    unidade: l.unidade,
    idosoNome: l.idoso_nome,
    saldoAtual: Number(l.saldo),
    esperado,
    contado,
    divergencia: esperado === null || contado === null ? null : subtrair(contado, esperado),
    justificativa: l.justificativa,
    ajusteId: l.ajuste_id,
  };
}

const NAO_ENCONTRADO = () => falha("nao_encontrado");

// ------------------------------------------------------------------------------------------

export async function iniciarInventario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { ip?: string | null } = {},
): Promise<
  { ok: true; inventarioId: string; lotes: number } | Falha<"inventario_aberto" | "dados_invalidos">
> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  try {
    return await comContexto(servico.pool, contexto(ator), async (c) => {
      const lotes = await c.query<{ id: string }>(
        `SELECT l.id FROM lote_estoque l JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id
          WHERE s.saldo > 0 ORDER BY l.id`,
      );
      if (lotes.rowCount === 0) return dadosInvalidos("Não há lotes com saldo para contar.");
      const inv = await c.query<{ id: string }>(
        `INSERT INTO inventario (casa_id, iniciado_por, iniciado_em)
         VALUES (app_casa_id(), $1, $2) RETURNING id`,
        [ator.usuarioId, agora],
      );
      const inventarioId = inv.rows[0]?.id ?? "";
      await c.query(
        `INSERT INTO inventario_item (casa_id, inventario_id, lote_id)
         SELECT app_casa_id(), $1, unnest($2::uuid[])`,
        [inventarioId, lotes.rows.map((l) => l.id)],
      );
      await registrarAuditoria(c, {
        acao: "estoque.inventario_iniciado",
        entidade: "inventario",
        entidadeId: inventarioId,
        depois: { lotes: lotes.rowCount },
        ip: entrada.ip,
      });
      return { ok: true, inventarioId, lotes: lotes.rowCount ?? 0 } as const;
    });
  } catch (erro) {
    const e = erro as { code?: string; constraint?: string };
    // O índice único é a garantia final, inclusive contra dois inventários abertos ao mesmo tempo.
    if (e.code === "23505" && e.constraint === "inventario_um_aberto") {
      return falha("inventario_aberto");
    }
    throw erro;
  }
}

export async function obterInventario(
  servico: Servico,
  ator: SessaoAutenticada,
  inventarioId: string,
): Promise<{ ok: true; inventario: DetalheDoInventario } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const inv = await c.query<{
      status: DetalheDoInventario["status"];
      iniciado_em: Date;
      encerrado_em: Date | null;
    }>("SELECT status, iniciado_em, encerrado_em FROM inventario WHERE id = $1", [inventarioId]);
    const i = inv.rows[0];
    if (!i) return NAO_ENCONTRADO();
    const r = await c.query<LinhaDeItem>(
      `SELECT it.lote_id, m.nome_comercial, m.concentracao, l.numero_lote, l.validade::text AS validade,
              l.unidade, id.nome AS idoso_nome, s.saldo::text AS saldo,
              it.esperado::text AS esperado, it.contado::text AS contado, it.justificativa, it.ajuste_id
         FROM inventario_item it
         JOIN lote_estoque l ON l.id = it.lote_id AND l.casa_id = it.casa_id
         JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id
         JOIN medicamento m ON m.id = l.medicamento_id AND m.casa_id = l.casa_id
         LEFT JOIN idoso id ON id.id = l.idoso_id AND id.casa_id = l.casa_id
        WHERE it.inventario_id = $1
        ORDER BY lower(m.nome_comercial), l.validade, l.id`,
      [inventarioId],
    );
    const itens = r.rows.map(itemDe);
    return {
      ok: true,
      inventario: {
        id: inventarioId,
        status: i.status,
        iniciadoEm: i.iniciado_em.toISOString(),
        encerradoEm: i.encerrado_em?.toISOString() ?? null,
        itens,
        resumo: {
          total: itens.length,
          contados: itens.filter((x) => x.contado !== null).length,
          comDivergencia: itens.filter((x) => x.divergencia !== null && x.divergencia !== 0).length,
        },
      },
    } as const;
  });
}

export async function listarInventarios(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<Array<{ id: string; status: string; iniciadoEm: string; encerradoEm: string | null }>> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      id: string;
      status: string;
      iniciado_em: Date;
      encerrado_em: Date | null;
    }>(
      "SELECT id, status, iniciado_em, encerrado_em FROM inventario ORDER BY iniciado_em DESC, id LIMIT 50",
    );
    return r.rows.map((x) => ({
      id: x.id,
      status: x.status,
      iniciadoEm: x.iniciado_em.toISOString(),
      encerradoEm: x.encerrado_em?.toISOString() ?? null,
    }));
  });
}

// ------------------------------------------------------------------------------------------

export async function registrarContagem(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { inventarioId: string; loteId: string; contado: number; ip?: string | null },
): Promise<
  | { ok: true; esperado: number; contado: number; divergencia: number }
  | Falha<"nao_encontrado" | "inventario_encerrado" | "lote_fora_do_inventario" | "dados_invalidos">
> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const inv = await c.query<{ status: string }>("SELECT status FROM inventario WHERE id = $1", [
      entrada.inventarioId,
    ]);
    const i = inv.rows[0];
    if (!i) return NAO_ENCONTRADO();
    if (i.status !== "aberto") return falha("inventario_encerrado");

    const it = await c.query<{ unidade: UnidadeDeDose }>(
      `SELECT l.unidade FROM inventario_item it
         JOIN lote_estoque l ON l.id = it.lote_id AND l.casa_id = it.casa_id
        WHERE it.inventario_id = $1 AND it.lote_id = $2`,
      [entrada.inventarioId, entrada.loteId],
    );
    const item = it.rows[0];
    if (!item) return falha("lote_fora_do_inventario");
    const problema = problemaDeQuantidade(entrada.contado, item.unidade, { permitirZero: true });
    if (problema) return dadosInvalidos(problema);

    await c.query(TRAVA_DO_LOTE, [entrada.loteId]);
    const s = await c.query<{ saldo: string }>(
      "SELECT saldo::text AS saldo FROM saldo_lote WHERE lote_id = $1",
      [entrada.loteId],
    );
    const esperado = Number(s.rows[0]?.saldo ?? 0);
    await c.query(
      `UPDATE inventario_item
          SET esperado = $3, contado = $4, contado_por = $5, contado_em = $6, justificativa = NULL
        WHERE inventario_id = $1 AND lote_id = $2`,
      [entrada.inventarioId, entrada.loteId, esperado, entrada.contado, ator.usuarioId, agora],
    );
    const divergencia = subtrair(entrada.contado, esperado);
    await registrarAuditoria(c, {
      acao: "estoque.inventario_contagem",
      entidade: "inventario",
      entidadeId: entrada.inventarioId,
      depois: { loteId: entrada.loteId, esperado, contado: entrada.contado, divergencia },
      ip: entrada.ip,
    });
    return { ok: true, esperado, contado: entrada.contado, divergencia } as const;
  });
}

// ------------------------------------------------------------------------------------------

export type FalhaDeConclusao =
  | Falha<"nao_encontrado" | "inventario_encerrado" | "saldo_insuficiente" | "dados_invalidos">
  | (Falha<"itens_sem_contagem"> & { lotes: string[] })
  | (Falha<"justificativa_faltando"> & { lotes: string[] });

/**
 * Conclui o inventário: cada divergência vira um ajuste com a justificativa dada. Sem
 * justificativa para alguma divergência, nada é lançado. Lotes não contados só ficam de fora se a
 * equipe disser que aceita (`aceitarNaoContados`), para um inventário incompleto não passar por completo.
 */
export async function concluirInventario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: {
    inventarioId: string;
    justificativas: Record<string, string>;
    aceitarNaoContados?: boolean;
    ip?: string | null;
  },
): Promise<{ ok: true; ajustes: number; naoContados: number } | FalhaDeConclusao> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);

  return traduzirSaldoInsuficiente(() =>
    comContexto(servico.pool, contexto(ator), async (c) => {
      const inv = await c.query<{ status: string }>(
        "SELECT status FROM inventario WHERE id = $1 FOR UPDATE",
        [entrada.inventarioId],
      );
      const i = inv.rows[0];
      if (!i) return NAO_ENCONTRADO();
      if (i.status !== "aberto") return falha("inventario_encerrado");

      const itens = await c.query<{
        id: string;
        lote_id: string;
        esperado: string | null;
        contado: string | null;
      }>(
        `SELECT id, lote_id, esperado::text AS esperado, contado::text AS contado
           FROM inventario_item WHERE inventario_id = $1 ORDER BY lote_id`,
        [entrada.inventarioId],
      );
      const naoContados = itens.rows.filter((x) => x.contado === null);
      if (naoContados.length > 0 && !entrada.aceitarNaoContados) {
        return { ...falha("itens_sem_contagem"), lotes: naoContados.map((x) => x.lote_id) };
      }
      const divergentes = itens.rows
        .filter((x) => x.contado !== null && x.esperado !== null)
        .map((x) => ({
          ...x,
          delta: subtrair(Number(x.contado), Number(x.esperado)),
        }))
        .filter((x) => x.delta !== 0);

      const semMotivo = divergentes.filter((d) => {
        const j = entrada.justificativas[d.lote_id];
        return j === undefined || problemaDeMotivo(j) !== null;
      });
      if (semMotivo.length > 0) {
        return { ...falha("justificativa_faltando"), lotes: semMotivo.map((d) => d.lote_id) };
      }

      for (const d of divergentes) {
        const motivo = (entrada.justificativas[d.lote_id] ?? "").trim();
        await c.query(TRAVA_DO_LOTE, [d.lote_id]);
        const mov = await c.query<{ id: string }>(
          `INSERT INTO movimento_estoque
             (casa_id, lote_id, tipo, quantidade, motivo, usuario_id, inventario_id, criado_em)
           VALUES (app_casa_id(), $1, 'ajuste', $2, $3, $4, $5, $6) RETURNING id`,
          [d.lote_id, d.delta, motivo, ator.usuarioId, entrada.inventarioId, agora],
        );
        await c.query(
          "UPDATE inventario_item SET justificativa = $2, ajuste_id = $3 WHERE id = $1",
          [d.id, motivo, mov.rows[0]?.id ?? null],
        );
        await registrarAuditoria(c, {
          acao: "estoque.ajuste",
          entidade: "lote_estoque",
          entidadeId: d.lote_id,
          depois: { origem: "inventario", quantidade: d.delta, motivo },
          ip: entrada.ip,
        });
      }

      await c.query(
        `UPDATE inventario SET status = 'concluido', encerrado_em = $2, encerrado_por = $3 WHERE id = $1`,
        [entrada.inventarioId, agora, ator.usuarioId],
      );
      await registrarAuditoria(c, {
        acao: "estoque.inventario_concluido",
        entidade: "inventario",
        entidadeId: entrada.inventarioId,
        depois: { ajustes: divergentes.length, naoContados: naoContados.length },
        ip: entrada.ip,
      });
      return { ok: true, ajustes: divergentes.length, naoContados: naoContados.length } as const;
    }),
  );
}

export async function cancelarInventario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { inventarioId: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"nao_encontrado" | "inventario_encerrado">> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ status: string }>(
      "SELECT status FROM inventario WHERE id = $1 FOR UPDATE",
      [entrada.inventarioId],
    );
    const i = r.rows[0];
    if (!i) return NAO_ENCONTRADO();
    if (i.status !== "aberto") return falha("inventario_encerrado");
    await c.query(
      `UPDATE inventario SET status = 'cancelado', encerrado_em = $2, encerrado_por = $3 WHERE id = $1`,
      [entrada.inventarioId, agora, ator.usuarioId],
    );
    await registrarAuditoria(c, {
      acao: "estoque.inventario_cancelado",
      entidade: "inventario",
      entidadeId: entrada.inventarioId,
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}
