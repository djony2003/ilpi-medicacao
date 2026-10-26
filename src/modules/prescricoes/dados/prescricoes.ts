import type { PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import { conflitosComAlergia, type ConflitoDeAlergia } from "../dominio/alergia";
import type {
  ConteudoDePrescricao,
  Forma,
  Horario,
  StatusDePrescricao,
  TipoDePrescricao,
  UnidadeDeDose,
  Via,
} from "../dominio/tipos";
import { normalizarDias, normalizarHora, validarPrescricao } from "../dominio/validacao";
import { diferencasClinicas, type CampoClinico } from "../dominio/versao";
import { diasParaVencer, situacaoDeVigencia, type SituacaoDeVigencia } from "../dominio/vigencia";

// Prescrições versionadas. O sistema NÃO prescreve: o enfermeiro ou gestor transcreve a receita.
//
// - Uma prescrição nunca é alterada: mudar dose, via ou horário encerra a versão atual
//   ("substituída") e cria a seguinte, com justificativa. O banco recusa UPDATE no conteúdo.
// - Antes de gravar, o princípio ativo é conferido com as alergias ativas do idoso. Conflito exige
//   confirmação consciente com justificativa, que fica na própria prescrição.
// - A auditoria guarda identificadores e NOMES de campos; o conteúdo clínico fica nas tabelas.

const MIN_JUSTIFICATIVA_ALERGIA = 10;

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

const NAO_ENCONTRADO = () => falha("nao_encontrado");

export type FalhaDeAlergia = {
  ok: false;
  motivo: "conflito_alergia";
  conflitos: ConflitoDeAlergia[];
};

export type NovaPrescricao = ConteudoDePrescricao & {
  idosoId: string;
  /** Presente quando quem prescreve confirma, ciente, um conflito de alergia apontado antes. */
  justificativaAlergia?: string;
};

type LinhaDePrescricao = {
  id: string;
  grupo_id: string;
  versao: number;
  idoso_id: string;
  medicamento_id: string;
  tipo: TipoDePrescricao;
  dose: string;
  unidade: UnidadeDeDose;
  via: Via;
  instrucoes: string | null;
  inicio: string;
  fim: string | null;
  alto_risco: boolean;
  sos_indicacao: string | null;
  sos_limite_diario: number | null;
  sos_intervalo_min: number | null;
  prescritor: string | null;
  justificativa: string | null;
  status: StatusDePrescricao;
  criado_em: Date;
  encerrada_em: Date | null;
  motivo_encerramento: string | null;
};

const COLUNAS = `p.id, p.grupo_id, p.versao, p.idoso_id, p.medicamento_id, p.tipo, p.dose::text AS dose,
  p.unidade, p.via, p.instrucoes, p.inicio::text AS inicio, p.fim::text AS fim, p.alto_risco,
  p.sos_indicacao, p.sos_limite_diario, p.sos_intervalo_min, p.prescritor, p.justificativa,
  p.status, p.criado_em, p.encerrada_em, p.motivo_encerramento`;

async function hojeNaCasa(c: PoolClient, agora: Date): Promise<string> {
  const r = await c.query<{ hoje: string }>(
    `SELECT (($1::timestamptz AT TIME ZONE fuso_horario)::date)::text AS hoje
       FROM casa WHERE id = app_casa_id()`,
    [agora],
  );
  return r.rows[0]?.hoje ?? agora.toISOString().slice(0, 10);
}

async function horariosDe(c: PoolClient, prescricaoIds: string[]): Promise<Map<string, Horario[]>> {
  const mapa = new Map<string, Horario[]>();
  if (prescricaoIds.length === 0) return mapa;
  const r = await c.query<{ prescricao_id: string; hora: string; dias_semana: number[] }>(
    `SELECT prescricao_id, to_char(hora, 'HH24:MI') AS hora, dias_semana
       FROM horario_prescricao WHERE prescricao_id = ANY($1::uuid[]) ORDER BY hora`,
    [prescricaoIds],
  );
  for (const l of r.rows) {
    const lista = mapa.get(l.prescricao_id) ?? [];
    lista.push({ hora: l.hora, diasSemana: l.dias_semana });
    mapa.set(l.prescricao_id, lista);
  }
  return mapa;
}

function conteudoDe(l: LinhaDePrescricao, horarios: Horario[]): ConteudoDePrescricao {
  return {
    medicamentoId: l.medicamento_id,
    tipo: l.tipo,
    dose: Number(l.dose),
    unidade: l.unidade,
    via: l.via,
    instrucoes: l.instrucoes,
    inicio: l.inicio,
    fim: l.fim,
    altoRisco: l.alto_risco,
    horarios,
    sos:
      l.tipo === "sos"
        ? {
            indicacao: l.sos_indicacao ?? "",
            limiteDiario: l.sos_limite_diario ?? 0,
            intervaloMinimoMin: l.sos_intervalo_min ?? 0,
          }
        : null,
    prescritor: l.prescritor,
  };
}

async function alergiasAtivas(c: PoolClient, idosoId: string) {
  const r = await c.query<{
    id: string;
    substancia: string;
    gravidade: "leve" | "moderada" | "grave";
  }>("SELECT id, substancia, gravidade FROM alergia WHERE idoso_id = $1 AND ativa", [idosoId]);
  return r.rows;
}

/** Insere a versão e seus horários. A auditoria fica por conta de quem chama. */
async function inserirVersao(
  c: PoolClient,
  ator: SessaoAutenticada,
  v: {
    idosoId: string;
    grupoId: string | null;
    versao: number;
    substituiId: string | null;
    conteudo: ConteudoDePrescricao;
    justificativa: string | null;
    /** Relógio da aplicação (injetável): é o marco a partir do qual a versão gera doses. */
    criadaEm: Date;
  },
): Promise<{ id: string; grupoId: string }> {
  const k = v.conteudo;
  const r = await c.query<{ id: string; grupo_id: string }>(
    `INSERT INTO prescricao
       (casa_id, idoso_id, medicamento_id, grupo_id, versao, substitui_id, tipo, dose, unidade, via,
        instrucoes, inicio, fim, alto_risco, sos_indicacao, sos_limite_diario, sos_intervalo_min,
        prescritor, justificativa, criado_por, criado_em)
     VALUES (app_casa_id(), $1, $2, coalesce($3::uuid, gen_random_uuid()), $4, $5, $6, $7, $8, $9,
             nullif(btrim($10), ''), $11, $12, $13, $14, $15, $16, nullif(btrim($17), ''),
             nullif(btrim($18), ''), $19, $20)
     RETURNING id, grupo_id`,
    [
      v.idosoId,
      k.medicamentoId,
      v.grupoId,
      v.versao,
      v.substituiId,
      k.tipo,
      k.dose,
      k.unidade,
      k.via,
      k.instrucoes ?? "",
      k.inicio,
      k.fim ?? null,
      k.altoRisco,
      k.sos?.indicacao.trim() ?? null,
      k.sos?.limiteDiario ?? null,
      k.sos?.intervaloMinimoMin ?? null,
      k.prescritor ?? "",
      v.justificativa ?? "",
      ator.usuarioId,
      v.criadaEm,
    ],
  );
  const criada = r.rows[0];
  if (!criada) throw new Error("INSERT de prescrição não devolveu a linha.");
  for (const h of k.horarios) {
    await c.query(
      `INSERT INTO horario_prescricao (casa_id, prescricao_id, hora, dias_semana)
       VALUES (app_casa_id(), $1, $2, $3::smallint[])`,
      [criada.id, normalizarHora(h.hora), normalizarDias(h.diasSemana)],
    );
  }
  return { id: criada.id, grupoId: criada.grupo_id };
}

// ------------------------------------------------------------------------------------------
// Prescrever

export async function prescrever(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: NovaPrescricao & { ip?: string | null },
): Promise<
  | { ok: true; prescricaoId: string; grupoId: string; conflitosConfirmados: ConflitoDeAlergia[] }
  | Falha<
      | "dados_invalidos"
      | "nao_encontrado"
      | "medicamento_nao_encontrado"
      | "idoso_desligado"
      | "ja_existe_ativa"
      | "alto_risco_obrigatorio"
    >
  | FalhaDeAlergia
> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const hoje = await hojeNaCasa(c, agora);
    const problemas = validarPrescricao(entrada, hoje);
    if (problemas.length > 0) return dadosInvalidos(...problemas);

    // FOR UPDATE no idoso serializa duas prescrições simultâneas do mesmo medicamento.
    const idoso = await c.query<{ status: string }>(
      "SELECT status FROM idoso WHERE id = $1 FOR UPDATE",
      [entrada.idosoId],
    );
    if (idoso.rowCount !== 1) return NAO_ENCONTRADO();
    if (idoso.rows[0]?.status === "desligado") return falha("idoso_desligado");

    // FOR SHARE: impede desativar o medicamento enquanto esta prescrição é gravada.
    const med = await c.query<{
      principio_ativo: string;
      nome_comercial: string;
      alto_risco_padrao: boolean;
    }>(
      `SELECT principio_ativo, nome_comercial, alto_risco_padrao
         FROM medicamento WHERE id = $1 AND ativo FOR SHARE`,
      [entrada.medicamentoId],
    );
    const m = med.rows[0];
    if (!m) return falha("medicamento_nao_encontrado");
    if (m.alto_risco_padrao && !entrada.altoRisco) return falha("alto_risco_obrigatorio");

    const duplicada = await c.query(
      `SELECT 1 FROM prescricao
        WHERE idoso_id = $1 AND medicamento_id = $2 AND tipo = $3 AND status = 'ativa' LIMIT 1`,
      [entrada.idosoId, entrada.medicamentoId, entrada.tipo],
    );
    if (duplicada.rowCount === 1) return falha("ja_existe_ativa");

    const conflitos = conflitosComAlergia(
      { principioAtivo: m.principio_ativo, nomeComercial: m.nome_comercial },
      await alergiasAtivas(c, entrada.idosoId),
    );
    const justificativaAlergia = entrada.justificativaAlergia?.trim() ?? "";
    if (conflitos.length > 0 && justificativaAlergia.length < MIN_JUSTIFICATIVA_ALERGIA) {
      return { ok: false, motivo: "conflito_alergia", conflitos } as const;
    }

    const criada = await inserirVersao(c, ator, {
      idosoId: entrada.idosoId,
      grupoId: null,
      versao: 1,
      substituiId: null,
      conteudo: entrada,
      justificativa: conflitos.length > 0 ? justificativaAlergia : null,
      criadaEm: agora,
    });
    await registrarAuditoria(c, {
      acao: "prescricao.criada",
      entidade: "prescricao",
      entidadeId: criada.id,
      depois: {
        grupoId: criada.grupoId,
        idosoId: entrada.idosoId,
        medicamentoId: entrada.medicamentoId,
        tipo: entrada.tipo,
        altoRisco: entrada.altoRisco,
        alergiasConfirmadas: conflitos.map((x) => x.alergiaId),
      },
      ip: entrada.ip,
    });
    return {
      ok: true,
      prescricaoId: criada.id,
      grupoId: criada.grupoId,
      conflitosConfirmados: conflitos,
    } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Nova versão e encerramento

export async function novaVersao(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: {
    prescricaoId: string;
    /** Por que a prescrição mudou (3 a 500 caracteres). */
    justificativa: string;
    conteudo: ConteudoDePrescricao;
    justificativaAlergia?: string;
    ip?: string | null;
  },
): Promise<
  | {
      ok: true;
      prescricaoId: string;
      versao: number;
      camposAlterados: CampoClinico[];
      conflitosConfirmados: ConflitoDeAlergia[];
    }
  | Falha<
      | "dados_invalidos"
      | "nao_encontrado"
      | "nao_ativa"
      | "medicamento_diferente"
      | "sem_mudanca"
      | "alto_risco_obrigatorio"
    >
  | FalhaDeAlergia
> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);
  const justificativa = entrada.justificativa.trim();
  if (justificativa.length < 3 || justificativa.length > 500) {
    return dadosInvalidos("Explique por que a prescrição mudou (3 a 500 caracteres).");
  }

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<LinhaDePrescricao>(
      `SELECT ${COLUNAS} FROM prescricao p WHERE p.id = $1 FOR UPDATE`,
      [entrada.prescricaoId],
    );
    const atual = r.rows[0];
    if (!atual) return NAO_ENCONTRADO();
    if (atual.status !== "ativa") return falha("nao_ativa");
    if (atual.medicamento_id !== entrada.conteudo.medicamentoId)
      return falha("medicamento_diferente");

    const hoje = await hojeNaCasa(c, agora);
    // O início de uma nova versão pode ser anterior a hoje (continua a mesma prescrição); só o
    // fim não pode já ter passado.
    const problemas = validarPrescricao(entrada.conteudo, hoje);
    if (problemas.length > 0) return dadosInvalidos(...problemas);

    const horariosAtuais = (await horariosDe(c, [atual.id])).get(atual.id) ?? [];
    const campos = diferencasClinicas(conteudoDe(atual, horariosAtuais), entrada.conteudo);
    if (campos.length === 0) return falha("sem_mudanca");

    const med = await c.query<{
      principio_ativo: string;
      nome_comercial: string;
      alto_risco_padrao: boolean;
    }>(
      `SELECT principio_ativo, nome_comercial, alto_risco_padrao
         FROM medicamento WHERE id = $1 FOR SHARE`,
      [atual.medicamento_id],
    );
    const m = med.rows[0];
    if (!m) return NAO_ENCONTRADO();
    if (m.alto_risco_padrao && !entrada.conteudo.altoRisco) return falha("alto_risco_obrigatorio");

    const conflitos = conflitosComAlergia(
      { principioAtivo: m.principio_ativo, nomeComercial: m.nome_comercial },
      await alergiasAtivas(c, atual.idoso_id),
    );
    const justificativaAlergia = entrada.justificativaAlergia?.trim() ?? "";
    if (conflitos.length > 0 && justificativaAlergia.length < MIN_JUSTIFICATIVA_ALERGIA) {
      return { ok: false, motivo: "conflito_alergia", conflitos } as const;
    }

    // A versão antiga sai de "ativa" ANTES da nova entrar (índice único: uma ativa por grupo).
    await c.query(
      `UPDATE prescricao
          SET status = 'substituida', encerrada_em = $2, encerrada_por = $3, motivo_encerramento = $4
        WHERE id = $1`,
      [atual.id, agora, ator.usuarioId, justificativa],
    );
    const nova = await inserirVersao(c, ator, {
      idosoId: atual.idoso_id,
      grupoId: atual.grupo_id,
      versao: atual.versao + 1,
      substituiId: atual.id,
      conteudo: entrada.conteudo,
      justificativa:
        conflitos.length > 0
          ? `${justificativa} | Alergia confirmada: ${justificativaAlergia}`
          : justificativa,
      criadaEm: agora,
    });
    await registrarAuditoria(c, {
      acao: "prescricao.nova_versao",
      entidade: "prescricao",
      entidadeId: nova.id,
      antes: { prescricaoId: atual.id, versao: atual.versao },
      depois: {
        grupoId: atual.grupo_id,
        versao: atual.versao + 1,
        campos,
        alergiasConfirmadas: conflitos.map((x) => x.alergiaId),
      },
      ip: entrada.ip,
    });
    return {
      ok: true,
      prescricaoId: nova.id,
      versao: atual.versao + 1,
      camposAlterados: campos,
      conflitosConfirmados: conflitos,
    } as const;
  });
}

export async function encerrarPrescricao(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { prescricaoId: string; motivo: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"dados_invalidos" | "nao_encontrado" | "nao_ativa">> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3 || motivo.length > 500) {
    return dadosInvalidos("Informe o motivo do encerramento (3 a 500 caracteres).");
  }
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ status: StatusDePrescricao; grupo_id: string; versao: number }>(
      "SELECT status, grupo_id, versao FROM prescricao WHERE id = $1 FOR UPDATE",
      [entrada.prescricaoId],
    );
    const p = r.rows[0];
    if (!p) return NAO_ENCONTRADO();
    if (p.status !== "ativa") return falha("nao_ativa");
    await c.query(
      `UPDATE prescricao
          SET status = 'encerrada', encerrada_em = $2, encerrada_por = $3, motivo_encerramento = $4
        WHERE id = $1`,
      [entrada.prescricaoId, agora, ator.usuarioId, motivo],
    );
    await registrarAuditoria(c, {
      acao: "prescricao.encerrada",
      entidade: "prescricao",
      entidadeId: entrada.prescricaoId,
      antes: { status: "ativa" },
      depois: { status: "encerrada", grupoId: p.grupo_id, versao: p.versao },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Consulta

export type PrescricaoDetalhada = ConteudoDePrescricao & {
  id: string;
  grupoId: string;
  versao: number;
  idosoId: string;
  medicamento: {
    id: string;
    nomeComercial: string;
    principioAtivo: string;
    concentracao: string | null;
    forma: Forma;
  };
  justificativa: string | null;
  status: StatusDePrescricao;
  situacao: SituacaoDeVigencia;
  diasParaVencer: number | null;
  criadaEm: string;
  encerradaEm: string | null;
  motivoEncerramento: string | null;
  receitas: number;
};

type LinhaComMedicamento = LinhaDePrescricao & {
  nome_comercial: string;
  principio_ativo: string;
  concentracao: string | null;
  forma: Forma;
  receitas: string;
};

async function carregar(
  c: PoolClient,
  filtroSql: string,
  valores: unknown[],
  hoje: string,
): Promise<PrescricaoDetalhada[]> {
  const r = await c.query<LinhaComMedicamento>(
    `SELECT ${COLUNAS}, m.nome_comercial, m.principio_ativo, m.concentracao, m.forma,
            (SELECT count(*) FROM receita_prescricao rp WHERE rp.prescricao_id = p.id)::text AS receitas
       FROM prescricao p
       JOIN medicamento m ON m.id = p.medicamento_id
      WHERE ${filtroSql}`,
    valores,
  );
  const horarios = await horariosDe(
    c,
    r.rows.map((l) => l.id),
  );
  return r.rows.map((l) => {
    const base = { status: l.status, inicio: l.inicio, fim: l.fim };
    return {
      ...conteudoDe(l, horarios.get(l.id) ?? []),
      id: l.id,
      grupoId: l.grupo_id,
      versao: l.versao,
      idosoId: l.idoso_id,
      medicamento: {
        id: l.medicamento_id,
        nomeComercial: l.nome_comercial,
        principioAtivo: l.principio_ativo,
        concentracao: l.concentracao,
        forma: l.forma,
      },
      justificativa: l.justificativa,
      status: l.status,
      situacao: situacaoDeVigencia(base, hoje),
      diasParaVencer: diasParaVencer(base, hoje),
      criadaEm: l.criado_em.toISOString(),
      encerradaEm: l.encerrada_em?.toISOString() ?? null,
      motivoEncerramento: l.motivo_encerramento,
      receitas: Number(l.receitas),
    };
  });
}

export async function listarPrescricoes(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; incluirInativas?: boolean },
): Promise<PrescricaoDetalhada[]> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const hoje = await hojeNaCasa(c, agora);
    const lista = await carregar(
      c,
      `p.idoso_id = $1 AND ($2::boolean OR p.status = 'ativa')
       ORDER BY (p.status = 'ativa') DESC, lower(m.nome_comercial), p.versao DESC`,
      [entrada.idosoId, entrada.incluirInativas ?? false],
      hoje,
    );
    return lista;
  });
}

/** Como `listarPrescricoes`, mas distingue "idoso sem prescrições" de "idoso que não existe". */
export async function prescricoesDoIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; incluirInativas?: boolean },
): Promise<{ ok: true; prescricoes: PrescricaoDetalhada[] } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const existe = await c.query("SELECT 1 FROM idoso WHERE id = $1", [entrada.idosoId]);
    if (existe.rowCount !== 1) return NAO_ENCONTRADO();
    const hoje = await hojeNaCasa(c, agora);
    return {
      ok: true,
      prescricoes: await carregar(
        c,
        `p.idoso_id = $1 AND ($2::boolean OR p.status = 'ativa')
         ORDER BY (p.status = 'ativa') DESC, lower(m.nome_comercial), p.versao DESC`,
        [entrada.idosoId, entrada.incluirInativas ?? false],
        hoje,
      ),
    } as const;
  });
}

/** A prescrição e todas as versões do mesmo grupo (da mais nova para a mais antiga). */
export async function obterPrescricao(
  servico: Servico,
  ator: SessaoAutenticada,
  prescricaoId: string,
): Promise<
  | { ok: true; prescricao: PrescricaoDetalhada; historico: PrescricaoDetalhada[] }
  | Falha<"nao_encontrado">
> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const hoje = await hojeNaCasa(c, agora);
    const historico = await carregar(
      c,
      `p.grupo_id = (SELECT grupo_id FROM prescricao WHERE id = $1) ORDER BY p.versao DESC`,
      [prescricaoId],
      hoje,
    );
    const prescricao = historico.find((p) => p.id === prescricaoId);
    if (!prescricao) return NAO_ENCONTRADO();
    return { ok: true, prescricao, historico } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Leitura para a escala (consumida pelo módulo de administração)

export type PrescricaoRegularAtiva = {
  id: string;
  idosoId: string;
  inicio: string;
  fim: string | null;
  criadaEm: Date;
  horarios: Horario[];
};

/**
 * Prescrições regulares ativas de idosos ativos da casa do contexto. Sem checagem de perfil: é
 * leitura interna, chamada pelo gerador de doses (rotina automática ou depois de prescrever).
 */
export async function prescricoesRegularesAtivas(c: PoolClient): Promise<PrescricaoRegularAtiva[]> {
  const r = await c.query<{
    id: string;
    idoso_id: string;
    inicio: string;
    fim: string | null;
    criado_em: Date;
  }>(
    `SELECT p.id, p.idoso_id, p.inicio::text AS inicio, p.fim::text AS fim, p.criado_em
       FROM prescricao p
       JOIN idoso i ON i.id = p.idoso_id AND i.casa_id = p.casa_id
      WHERE p.status = 'ativa' AND p.tipo = 'regular' AND i.status = 'ativo'
      ORDER BY p.id`,
  );
  const horarios = await horariosDe(
    c,
    r.rows.map((l) => l.id),
  );
  return r.rows.map((l) => ({
    id: l.id,
    idosoId: l.idoso_id,
    inicio: l.inicio,
    fim: l.fim,
    criadaEm: l.criado_em,
    horarios: horarios.get(l.id) ?? [],
  }));
}

export type PrescricaoAtivaParaEstoque = {
  id: string;
  idosoId: string;
  medicamentoId: string;
  tipo: TipoDePrescricao;
  dose: number;
  unidade: UnidadeDeDose;
  inicio: string;
  fim: string | null;
  sosLimiteDiario: number | null;
  horarios: Horario[];
};

/**
 * Prescrições ativas (regulares e SOS) de idosos que estão na casa: é a demanda de remédio que o
 * estoque precisa cobrir. Idoso hospitalizado ou desligado não consome, então fica de fora.
 */
export async function prescricoesAtivasParaEstoque(
  c: PoolClient,
): Promise<PrescricaoAtivaParaEstoque[]> {
  const r = await c.query<{
    id: string;
    idoso_id: string;
    medicamento_id: string;
    tipo: TipoDePrescricao;
    dose: string;
    unidade: UnidadeDeDose;
    inicio: string;
    fim: string | null;
    sos_limite_diario: number | null;
  }>(
    `SELECT p.id, p.idoso_id, p.medicamento_id, p.tipo, p.dose::text AS dose, p.unidade,
            p.inicio::text AS inicio, p.fim::text AS fim, p.sos_limite_diario
       FROM prescricao p
       JOIN idoso i ON i.id = p.idoso_id AND i.casa_id = p.casa_id
      WHERE p.status = 'ativa' AND i.status = 'ativo'
      ORDER BY p.id`,
  );
  const horarios = await horariosDe(
    c,
    r.rows.map((l) => l.id),
  );
  return r.rows.map((l) => ({
    id: l.id,
    idosoId: l.idoso_id,
    medicamentoId: l.medicamento_id,
    tipo: l.tipo,
    dose: Number(l.dose),
    unidade: l.unidade,
    inicio: l.inicio,
    fim: l.fim,
    sosLimiteDiario: l.sos_limite_diario,
    horarios: horarios.get(l.id) ?? [],
  }));
}
