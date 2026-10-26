import type { PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import type { UnidadeDeDose } from "@/modules/prescricoes";
import { problemaDeQuantidade } from "../dominio/quantidade";
import { validarEntradaDeLote, type EntradaDeLote } from "../dominio/validacao";
import { situacaoDeValidade, loteVencido, type SituacaoDeValidade } from "../dominio/validade";
import type { DadosParaEtiqueta } from "../dominio/etiqueta-pdf";
import { traduzirSaldoInsuficiente } from "./saldo";
import { agoraNaCasa } from "./tempo";

// Lotes de estoque: entrada, listagem, detalhe, etiqueta e fracionamento. Tudo acontece na
// transação da casa do ator, com auditoria na mesma transação. O saldo nunca é gravado: vem da
// soma dos movimentos (view saldo_lote).

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

export type LoteDoEstoque = {
  id: string;
  medicamentoId: string;
  medicamento: string;
  principioAtivo: string;
  concentracao: string | null;
  /** Estoque individual: de quem é. Null = estoque comum da casa. */
  idosoId: string | null;
  idosoNome: string | null;
  numeroLote: string;
  validade: string;
  situacaoDeValidade: SituacaoDeValidade;
  unidade: UnidadeDeDose;
  quantidadeInicial: number;
  saldo: number;
  /** Lote de onde este foi fracionado, se for o caso. */
  origemId: string | null;
  criadoEm: string;
};

type LinhaDeLote = {
  id: string;
  medicamento_id: string;
  nome_comercial: string;
  principio_ativo: string;
  concentracao: string | null;
  idoso_id: string | null;
  idoso_nome: string | null;
  numero_lote: string;
  validade: string;
  unidade: UnidadeDeDose;
  quantidade_inicial: string;
  saldo: string;
  origem_id: string | null;
  criado_em: Date;
};

export const SELECT_DE_LOTE = `
  SELECT l.id, l.medicamento_id, m.nome_comercial, m.principio_ativo, m.concentracao,
         l.idoso_id, i.nome AS idoso_nome, l.numero_lote, l.validade::text AS validade, l.unidade,
         l.quantidade_inicial::text AS quantidade_inicial, s.saldo::text AS saldo, l.origem_id,
         l.criado_em
    FROM lote_estoque l
    JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id
    JOIN medicamento m ON m.id = l.medicamento_id AND m.casa_id = l.casa_id
    LEFT JOIN idoso i ON i.id = l.idoso_id AND i.casa_id = l.casa_id`;

export function loteDe(l: LinhaDeLote, hoje: string): LoteDoEstoque {
  return {
    id: l.id,
    medicamentoId: l.medicamento_id,
    medicamento: l.nome_comercial,
    principioAtivo: l.principio_ativo,
    concentracao: l.concentracao,
    idosoId: l.idoso_id,
    idosoNome: l.idoso_nome,
    numeroLote: l.numero_lote,
    validade: l.validade,
    situacaoDeValidade: situacaoDeValidade(l.validade, hoje),
    unidade: l.unidade,
    quantidadeInicial: Number(l.quantidade_inicial),
    saldo: Number(l.saldo),
    origemId: l.origem_id,
    criadoEm: l.criado_em.toISOString(),
  };
}

const NAO_ENCONTRADO = () => falha("nao_encontrado");

// ------------------------------------------------------------------------------------------
// Entrada

export type FalhaDeEntrada = Falha<
  | "dados_invalidos"
  | "medicamento_nao_encontrado"
  | "medicamento_inativo"
  | "idoso_nao_encontrado"
  | "idoso_desligado"
>;

/** Confere o destino do estoque: o idoso (se houver) existe nesta casa e ainda é atendido. */
async function conferirIdoso(
  c: PoolClient,
  idosoId: string | null | undefined,
): Promise<Falha<"idoso_nao_encontrado" | "idoso_desligado"> | null> {
  if (!idosoId) return null;
  const r = await c.query<{ status: string }>("SELECT status FROM idoso WHERE id = $1", [idosoId]);
  const i = r.rows[0];
  if (!i) return falha("idoso_nao_encontrado");
  if (i.status === "desligado") return falha("idoso_desligado");
  return null;
}

/**
 * Entrada de um lote novo: cria o lote, lança a entrada no movimento e devolve o identificador.
 * A etiqueta é impressa em seguida (`emitirEtiqueta`).
 */
export async function registrarEntrada(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: EntradaDeLote & { ip?: string | null },
): Promise<{ ok: true; loteId: string } | FalhaDeEntrada> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje } = await agoraNaCasa(c, agora);
    const problemas = validarEntradaDeLote(entrada, hoje);
    if (problemas.length > 0) return dadosInvalidos(...problemas);

    const med = await c.query<{ ativo: boolean }>("SELECT ativo FROM medicamento WHERE id = $1", [
      entrada.medicamentoId,
    ]);
    const m = med.rows[0];
    if (!m) return falha("medicamento_nao_encontrado");
    if (!m.ativo) return falha("medicamento_inativo");
    const problemaDoIdoso = await conferirIdoso(c, entrada.idosoId);
    if (problemaDoIdoso) return problemaDoIdoso;

    const r = await c.query<{ id: string }>(
      `INSERT INTO lote_estoque
         (casa_id, medicamento_id, idoso_id, codigo_qr, numero_lote, validade, unidade,
          quantidade_inicial, observacao, criado_por, criado_em)
       VALUES (app_casa_id(), $1, $2, $3, btrim($4), $5, $6, $7, nullif(btrim($8), ''), $9, $10)
       RETURNING id`,
      [
        entrada.medicamentoId,
        entrada.idosoId ?? null,
        gerarCodigoOpaco(),
        entrada.numeroLote,
        entrada.validade,
        entrada.unidade,
        entrada.quantidade,
        entrada.observacao ?? "",
        ator.usuarioId,
        agora,
      ],
    );
    const loteId = r.rows[0]?.id ?? "";
    await c.query(
      `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, usuario_id, criado_em)
       VALUES (app_casa_id(), $1, 'entrada', $2, $3, $4)`,
      [loteId, entrada.quantidade, ator.usuarioId, agora],
    );
    await registrarAuditoria(c, {
      acao: "estoque.entrada",
      entidade: "lote_estoque",
      entidadeId: loteId,
      depois: {
        quantidade: entrada.quantidade,
        unidade: entrada.unidade,
        validade: entrada.validade,
        destino: entrada.idosoId ? "individual" : "comum",
      },
      ip: entrada.ip,
    });
    return { ok: true, loteId } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Consulta

export type FiltroDeLotes = {
  medicamentoId?: string;
  idosoId?: string;
  /** `comum` = só estoque da casa; `individual` = só estoque de algum idoso. */
  destino?: "comum" | "individual";
  /** Padrão: só lotes com saldo. */
  incluirZerados?: boolean;
  /** Só lotes vencidos (com saldo) ou que vencem em até N dias. */
  venceEmDias?: number;
};

export async function listarLotes(
  servico: Servico,
  ator: SessaoAutenticada,
  filtro: FiltroDeLotes = {},
): Promise<LoteDoEstoque[]> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje } = await agoraNaCasa(c, agora);
    const r = await c.query<LinhaDeLote>(
      `${SELECT_DE_LOTE}
        WHERE ($1::uuid IS NULL OR l.medicamento_id = $1)
          AND ($2::uuid IS NULL OR l.idoso_id = $2)
          AND ($3::text IS NULL OR ($3 = 'comum' AND l.idoso_id IS NULL)
                                OR ($3 = 'individual' AND l.idoso_id IS NOT NULL))
          AND ($4::boolean OR s.saldo > 0)
          AND ($5::int IS NULL OR l.validade <= $6::date + $5::int)
        ORDER BY l.validade, lower(m.nome_comercial), l.criado_em, l.id`,
      [
        filtro.medicamentoId ?? null,
        filtro.idosoId ?? null,
        filtro.destino ?? null,
        filtro.incluirZerados ?? false,
        filtro.venceEmDias ?? null,
        hoje,
      ],
    );
    return r.rows.map((l) => loteDe(l, hoje));
  });
}

export type MovimentoDoLote = {
  id: string;
  tipo: string;
  quantidade: number;
  motivo: string | null;
  usuarioId: string;
  usuarioNome: string;
  criadoEm: string;
};

export type DetalheDoLote = LoteDoEstoque & {
  movimentos: MovimentoDoLote[];
  etiquetasImpressas: number;
};

export async function obterLote(
  servico: Servico,
  ator: SessaoAutenticada,
  loteId: string,
): Promise<{ ok: true; lote: DetalheDoLote } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje } = await agoraNaCasa(c, agora);
    const r = await c.query<LinhaDeLote>(`${SELECT_DE_LOTE} WHERE l.id = $1`, [loteId]);
    const linha = r.rows[0];
    if (!linha) return NAO_ENCONTRADO();
    const mov = await c.query<{
      id: string;
      tipo: string;
      quantidade: string;
      motivo: string | null;
      usuario_id: string;
      usuario_nome: string;
      criado_em: Date;
    }>(
      `SELECT mv.id, mv.tipo, mv.quantidade::text AS quantidade, mv.motivo, mv.usuario_id,
              u.nome AS usuario_nome, mv.criado_em
         FROM movimento_estoque mv
         JOIN usuario u ON u.id = mv.usuario_id AND u.casa_id = mv.casa_id
        WHERE mv.lote_id = $1
        ORDER BY mv.seq`,
      [loteId],
    );
    const imp = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM impressao_etiqueta WHERE lote_id = $1",
      [loteId],
    );
    return {
      ok: true,
      lote: {
        ...loteDe(linha, hoje),
        etiquetasImpressas: Number(imp.rows[0]?.n ?? 0),
        movimentos: mov.rows.map((m) => ({
          id: m.id,
          tipo: m.tipo,
          quantidade: Number(m.quantidade),
          motivo: m.motivo,
          usuarioId: m.usuario_id,
          usuarioNome: m.usuario_nome,
          criadoEm: m.criado_em.toISOString(),
        })),
      },
    } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Etiqueta

/**
 * Dados para imprimir a etiqueta do lote. A primeira impressão e cada reimpressão ficam
 * registradas (quem e quando); o código do QR é sempre o mesmo.
 */
export async function emitirEtiqueta(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { loteId: string; ip?: string | null },
): Promise<{ ok: true; etiqueta: DadosParaEtiqueta } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      codigo_qr: string;
      nome_comercial: string;
      concentracao: string | null;
      numero_lote: string;
      validade: string;
      unidade: string;
      quantidade_inicial: string;
      idoso_nome: string | null;
    }>(
      `SELECT l.codigo_qr, m.nome_comercial, m.concentracao, l.numero_lote,
              l.validade::text AS validade, l.unidade,
              l.quantidade_inicial::text AS quantidade_inicial, i.nome AS idoso_nome
         FROM lote_estoque l
         JOIN medicamento m ON m.id = l.medicamento_id AND m.casa_id = l.casa_id
         LEFT JOIN idoso i ON i.id = l.idoso_id AND i.casa_id = l.casa_id
        WHERE l.id = $1`,
      [entrada.loteId],
    );
    const l = r.rows[0];
    if (!l) return NAO_ENCONTRADO();
    const anteriores = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM impressao_etiqueta WHERE lote_id = $1",
      [entrada.loteId],
    );
    const reimpressao = Number(anteriores.rows[0]?.n ?? 0) > 0;
    await c.query(
      `INSERT INTO impressao_etiqueta (casa_id, lote_id, usuario_id, reimpressao, impresso_em)
       VALUES (app_casa_id(), $1, $2, $3, $4)`,
      [entrada.loteId, ator.usuarioId, reimpressao, agora],
    );
    // O código do QR não entra na auditoria: só o fato.
    await registrarAuditoria(c, {
      acao: reimpressao ? "estoque.etiqueta_reimpressa" : "estoque.etiqueta_impressa",
      entidade: "lote_estoque",
      entidadeId: entrada.loteId,
      ip: entrada.ip,
    });
    return {
      ok: true,
      etiqueta: {
        medicamento: l.nome_comercial,
        concentracao: l.concentracao,
        numeroLote: l.numero_lote,
        validade: l.validade,
        quantidade: Number(l.quantidade_inicial),
        unidade: l.unidade,
        codigo: l.codigo_qr,
        destino: l.idoso_nome,
        reimpressao,
      },
    } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Fracionamento

export type FalhaDeFracionamento = Falha<
  | "dados_invalidos"
  | "nao_encontrado"
  | "lote_vencido"
  | "saldo_insuficiente"
  | "idoso_nao_encontrado"
  | "idoso_desligado"
>;

/**
 * Separa parte de um lote em outro com etiqueta própria (blister recortado, frasco aberto,
 * manipulado). A quantidade sai do lote de origem e entra no novo no mesmo instante, então o
 * estoque total não muda. O novo lote herda medicamento, unidade e validade da origem.
 *
 * Estoque individual continua do mesmo idoso; do estoque comum, o pedaço pode ficar comum ou
 * ser destinado a um idoso. O contrário não vale: remédio trazido pela família não troca de dono.
 */
export async function fracionarLote(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: {
    loteId: string;
    quantidade: number;
    destinoIdosoId?: string | null;
    observacao?: string | null;
    ip?: string | null;
  },
): Promise<{ ok: true; loteId: string } | FalhaDeFracionamento> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return traduzirSaldoInsuficiente(() => fracionar(servico, ator, entrada, agora));
}

async function fracionar(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: {
    loteId: string;
    quantidade: number;
    destinoIdosoId?: string | null;
    observacao?: string | null;
    ip?: string | null;
  },
  agora: Date,
): Promise<{ ok: true; loteId: string } | FalhaDeFracionamento> {
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje } = await agoraNaCasa(c, agora);
    const r = await c.query<{
      medicamento_id: string;
      idoso_id: string | null;
      numero_lote: string;
      validade: string;
      unidade: UnidadeDeDose;
      saldo: string;
    }>(
      `SELECT l.medicamento_id, l.idoso_id, l.numero_lote, l.validade::text AS validade,
              l.unidade, s.saldo::text AS saldo
         FROM lote_estoque l JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id
        WHERE l.id = $1`,
      [entrada.loteId],
    );
    const o = r.rows[0];
    if (!o) return NAO_ENCONTRADO();

    const problema = problemaDeQuantidade(entrada.quantidade, o.unidade);
    if (problema) return dadosInvalidos(problema);
    const obs = entrada.observacao?.trim();
    if (obs !== undefined && obs.length > 300) {
      return dadosInvalidos("A observação pode ter no máximo 300 caracteres.");
    }
    if (loteVencido(o.validade, hoje)) return falha("lote_vencido");
    if (entrada.quantidade > Number(o.saldo)) return falha("saldo_insuficiente");

    let destino = o.idoso_id;
    if (o.idoso_id === null && entrada.destinoIdosoId) {
      const problemaDoIdoso = await conferirIdoso(c, entrada.destinoIdosoId);
      if (problemaDoIdoso) return problemaDoIdoso;
      destino = entrada.destinoIdosoId;
    } else if (
      o.idoso_id !== null &&
      entrada.destinoIdosoId &&
      entrada.destinoIdosoId !== o.idoso_id
    ) {
      return dadosInvalidos("O estoque individual de um idoso não pode ser passado para outro.");
    }

    const novo = await c.query<{ id: string }>(
      `INSERT INTO lote_estoque
         (casa_id, medicamento_id, idoso_id, codigo_qr, numero_lote, validade, unidade,
          quantidade_inicial, origem_id, observacao, criado_por, criado_em)
       VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6, $7, $8, nullif(btrim($9), ''), $10, $11)
       RETURNING id`,
      [
        o.medicamento_id,
        destino,
        gerarCodigoOpaco(),
        o.numero_lote,
        o.validade,
        o.unidade,
        entrada.quantidade,
        entrada.loteId,
        entrada.observacao ?? "",
        ator.usuarioId,
        agora,
      ],
    );
    const novoId = novo.rows[0]?.id ?? "";
    const par = (await c.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]?.id;
    for (const [id, tipo, qtd] of [
      [entrada.loteId, "fracionamento_saida", -entrada.quantidade],
      [novoId, "fracionamento_entrada", entrada.quantidade],
    ] as const) {
      await c.query(
        `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, usuario_id, par_id, criado_em)
         VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6)`,
        [id, tipo, qtd, ator.usuarioId, par, agora],
      );
    }
    await registrarAuditoria(c, {
      acao: "estoque.fracionado",
      entidade: "lote_estoque",
      entidadeId: entrada.loteId,
      depois: {
        novoLoteId: novoId,
        quantidade: entrada.quantidade,
        destino: destino ? "individual" : "comum",
      },
      ip: entrada.ip,
    });
    return { ok: true, loteId: novoId } as const;
  });
}
