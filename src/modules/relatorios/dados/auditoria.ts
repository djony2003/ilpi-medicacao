import type { PoolClient } from "pg";
import { comContexto, ehUuid } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import {
  registrarAuditoria,
  verificarCadeiaDeAuditoria,
  type ProblemaDeCadeia,
} from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import { problemasDoPeriodo } from "../dominio/periodo";

// Consulta da trilha de auditoria pelo gestor (spec 7.6): filtros por período, pessoa, ação e
// objeto; exportação em PDF e planilha. Consultar não deixa rastro (seria uma linha nova a cada
// clique); exportar deixa, porque leva a trilha para fora do sistema. A verificação da cadeia
// de hashes é separada e também só do gestor.

const contexto = (ator: SessaoAutenticada) => ({ casaId: ator.casaId, usuarioId: ator.usuarioId });

export const LIMITE_DA_CONSULTA = 200;
export const LIMITE_DA_EXPORTACAO = 20_000;

export type FiltroDeAuditoria = {
  /** AAAA-MM-DD no fuso da casa; `ate` é inclusivo. */
  de?: string;
  ate?: string;
  usuarioId?: string;
  /** Prefixo da ação: "prescricao." pega todas as de prescrição; "login.sucesso" só essa. */
  acao?: string;
  entidade?: string;
  entidadeId?: string;
};

export type RegistroDeAuditoria = {
  seq: number;
  ocorridoEm: string;
  usuarioId: string | null;
  usuarioNome: string | null;
  acao: string;
  entidade: string;
  entidadeId: string | null;
  antes: unknown;
  depois: unknown;
  dispositivoId: string | null;
  ip: string | null;
};

const FORMATO_ACAO = /^[a-z][a-z0-9_.]{0,79}$/;
const FORMATO_ENTIDADE = /^[a-z][a-z0-9_]{0,59}$/;

function problemasDoFiltro(f: FiltroDeAuditoria): string[] {
  const p: string[] = [];
  if (f.de !== undefined || f.ate !== undefined) {
    if (f.de === undefined || f.ate === undefined) p.push("Informe a data inicial e a final.");
    else p.push(...problemasDoPeriodo(f.de, f.ate, 3660));
  }
  if (f.usuarioId !== undefined && !ehUuid(f.usuarioId)) p.push("Pessoa inválida.");
  if (f.acao !== undefined && !FORMATO_ACAO.test(f.acao)) p.push("Ação inválida.");
  if (f.entidade !== undefined && !FORMATO_ENTIDADE.test(f.entidade)) p.push("Objeto inválido.");
  if (f.entidadeId !== undefined && (f.entidadeId.length < 1 || f.entidadeId.length > 80))
    p.push("Identificador inválido.");
  return p;
}

function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function buscar(
  c: PoolClient,
  f: FiltroDeAuditoria,
  limite: number,
  antesDeSeq?: number,
): Promise<RegistroDeAuditoria[]> {
  const onde: string[] = [];
  const v: unknown[] = [];
  const param = (valor: unknown) => {
    v.push(valor);
    return `$${v.length}`;
  };
  const fuso = (
    await c.query<{ fuso: string }>(
      "SELECT fuso_horario AS fuso FROM casa WHERE id = app_casa_id()",
    )
  ).rows[0]?.fuso;
  if (f.de !== undefined && f.ate !== undefined) {
    const tz = param(fuso ?? "America/Sao_Paulo");
    onde.push(`a.ocorrido_em >= (${param(f.de)}::date)::timestamp AT TIME ZONE ${tz}`);
    onde.push(`a.ocorrido_em < ((${param(f.ate)}::date + 1)::timestamp AT TIME ZONE ${tz})`);
  }
  if (f.usuarioId !== undefined) onde.push(`a.usuario_id = ${param(f.usuarioId)}`);
  if (f.acao !== undefined)
    onde.push(`a.acao LIKE ${param(`${escaparLike(f.acao)}%`)} ESCAPE '\\'`);
  if (f.entidade !== undefined) onde.push(`a.entidade = ${param(f.entidade)}`);
  if (f.entidadeId !== undefined) onde.push(`a.entidade_id = ${param(f.entidadeId)}`);
  if (antesDeSeq !== undefined) onde.push(`a.seq < ${param(antesDeSeq)}`);

  const r = await c.query<{
    seq: string;
    ocorrido_em: Date;
    usuario_id: string | null;
    usuario_nome: string | null;
    acao: string;
    entidade: string;
    entidade_id: string | null;
    antes: unknown;
    depois: unknown;
    dispositivo_id: string | null;
    ip: string | null;
  }>(
    `SELECT a.seq, a.ocorrido_em, a.usuario_id, u.nome AS usuario_nome, a.acao, a.entidade,
            a.entidade_id, a.antes, a.depois, a.dispositivo_id, a.ip
       FROM auditoria a
       LEFT JOIN usuario u ON u.id = a.usuario_id
      ${onde.length > 0 ? `WHERE ${onde.join(" AND ")}` : ""}
      ORDER BY a.seq DESC
      LIMIT ${Math.trunc(limite)}`,
    v,
  );
  return r.rows.map((l) => ({
    seq: Number(l.seq),
    ocorridoEm: l.ocorrido_em.toISOString(),
    usuarioId: l.usuario_id,
    usuarioNome: l.usuario_nome,
    acao: l.acao,
    entidade: l.entidade,
    entidadeId: l.entidade_id,
    antes: l.antes,
    depois: l.depois,
    dispositivoId: l.dispositivo_id,
    ip: l.ip,
  }));
}

export async function consultarAuditoria(
  servico: Servico,
  ator: SessaoAutenticada,
  filtro: FiltroDeAuditoria & { antesDeSeq?: number; limite?: number } = {},
): Promise<
  | { ok: true; registros: RegistroDeAuditoria[]; proximaPagina: number | null }
  | Falha<"dados_invalidos">
> {
  exigirPermissao(ator.perfil, "auditoria.ver");
  const { antesDeSeq, limite, ...f } = filtro;
  const problemas = problemasDoFiltro(f);
  if (antesDeSeq !== undefined && (!Number.isInteger(antesDeSeq) || antesDeSeq < 1))
    problemas.push("Página inválida.");
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  const tamanho = Math.min(Math.max(Math.trunc(limite ?? 50), 1), LIMITE_DA_CONSULTA);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const linhas = await buscar(c, f, tamanho + 1, antesDeSeq);
    const temMais = linhas.length > tamanho;
    const registros = linhas.slice(0, tamanho);
    return {
      ok: true,
      registros,
      proximaPagina: temMais ? (registros[registros.length - 1]?.seq ?? null) : null,
    } as const;
  });
}

export type ExportacaoDeAuditoria = {
  casaNome: string;
  fuso: string;
  emitidoEm: string;
  filtro: FiltroDeAuditoria;
  registros: RegistroDeAuditoria[];
  /** Havia mais registros do que o limite da exportação. */
  truncada: boolean;
};

/**
 * Dados para a exportação. Exige a senha confirmada há pouco e deixa na trilha quem exportou, com
 * que filtro e quantas linhas (nunca o conteúdo).
 */
export async function exportarAuditoria(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { filtro?: FiltroDeAuditoria; formato: "pdf" | "csv"; ip?: string | null },
): Promise<{ ok: true; exportacao: ExportacaoDeAuditoria } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "auditoria.ver");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);
  const filtro = entrada.filtro ?? {};
  const problemas = problemasDoFiltro(filtro);
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const casa = await c.query<{ nome: string; fuso: string }>(
      "SELECT nome, fuso_horario AS fuso FROM casa WHERE id = app_casa_id()",
    );
    const todos = await buscar(c, filtro, LIMITE_DA_EXPORTACAO + 1);
    const truncada = todos.length > LIMITE_DA_EXPORTACAO;
    const registros = todos.slice(0, LIMITE_DA_EXPORTACAO);
    await registrarAuditoria(c, {
      acao: "auditoria.exportada",
      entidade: "auditoria",
      depois: { formato: entrada.formato, filtro, linhas: registros.length, truncada },
      ip: entrada.ip,
    });
    return {
      ok: true,
      exportacao: {
        casaNome: casa.rows[0]?.nome ?? "",
        fuso: casa.rows[0]?.fuso ?? "America/Sao_Paulo",
        emitidoEm: agora.toISOString(),
        filtro,
        registros,
        truncada,
      },
    } as const;
  });
}

/** Confere a cadeia de hashes da casa; null = íntegra. */
export async function verificarAuditoria(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<{ integra: boolean; problema: ProblemaDeCadeia | null; verificadoEm: string }> {
  exigirPermissao(ator.perfil, "auditoria.ver");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const problema = await verificarCadeiaDeAuditoria(c);
    return { integra: problema === null, problema, verificadoEm: agora.toISOString() };
  });
}
