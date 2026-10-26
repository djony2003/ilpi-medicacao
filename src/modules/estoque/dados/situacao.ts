import type { PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import { prescricoesAtivasParaEstoque, type UnidadeDeDose } from "@/modules/prescricoes";
import {
  faltaParaCobrir,
  preverEstoque,
  type EntradaDaPrevisao,
  type Previsao,
} from "../dominio/previsao";
import { arredondarParaCima, deMilesimos, emMilesimos } from "../dominio/quantidade";
import { montarReservas, type LoteDaReserva, type Reserva } from "../dominio/reservas";
import {
  loteVencido,
  situacaoDeEstoque,
  situacaoDeValidade,
  type SituacaoDeEstoque,
  type SituacaoDeValidade,
} from "../dominio/validade";
import { SELECT_DE_LOTE, loteDe, type LoteDoEstoque } from "./lotes";
import { agoraNaCasa } from "./tempo";

// Situação do estoque: para cada reserva (conjunto de lotes que atende um conjunto de
// prescrições), quanto há, quanto tempo dura e o que vence antes de ser usado. Alimenta as
// telas por idoso e por medicamento, a lista de reposição e, no M6, os alertas.

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

export const COBERTURA_PADRAO_DIAS = 30;
export const DIAS_PARA_REPOR_PADRAO = 7;

export type ReservaDeEstoque = {
  chave: string;
  dono: "individual" | "comum";
  idosoId: string | null;
  idosoNome: string | null;
  /** Quem consome desta reserva. */
  idososAtendidos: Array<{ id: string; nome: string }>;
  medicamento: {
    id: string;
    nome: string;
    principioAtivo: string;
    concentracao: string | null;
  };
  unidade: UnidadeDeDose;
  lotes: Array<{
    id: string;
    numeroLote: string;
    validade: string;
    situacaoDeValidade: SituacaoDeValidade;
    saldo: number;
  }>;
  saldoDisponivel: number;
  saldoVencido: number;
  previsao: Previsao | null;
  /** A receita está numa unidade e o estoque em outra: sem conversão, não há previsão. */
  semPrevisao: "unidade_diferente" | null;
  situacao: SituacaoDeEstoque | null;
};

type Calculada = { reserva: Reserva; saida: ReservaDeEstoque; entrada: EntradaDaPrevisao };

async function calcular(
  c: PoolClient,
  agora: Date,
): Promise<{ hoje: string; reservas: Calculada[] }> {
  const { hoje, minutos } = await agoraNaCasa(c, agora);
  const lotesDb = await c.query<{
    id: string;
    medicamento_id: string;
    idoso_id: string | null;
    unidade: UnidadeDeDose;
    validade: string;
    numero_lote: string;
    saldo: string;
  }>(
    `SELECT l.id, l.medicamento_id, l.idoso_id, l.unidade, l.validade::text AS validade,
            l.numero_lote, s.saldo::text AS saldo
       FROM lote_estoque l JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id`,
  );
  const numeroDoLote = new Map(lotesDb.rows.map((l) => [l.id, l.numero_lote]));
  const lotes: LoteDaReserva[] = lotesDb.rows.map((l) => ({
    id: l.id,
    medicamentoId: l.medicamento_id,
    idosoId: l.idoso_id,
    unidade: l.unidade,
    validade: l.validade,
    saldo: Number(l.saldo),
  }));
  const prescricoes = await prescricoesAtivasParaEstoque(c);
  const reservas = montarReservas(lotes, prescricoes);

  const meds = await c.query<{
    id: string;
    nome_comercial: string;
    principio_ativo: string;
    concentracao: string | null;
  }>("SELECT id, nome_comercial, principio_ativo, concentracao FROM medicamento");
  const medicamentos = new Map(meds.rows.map((m) => [m.id, m]));
  const idosos = new Map(
    (await c.query<{ id: string; nome: string }>("SELECT id, nome FROM idoso")).rows.map((i) => [
      i.id,
      i.nome,
    ]),
  );

  const calculadas: Calculada[] = [];
  for (const r of reservas) {
    const temSaldo = r.lotes.some((l) => emMilesimos(l.saldo) > 0);
    if (!temSaldo && r.demandas.length === 0) continue;
    const med = medicamentos.get(r.medicamentoId);
    if (!med) continue;
    const entrada: EntradaDaPrevisao = {
      hoje,
      minutosAgora: minutos,
      lotes: r.lotes,
      demandas: r.demandas,
    };
    const semPrevisao = r.lotesEmOutraUnidade ? ("unidade_diferente" as const) : null;
    const previsao = semPrevisao ? null : preverEstoque(entrada);
    const disponivel = r.lotes
      .filter((l) => !loteVencido(l.validade, hoje))
      .reduce((t, l) => t + emMilesimos(l.saldo), 0);
    const vencido = r.lotes
      .filter((l) => loteVencido(l.validade, hoje))
      .reduce((t, l) => t + emMilesimos(l.saldo), 0);
    calculadas.push({
      reserva: r,
      entrada,
      saida: {
        chave: r.chave,
        dono: r.dono,
        idosoId: r.idosoId,
        idosoNome: r.idosoId ? (idosos.get(r.idosoId) ?? null) : null,
        idososAtendidos: r.idososAtendidos
          .map((id) => ({ id, nome: idosos.get(id) ?? "" }))
          .sort((a, b) => a.nome.localeCompare(b.nome)),
        medicamento: {
          id: med.id,
          nome: med.nome_comercial,
          principioAtivo: med.principio_ativo,
          concentracao: med.concentracao,
        },
        unidade: r.unidade,
        lotes: r.lotes
          .filter((l) => emMilesimos(l.saldo) > 0)
          .sort((a, b) => a.validade.localeCompare(b.validade) || a.id.localeCompare(b.id))
          .map((l) => ({
            id: l.id,
            numeroLote: numeroDoLote.get(l.id) ?? "",
            validade: l.validade,
            situacaoDeValidade: situacaoDeValidade(l.validade, hoje),
            saldo: l.saldo,
          })),
        saldoDisponivel: deMilesimos(disponivel),
        saldoVencido: deMilesimos(vencido),
        previsao,
        semPrevisao,
        situacao: previsao ? situacaoDeEstoque(previsao.diasRestantes) : null,
      },
    });
  }
  // O que acaba primeiro vem primeiro; quem não tem previsão ou não acaba vai para o fim.
  calculadas.sort(
    (a, b) =>
      (a.saida.previsao?.diasRestantes ?? Infinity) -
        (b.saida.previsao?.diasRestantes ?? Infinity) ||
      a.saida.medicamento.nome.localeCompare(b.saida.medicamento.nome) ||
      a.saida.chave.localeCompare(b.saida.chave),
  );
  return { hoje, reservas: calculadas };
}

/**
 * Situação de todas as reservas da casa do contexto, sem conferência de perfil: leitura interna,
 * usada pela verificação de alertas (agendador). A tela usa `situacaoDoEstoque`.
 */
export async function reservasDoEstoque(
  c: PoolClient,
  agora: Date,
): Promise<{ hoje: string; reservas: ReservaDeEstoque[] }> {
  const { hoje, reservas } = await calcular(c, agora);
  return { hoje, reservas: reservas.map((x) => x.saida) };
}

export type FiltroDeSituacao = { idosoId?: string; medicamentoId?: string };

export async function situacaoDoEstoque(
  servico: Servico,
  ator: SessaoAutenticada,
  filtro: FiltroDeSituacao = {},
): Promise<{ hoje: string; reservas: ReservaDeEstoque[] }> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje, reservas } = await calcular(c, agora);
    return {
      hoje,
      reservas: reservas
        .filter(
          ({ reserva: r }) =>
            (!filtro.medicamentoId || r.medicamentoId === filtro.medicamentoId) &&
            (!filtro.idosoId ||
              r.idosoId === filtro.idosoId ||
              r.idososAtendidos.includes(filtro.idosoId)),
        )
        .map((x) => x.saida),
    };
  });
}

// ------------------------------------------------------------------------------------------
// Lista de reposição

export type ItemDeReposicao = {
  medicamento: ReservaDeEstoque["medicamento"];
  unidade: UnidadeDeDose;
  /** Estoque individual de um idoso, ou null para o estoque comum da casa. */
  idosoNome: string | null;
  idososAtendidos: string[];
  saldoDisponivel: number;
  diasRestantes: number;
  esgotaEm: string;
  situacao: SituacaoDeEstoque;
  /** Quanto comprar para cobrir `coberturaDias`, arredondado ao passo da unidade. */
  quantidadeSugerida: number;
};

export type ListaDeReposicao = {
  casaNome: string;
  fuso: string;
  geradaEm: string;
  hoje: string;
  coberturaDias: number;
  diasParaRepor: number;
  itens: ItemDeReposicao[];
};

/**
 * Lista de compras sugerida: reservas que acabam em até `diasParaRepor` dias, com a quantidade
 * que falta para cobrir `coberturaDias`. Quem emite a lista deixa rastro (é uma exportação).
 */
export async function listaDeReposicao(
  servico: Servico,
  ator: SessaoAutenticada,
  opcoes: { coberturaDias?: number; diasParaRepor?: number; ip?: string | null } = {},
): Promise<ListaDeReposicao> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  const coberturaDias = opcoes.coberturaDias ?? COBERTURA_PADRAO_DIAS;
  const diasParaRepor = opcoes.diasParaRepor ?? DIAS_PARA_REPOR_PADRAO;
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje, reservas } = await calcular(c, agora);
    const itens: ItemDeReposicao[] = [];
    for (const { saida, entrada } of reservas) {
      const p = saida.previsao;
      if (!p || p.situacao !== "acaba" || p.diasRestantes === null || p.esgotaEm === null) continue;
      if (p.diasRestantes > diasParaRepor) continue;
      const falta = faltaParaCobrir(entrada, coberturaDias);
      if (emMilesimos(falta) <= 0) continue;
      itens.push({
        medicamento: saida.medicamento,
        unidade: saida.unidade,
        idosoNome: saida.idosoNome,
        idososAtendidos: saida.idososAtendidos.map((i) => i.nome),
        saldoDisponivel: saida.saldoDisponivel,
        diasRestantes: p.diasRestantes,
        esgotaEm: p.esgotaEm,
        situacao: situacaoDeEstoque(p.diasRestantes),
        quantidadeSugerida: arredondarParaCima(falta, saida.unidade),
      });
    }
    await registrarAuditoria(c, {
      acao: "estoque.lista_reposicao_emitida",
      entidade: "estoque",
      depois: { itens: itens.length, coberturaDias, diasParaRepor },
      ip: opcoes.ip,
    });
    const casa = await c.query<{ nome: string; fuso_horario: string }>(
      "SELECT nome, fuso_horario FROM casa WHERE id = app_casa_id()",
    );
    return {
      casaNome: casa.rows[0]?.nome ?? "",
      fuso: casa.rows[0]?.fuso_horario ?? "America/Sao_Paulo",
      geradaEm: agora.toISOString(),
      hoje,
      coberturaDias,
      diasParaRepor,
      itens,
    };
  });
}

// ------------------------------------------------------------------------------------------
// Sobras para destinação (spec 6.6)

export type MotivoDeSobra = "vencido" | "idoso_desligado" | "sem_prescricao_ativa";

export type SobraDeEstoque = { lote: LoteDoEstoque; motivos: MotivoDeSobra[] };

/**
 * Lotes com saldo que a casa precisa destinar (descartar, devolver à família ou à farmácia):
 * vencidos; de idoso que saiu da casa; ou do estoque individual de quem não tem mais
 * prescrição ativa daquele medicamento (fim de tratamento).
 */
export async function listarSobras(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<{ hoje: string; sobras: SobraDeEstoque[] }> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const { hoje } = await agoraNaCasa(c, agora);
    const motivos = await c.query<{
      id: string;
      vencido: boolean;
      desligado: boolean;
      sem_prescricao: boolean;
    }>(
      `SELECT l.id,
              l.validade < $1::date AS vencido,
              COALESCE(i.status = 'desligado', false) AS desligado,
              (l.idoso_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM prescricao p
                  WHERE p.idoso_id = l.idoso_id AND p.medicamento_id = l.medicamento_id
                    AND p.status = 'ativa')) AS sem_prescricao
         FROM lote_estoque l
         JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id
         LEFT JOIN idoso i ON i.id = l.idoso_id AND i.casa_id = l.casa_id
        WHERE s.saldo > 0`,
      [hoje],
    );
    const por = new Map(
      motivos.rows
        .filter((m) => m.vencido || m.desligado || m.sem_prescricao)
        .map((m) => {
          const lista: MotivoDeSobra[] = [];
          if (m.vencido) lista.push("vencido");
          if (m.desligado) lista.push("idoso_desligado");
          else if (m.sem_prescricao) lista.push("sem_prescricao_ativa");
          return [m.id, lista] as const;
        }),
    );
    if (por.size === 0) return { hoje, sobras: [] };
    const r = await c.query<Parameters<typeof loteDe>[0]>(
      `${SELECT_DE_LOTE} WHERE l.id = ANY($1::uuid[]) ORDER BY l.validade, lower(m.nome_comercial), l.id`,
      [[...por.keys()]],
    );
    return {
      hoje,
      sobras: r.rows.map((l) => ({ lote: loteDe(l, hoje), motivos: por.get(l.id) ?? [] })),
    };
  });
}
