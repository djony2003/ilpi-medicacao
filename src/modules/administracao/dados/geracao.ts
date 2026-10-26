import type { Pool } from "pg";
import { somarDias } from "@/compartilhado/datas";
import { comContexto } from "@/compartilhado/banco/transacao";
import { relogio, type Servico } from "@/compartilhado/servico";
import { prescricoesRegularesAtivas } from "@/modules/prescricoes";
import { dosesDoPeriodo, type DoseGerada } from "../dominio/geracao";

// Geração das doses agendadas. Idempotente: rodar duas vezes, ou em paralelo, dá o mesmo resultado.

export const DIAS_PADRAO_DE_GERACAO = 7;
const DIAS_MAXIMOS = 30;

export type ResultadoDaGeracao = {
  prescricoes: number;
  criadas: number;
  /** Último dia local coberto (AAAA-MM-DD). */
  ate: string;
};

type OpcoesDeGeracao = { dias?: number };

/** A geração só precisa do banco e do relógio: não toca em campos cifrados nem em arquivos. */
export type ServicoDeGeracao = Pick<Servico, "pool" | "agora">;

/**
 * Gera as doses de hoje (e de ontem, caso a rotina tenha ficado parada) até `dias` dias à frente,
 * para todas as prescrições regulares ativas de idosos ativos da casa.
 *
 * Regras que a tornam segura:
 * - o índice único (prescrição, dia, hora) entre as doses não canceladas absorve repetição e corrida;
 * - dose cancelada cujo horário já passou não renasce (o idoso estava fora; não houve dose);
 * - dose cancelada cujo horário ainda não passou renasce (idoso voltou do hospital).
 */
export async function gerarDosesDaCasa(
  servico: ServicoDeGeracao,
  casaId: string,
  opcoes: OpcoesDeGeracao = {},
): Promise<ResultadoDaGeracao> {
  const dias = Math.min(
    Math.max(Math.trunc(opcoes.dias ?? DIAS_PADRAO_DE_GERACAO), 1),
    DIAS_MAXIMOS,
  );
  const agora = relogio(servico);
  const inicioMs = Date.now();

  return comContexto(servico.pool, { casaId }, async (c) => {
    const casa = await c.query<{ fuso: string; hoje: string }>(
      `SELECT fuso_horario AS fuso, (($1::timestamptz AT TIME ZONE fuso_horario)::date)::text AS hoje
         FROM casa WHERE id = app_casa_id()`,
      [agora],
    );
    const dadosDaCasa = casa.rows[0];
    if (!dadosDaCasa) throw new Error("Casa não encontrada para gerar doses.");

    const de = somarDias(dadosDaCasa.hoje, -1);
    const ate = somarDias(dadosDaCasa.hoje, dias);
    const prescricoes = await prescricoesRegularesAtivas(c);

    const doses: (DoseGerada & { idosoId: string })[] = [];
    for (const p of prescricoes) {
      for (const d of dosesDoPeriodo(p, de, ate, dadosDaCasa.fuso)) {
        doses.push({ ...d, idosoId: p.idosoId });
      }
    }
    // Ordem fixa: duas execuções paralelas travam as linhas na mesma ordem e não geram impasse.
    doses.sort(
      (a, b) =>
        a.prescricaoId.localeCompare(b.prescricaoId) ||
        a.dataLocal.localeCompare(b.dataLocal) ||
        a.horaLocal.localeCompare(b.horaLocal),
    );

    let criadas = 0;
    if (doses.length > 0) {
      const r = await c.query(
        `INSERT INTO dose_agendada
           (casa_id, prescricao_id, idoso_id, data_local, hora_local, prevista_em, gerada_em)
         SELECT app_casa_id(), x.prescricao_id, x.idoso_id, x.data_local, x.hora_local, x.prevista_em, $6
           FROM unnest($1::uuid[], $2::uuid[], $3::date[], $4::time[], $5::timestamptz[])
                AS x(prescricao_id, idoso_id, data_local, hora_local, prevista_em)
          WHERE NOT EXISTS (
            SELECT 1 FROM dose_agendada d
             WHERE d.prescricao_id = x.prescricao_id AND d.data_local = x.data_local
               AND d.hora_local = x.hora_local AND d.cancelada_em IS NOT NULL
               AND d.prevista_em <= $6)
         ON CONFLICT (prescricao_id, data_local, hora_local) WHERE cancelada_em IS NULL DO NOTHING`,
        [
          doses.map((d) => d.prescricaoId),
          doses.map((d) => d.idosoId),
          doses.map((d) => d.dataLocal),
          doses.map((d) => d.horaLocal),
          doses.map((d) => d.previstaEm),
          agora,
        ],
      );
      criadas = r.rowCount ?? 0;
    }

    const resultado: ResultadoDaGeracao = { prescricoes: prescricoes.length, criadas, ate };
    await c.query(
      `INSERT INTO execucao_agendador (casa_id, tarefa, ultima_execucao_em, ultima_duracao_ms, ultimo_resultado)
       VALUES (app_casa_id(), 'gerar_doses', $1, $2, $3::jsonb)
       ON CONFLICT (casa_id, tarefa) DO UPDATE
          SET ultima_execucao_em = EXCLUDED.ultima_execucao_em,
              ultima_duracao_ms = EXCLUDED.ultima_duracao_ms,
              ultimo_resultado = EXCLUDED.ultimo_resultado`,
      [agora, Date.now() - inicioMs, JSON.stringify(resultado)],
    );
    return resultado;
  });
}

export type ResultadoDoAgendador = {
  casas: number;
  criadas: number;
  falhas: { casaId: string; erro: string }[];
};

/**
 * Rotina do agendador: gera as doses de todas as casas ativas. Usa o pool do papel `ilpi_agendador`
 * só para listar as casas; a geração de cada uma roda no contexto dela. A falha de uma casa é
 * registrada no batimento e não impede as outras.
 */
export async function gerarEscalaDeTodasAsCasas(
  servico: ServicoDeGeracao,
  opcoes: OpcoesDeGeracao = {},
): Promise<ResultadoDoAgendador> {
  const lista = await servico.pool.query<{ id: string }>(
    "SELECT id FROM casa WHERE ativa ORDER BY id",
  );
  const resultado: ResultadoDoAgendador = { casas: lista.rows.length, criadas: 0, falhas: [] };
  for (const { id } of lista.rows) {
    try {
      resultado.criadas += (await gerarDosesDaCasa(servico, id, opcoes)).criadas;
    } catch (erro) {
      // Só o tipo do erro vai para o registro: a mensagem pode carregar dados da consulta.
      const nome = erro instanceof Error ? erro.name : "Erro";
      resultado.falhas.push({ casaId: id, erro: nome });
      await registrarFalha(servico.pool, id, relogio(servico)).catch(() => undefined);
    }
  }
  return resultado;
}

async function registrarFalha(pool: Pool, casaId: string, agora: Date): Promise<void> {
  await comContexto(pool, { casaId }, async (c) => {
    await c.query(
      `INSERT INTO execucao_agendador (casa_id, tarefa, ultima_execucao_em, ultimo_erro_em)
       VALUES (app_casa_id(), 'gerar_doses', $1, $1)
       ON CONFLICT (casa_id, tarefa) DO UPDATE SET ultimo_erro_em = EXCLUDED.ultimo_erro_em`,
      [agora],
    );
  });
}
