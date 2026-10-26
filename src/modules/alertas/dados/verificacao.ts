import type { Pool, PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { relogio, type Servico } from "@/compartilhado/servico";
import { dataLocalDe, janelaDaCasa } from "@/modules/administracao";
import { reservasDoEstoque } from "@/modules/estoque";
import { somarDias } from "@/compartilhado/datas";
import { configuracaoDeAlertas, type ConfiguracaoDeAlertas } from "../dominio/configuracao";
import {
  condicoesDeDoses,
  condicoesDeEstoque,
  condicoesDeExcecoes,
  condicoesDePrescricoes,
  condicoesDeSos,
  condicoesDeValidade,
} from "../dominio/condicoes";
import {
  deveEnviarEmail,
  reconciliar,
  type AlertaAberto,
  type Condicao,
  type Destino,
  type Gravidade,
  type TipoDeAlerta,
  type Tratado,
} from "../dominio/reconciliacao";

// Verificação periódica dos alertas de uma casa (agendador, spec 6.4): levanta as condições que
// valem agora, reconcilia com os alertas abertos e enfileira os e-mails. Roda no contexto da casa,
// sem usuário: é a rotina do sistema.

const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
/** Até onde olhar doses sem registro: o mesmo prazo do registro tardio. */
const DOSES_DOS_ULTIMOS_DIAS = 7;
/** Quem tratou um alerta (à mão ou lendo) não é incomodado de novo pela mesma condição por 7 dias. */
const SILENCIO_APOS_TRATADO_DIAS = 7;

export const INFORMATIVOS: ReadonlySet<TipoDeAlerta> = new Set([
  "excecoes_do_dia",
  "sos_bloqueado",
]);

export type ServicoDeAlertas = Pick<Servico, "pool" | "agora">;

export type ResultadoDaVerificacao = {
  abertos: number;
  agravados: number;
  resolvidos: number;
  escalados: number;
  reavisados: number;
  envios: number;
  /** Outra cópia do agendador já estava verificando esta casa. */
  pulada?: true;
};

async function condicoesDaCasa(
  c: PoolClient,
  agora: Date,
  fuso: string,
  config: ConfiguracaoDeAlertas,
  configuracoes: unknown,
): Promise<Condicao[]> {
  const hoje = dataLocalDe(agora, fuso);
  const condicoes: Condicao[] = [];

  // Estoque acabando: a mesma previsão das telas de estoque.
  const { reservas } = await reservasDoEstoque(c, agora);
  condicoes.push(
    ...condicoesDeEstoque(
      reservas
        .filter((r) => r.previsao?.situacao === "acaba")
        .map((r) => ({
          chave: r.chave,
          medicamento: r.medicamento.concentracao
            ? `${r.medicamento.nome} ${r.medicamento.concentracao}`
            : r.medicamento.nome,
          idosoNome: r.idosoNome,
          diasRestantes: r.previsao?.diasRestantes ?? null,
          esgotaEm: r.previsao?.esgotaEm ?? null,
        })),
      config,
    ),
  );

  // Validade e lote vencido: lotes com saldo.
  const lotes = await c.query<{
    id: string;
    numero_lote: string;
    medicamento: string;
    validade: string;
    saldo: string;
    idoso_nome: string | null;
  }>(
    `SELECT l.id, l.numero_lote, m.nome_comercial AS medicamento, l.validade::text AS validade,
            s.saldo::text AS saldo, i.nome AS idoso_nome
       FROM lote_estoque l
       JOIN saldo_lote s ON s.lote_id = l.id
       JOIN medicamento m ON m.id = l.medicamento_id
       LEFT JOIN idoso i ON i.id = l.idoso_id
      WHERE s.saldo > 0`,
  );
  condicoes.push(
    ...condicoesDeValidade(
      lotes.rows.map((l) => ({
        id: l.id,
        numeroLote: l.numero_lote,
        medicamento: l.medicamento,
        validade: l.validade,
        saldo: Number(l.saldo),
        idosoNome: l.idoso_nome,
      })),
      hoje,
      config,
    ),
  );

  // Doses atrasadas e sem registro: sem resultado final, de idoso que está na casa.
  const doses = await c.query<{
    id: string;
    idoso_nome: string;
    medicamento: string;
    hora_local: string;
    referencia: Date;
  }>(
    `SELECT d.id, i.nome AS idoso_nome, m.nome_comercial AS medicamento,
            to_char(d.hora_local, 'HH24:MI') AS hora_local,
            coalesce((SELECT a.adiada_para FROM administracao a
                       WHERE a.dose_agendada_id = d.id AND a.resultado = 'adiada'
                       ORDER BY a.seq DESC LIMIT 1), d.prevista_em) AS referencia
       FROM dose_agendada d
       JOIN prescricao p ON p.id = d.prescricao_id
       JOIN medicamento m ON m.id = p.medicamento_id
       JOIN idoso i ON i.id = d.idoso_id
      WHERE d.cancelada_em IS NULL AND i.status = 'ativo'
        AND d.prevista_em > $1 AND d.prevista_em <= $2
        AND NOT EXISTS (SELECT 1 FROM administracao a
                         WHERE a.dose_agendada_id = d.id AND a.resultado <> 'adiada')`,
    [new Date(agora.getTime() - DOSES_DOS_ULTIMOS_DIAS * DIA_MS), agora],
  );
  condicoes.push(
    ...condicoesDeDoses(
      doses.rows.map((d) => ({
        id: d.id,
        idosoNome: d.idoso_nome,
        medicamento: d.medicamento,
        horaLocal: d.hora_local,
        referencia: d.referencia,
      })),
      agora,
      janelaDaCasa(configuracoes),
      fuso,
      config,
    ),
  );

  // Prescrições com fim marcado.
  const prescricoes = await c.query<{
    id: string;
    idoso_nome: string;
    medicamento: string;
    fim: string;
  }>(
    `SELECT p.id, i.nome AS idoso_nome, m.nome_comercial AS medicamento, p.fim::text AS fim
       FROM prescricao p
       JOIN idoso i ON i.id = p.idoso_id
       JOIN medicamento m ON m.id = p.medicamento_id
      WHERE p.status = 'ativa' AND p.fim IS NOT NULL AND i.status = 'ativo'
        AND p.fim BETWEEN $1::date AND $2::date`,
    [hoje, somarDias(hoje, config.prescricaoAvisoDias)],
  );
  condicoes.push(
    ...condicoesDePrescricoes(
      prescricoes.rows.map((p) => ({
        id: p.id,
        idosoNome: p.idoso_nome,
        medicamento: p.medicamento,
        fim: p.fim,
      })),
      hoje,
      config,
    ),
  );

  // Exceções de conferência: resumo de ontem e repetição pela mesma pessoa em 7 dias.
  const ontem = somarDias(hoje, -1);
  const doDia = await c.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM excecao_conferencia
      WHERE (criada_em AT TIME ZONE $1)::date = $2::date`,
    [fuso, ontem],
  );
  const porUsuario = await c.query<{ usuario_id: string; nome: string; total: number }>(
    `SELECT a.usuario_id, u.nome, count(*)::int AS total
       FROM excecao_conferencia e
       JOIN administracao a ON a.id = e.administracao_id
       JOIN usuario u ON u.id = a.usuario_id
      WHERE e.criada_em > $1
      GROUP BY a.usuario_id, u.nome`,
    [new Date(agora.getTime() - 7 * DIA_MS)],
  );
  condicoes.push(
    ...condicoesDeExcecoes(
      { data: ontem, total: doDia.rows[0]?.total ?? 0 },
      porUsuario.rows.map((u) => ({ usuarioId: u.usuario_id, nome: u.nome, total: u.total })),
      config,
    ),
  );

  // SOS além do limite (spec 5.7: "bloqueia e avisa o enfermeiro"), a partir da trilha.
  const sos = await c.query<{
    prescricao_id: string;
    data: string;
    vezes: number;
    idoso_nome: string;
    medicamento: string;
  }>(
    `SELECT p.id AS prescricao_id, (t.ocorrido_em AT TIME ZONE $1)::date::text AS data,
            count(*)::int AS vezes, i.nome AS idoso_nome, m.nome_comercial AS medicamento
       FROM auditoria t
       JOIN prescricao p ON p.id::text = t.entidade_id
       JOIN idoso i ON i.id = p.idoso_id
       JOIN medicamento m ON m.id = p.medicamento_id
      WHERE t.acao = 'administracao.sos_bloqueada' AND t.ocorrido_em > $2
      GROUP BY p.id, 2, i.nome, m.nome_comercial`,
    [fuso, new Date(agora.getTime() - DIA_MS)],
  );
  condicoes.push(
    ...condicoesDeSos(
      sos.rows.map((s) => ({
        prescricaoId: s.prescricao_id,
        idosoNome: s.idoso_nome,
        medicamento: s.medicamento,
        data: s.data,
        vezes: s.vezes,
      })),
    ),
  );
  return condicoes;
}

async function abertos(c: PoolClient): Promise<AlertaAberto[]> {
  const r = await c.query<{
    id: string;
    chave: string;
    tipo: TipoDeAlerta;
    gravidade: Gravidade;
    destino: Destino;
    titulo: string;
    detalhe: string | null;
    aberto_em: Date;
    gravidade_desde: Date;
    notificado_em: Date | null;
    escalado_em: Date | null;
    lido: boolean;
  }>(
    `SELECT a.id, a.chave, a.tipo, a.gravidade, a.destino, a.titulo, a.detalhe, a.aberto_em,
            a.gravidade_desde, a.notificado_em, a.escalado_em,
            EXISTS (SELECT 1 FROM alerta_leitura l WHERE l.alerta_id = a.id) AS lido
       FROM alerta a WHERE a.estado = 'aberto'
      FOR UPDATE OF a`,
  );
  return r.rows.map((a) => ({
    id: a.id,
    chave: a.chave,
    gravidade: a.gravidade,
    destino: a.destino,
    titulo: a.titulo,
    detalhe: a.detalhe,
    informativo: INFORMATIVOS.has(a.tipo),
    abertoEm: a.aberto_em,
    gravidadeDesde: a.gravidade_desde,
    notificadoEm: a.notificado_em,
    escaladoEm: a.escalado_em,
    lido: a.lido,
  }));
}

async function tratados(c: PoolClient, agora: Date): Promise<Tratado[]> {
  const r = await c.query<{ chave: string; gravidade: Gravidade }>(
    `SELECT chave, gravidade FROM alerta
      WHERE estado = 'resolvido' AND resolucao IN ('manual', 'lido') AND resolvido_em > $1`,
    [new Date(agora.getTime() - SILENCIO_APOS_TRATADO_DIAS * DIA_MS)],
  );
  return r.rows;
}

/** Quem recebe os e-mails: a enfermagem (ou, se não houver ninguém com e-mail, a gestão), ou a gestão. */
async function destinatarios(c: PoolClient, destino: Destino): Promise<string[]> {
  const doPerfil = async (perfil: "enfermeiro" | "gestor") =>
    (
      await c.query<{ id: string }>(
        "SELECT id FROM usuario WHERE ativo AND perfil = $1 AND email IS NOT NULL ORDER BY id",
        [perfil],
      )
    ).rows.map((u) => u.id);
  if (destino === "gestor") return doPerfil("gestor");
  const enfermagem = await doPerfil("enfermeiro");
  return enfermagem.length > 0 ? enfermagem : doPerfil("gestor");
}

async function enfileirar(
  c: PoolClient,
  alertaId: string,
  destino: Destino,
  motivo: "novo" | "agravado" | "reaviso" | "escalonamento",
  agora: Date,
): Promise<number> {
  const para = await destinatarios(c, destino);
  for (const usuarioId of para) {
    await c.query(
      `INSERT INTO envio_alerta (casa_id, alerta_id, usuario_id, motivo, proxima_em, criado_em)
       VALUES (app_casa_id(), $1, $2, $3, $4, $4)`,
      [alertaId, usuarioId, motivo, agora],
    );
  }
  return para.length;
}

export async function verificarAlertasDaCasa(
  servico: ServicoDeAlertas,
  casaId: string,
): Promise<ResultadoDaVerificacao> {
  const agora = relogio(servico);
  const inicio = Date.now();
  return comContexto(servico.pool, { casaId }, async (c) => {
    // Duas cópias do agendador: a segunda pula a casa em vez de esperar (a próxima rodada vem logo).
    const trava = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('alertas:' || $1, 0)) AS ok",
      [casaId],
    );
    const vazio = {
      abertos: 0,
      agravados: 0,
      resolvidos: 0,
      escalados: 0,
      reavisados: 0,
      envios: 0,
    };
    if (!trava.rows[0]?.ok) return { ...vazio, pulada: true as const };

    const casa = await c.query<{ fuso: string; configuracoes: unknown }>(
      "SELECT fuso_horario AS fuso, configuracoes FROM casa WHERE id = app_casa_id()",
    );
    const { fuso, configuracoes } = casa.rows[0] ?? {
      fuso: "America/Sao_Paulo",
      configuracoes: {},
    };
    const config = configuracaoDeAlertas(configuracoes);
    const condicoes = await condicoesDaCasa(c, agora, fuso, config, configuracoes);
    const atuais = await abertos(c);
    const porId = new Map(atuais.map((a) => [a.id, a]));
    const plano = reconciliar(condicoes, atuais, await tratados(c, agora), agora, config);
    const r = { ...vazio };

    for (const n of plano.abrir) {
      const criado = await c.query<{ id: string }>(
        `INSERT INTO alerta (casa_id, chave, tipo, gravidade, destino, titulo, detalhe, entidade,
                             entidade_id, aberto_em, gravidade_desde, notificado_em)
         VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
         ON CONFLICT (casa_id, chave) WHERE estado = 'aberto' DO NOTHING
         RETURNING id`,
        [
          n.chave,
          n.tipo,
          n.gravidade,
          n.destino,
          n.titulo,
          n.detalhe,
          n.entidade,
          n.entidadeId,
          agora,
        ],
      );
      const id = criado.rows[0]?.id;
      if (!id) continue;
      r.abertos += 1;
      if (deveEnviarEmail(n.gravidade, "novo", config)) {
        r.envios += await enfileirar(c, id, n.destino, "novo", agora);
      }
    }
    for (const { id, condicao: n } of plano.agravar) {
      await c.query(
        `UPDATE alerta SET gravidade = $2, titulo = $3, detalhe = $4, gravidade_desde = $5,
                           notificado_em = $5
          WHERE id = $1`,
        [id, n.gravidade, n.titulo, n.detalhe, agora],
      );
      r.agravados += 1;
      r.envios += await enfileirar(c, id, porId.get(id)?.destino ?? n.destino, "agravado", agora);
    }
    for (const { id, condicao: n } of plano.atualizar) {
      await c.query(
        `UPDATE alerta
            SET titulo = $3, detalhe = $4,
                gravidade_desde = CASE WHEN gravidade <> $2 THEN $5 ELSE gravidade_desde END,
                gravidade = $2
          WHERE id = $1`,
        [id, n.gravidade, n.titulo, n.detalhe, agora],
      );
    }
    for (const id of plano.resolver) {
      await c.query(
        `UPDATE alerta SET estado = 'resolvido', resolvido_em = $2, resolucao = 'automatica'
          WHERE id = $1`,
        [id, agora],
      );
      // E-mail que ainda não saiu perdeu o sentido.
      await c.query(
        "UPDATE envio_alerta SET estado = 'descartado' WHERE alerta_id = $1 AND estado = 'pendente'",
        [id],
      );
      r.resolvidos += 1;
    }
    for (const id of plano.escalar) {
      await c.query(
        "UPDATE alerta SET destino = 'gestor', escalado_em = $2, notificado_em = $2 WHERE id = $1",
        [id, agora],
      );
      r.escalados += 1;
      r.envios += await enfileirar(c, id, "gestor", "escalonamento", agora);
    }
    for (const id of plano.reavisar) {
      const a = porId.get(id);
      if (!a) continue;
      await c.query("UPDATE alerta SET notificado_em = $2 WHERE id = $1", [id, agora]);
      r.reavisados += 1;
      if (deveEnviarEmail(a.gravidade, "reaviso", config)) {
        r.envios += await enfileirar(c, id, a.destino, "reaviso", agora);
      }
    }

    await registrarExecucao(c, "verificar_alertas", agora, Date.now() - inicio, r);
    return r;
  });
}

export async function registrarExecucao(
  c: PoolClient,
  tarefa: "verificar_alertas" | "enviar_alertas",
  agora: Date,
  duracaoMs: number,
  resultado: object,
): Promise<void> {
  await c.query(
    `INSERT INTO execucao_agendador (casa_id, tarefa, ultima_execucao_em, ultima_duracao_ms, ultimo_resultado)
     VALUES (app_casa_id(), $1, $2, $3, $4::jsonb)
     ON CONFLICT (casa_id, tarefa) DO UPDATE
        SET ultima_execucao_em = EXCLUDED.ultima_execucao_em,
            ultima_duracao_ms = EXCLUDED.ultima_duracao_ms,
            ultimo_resultado = EXCLUDED.ultimo_resultado`,
    [tarefa, agora, duracaoMs, JSON.stringify(resultado)],
  );
}

/** Lista as casas ativas (só o papel do agendador enxerga todas). */
export async function casasAtivas(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ id: string }>("SELECT id FROM casa WHERE ativa ORDER BY id");
  return r.rows.map((x) => x.id);
}
