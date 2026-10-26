import type { PoolClient } from "pg";
import { comContexto, ehUuid } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import { ehSaldoInsuficiente } from "@/modules/estoque";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import { estaVigente, verificarLimiteSos, type ResultadoSos } from "@/modules/prescricoes";
import { conferirDose, type Bloqueio } from "../dominio/conferencia";
import {
  MOTIVOS_DE_EXCECAO,
  alergiasDoIdoso,
  auditarBloqueio,
  casaDoRegistro,
  confirmarEtapa,
  contexto,
  gravarAdministracao,
  lerLoteDoRegistro,
  lerPulseira,
  registroDaChave,
  type ExcecaoDeConferencia,
  type FalhaDeConfirmacao,
  type PinDeOutraPessoa,
} from "./comum";
import { JUSTIFICATIVA_MIN, MOTIVO_MAX, MOTIVO_MIN } from "./registro";

// Dose "se necessário" (spec 5.7): não tem horário agendado. O cuidador informa o sintoma, faz a
// mesma conferência por QR e o sistema respeita o limite diário (janela móvel de 24 horas) e o
// intervalo mínimo da prescrição. Passou do limite: bloqueia, e o bloqueio fica na trilha para o
// enfermeiro (o alerta ativo chega com o M6).
//
// O limite conta todas as versões da prescrição (o grupo): corrigir a dose não zera a contagem.

const HORA_MS = 3_600_000;

type LinhaSos = {
  id: string;
  grupo_id: string;
  idoso_id: string;
  idoso_status: string;
  status: "ativa" | "encerrada" | "substituida";
  tipo: "regular" | "sos";
  inicio: string;
  fim: string | null;
  medicamento_id: string;
  nome_comercial: string;
  principio_ativo: string;
  concentracao: string | null;
  dose: string;
  unidade: string;
  via: string;
  instrucoes: string | null;
  alto_risco: boolean;
  alergias_confirmadas: string[];
  sos_indicacao: string | null;
  sos_limite_diario: number | null;
  sos_intervalo_min: number | null;
};

const SELECT_SOS = `SELECT p.id, p.grupo_id, p.idoso_id, i.status::text AS idoso_status, p.status, p.tipo,
       p.inicio::text AS inicio, p.fim::text AS fim, p.medicamento_id, m.nome_comercial,
       m.principio_ativo, m.concentracao, p.dose::text AS dose, p.unidade::text AS unidade,
       p.via::text AS via, p.instrucoes, p.alto_risco, p.alergias_confirmadas, p.sos_indicacao,
       p.sos_limite_diario, p.sos_intervalo_min
  FROM prescricao p
  JOIN medicamento m ON m.id = p.medicamento_id AND m.casa_id = p.casa_id
  JOIN idoso i ON i.id = p.idoso_id AND i.casa_id = p.casa_id`;

async function dosesSosRecentes(c: PoolClient, grupoId: string, agora: Date): Promise<Date[]> {
  const r = await c.query<{ ocorrida_em: Date }>(
    `SELECT a.ocorrida_em
       FROM administracao a
       JOIN prescricao p ON p.id = a.prescricao_id
      WHERE p.grupo_id = $1 AND a.resultado = 'administrada' AND a.dose_agendada_id IS NULL
        AND a.ocorrida_em > $2`,
    [grupoId, new Date(agora.getTime() - 48 * HORA_MS)],
  );
  return r.rows.map((x) => x.ocorrida_em);
}

const limiteDe = (p: LinhaSos) => ({
  limiteDiario: p.sos_limite_diario ?? 1,
  intervaloMinimoMin: p.sos_intervalo_min ?? 0,
});

export type SosDoIdoso = {
  prescricaoId: string;
  medicamento: { nome: string; principioAtivo: string; concentracao: string | null };
  dose: number;
  unidade: string;
  via: string;
  instrucoes: string | null;
  indicacao: string;
  limiteDiario: number;
  intervaloMinimoMin: number;
  altoRisco: boolean;
  dosesNas24h: number;
  ultimaEm: string | null;
  /** Se agora estiver bloqueado, quando libera. */
  liberaEm: string | null;
  motivoDoBloqueio: "intervalo_minimo" | "limite_diario" | null;
};

/** Doses SOS que o idoso pode receber agora (ou quando liberam), para a tela após a pulseira. */
export async function listarSosDoIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  idosoId: string,
): Promise<{ ok: true; sos: SosDoIdoso[] } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "administracao.registrar");
  if (!ehUuid(idosoId)) return falha("nao_encontrado");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const i = await c.query("SELECT 1 FROM idoso WHERE id = $1", [idosoId]);
    if (i.rowCount !== 1) return falha("nao_encontrado");
    const casa = await casaDoRegistro(c, agora);
    const r = await c.query<LinhaSos>(
      `${SELECT_SOS} WHERE p.idoso_id = $1 AND p.tipo = 'sos' AND p.status = 'ativa' ORDER BY m.nome_comercial`,
      [idosoId],
    );
    const sos: SosDoIdoso[] = [];
    for (const p of r.rows.filter((x) => estaVigente(x, casa.hoje))) {
      const doses = await dosesSosRecentes(c, p.grupo_id, agora);
      const limite = limiteDe(p);
      const v = verificarLimiteSos(limite, doses, agora);
      const ultima = doses.length > 0 ? new Date(Math.max(...doses.map((d) => d.getTime()))) : null;
      sos.push({
        prescricaoId: p.id,
        medicamento: {
          nome: p.nome_comercial,
          principioAtivo: p.principio_ativo,
          concentracao: p.concentracao,
        },
        dose: Number(p.dose),
        unidade: p.unidade,
        via: p.via,
        instrucoes: p.instrucoes,
        indicacao: p.sos_indicacao ?? "",
        limiteDiario: limite.limiteDiario,
        intervaloMinimoMin: limite.intervaloMinimoMin,
        altoRisco: p.alto_risco,
        dosesNas24h: doses.filter((d) => d.getTime() > agora.getTime() - 24 * HORA_MS).length,
        ultimaEm: ultima?.toISOString() ?? null,
        liberaEm: v.permitido ? null : v.liberaEm.toISOString(),
        motivoDoBloqueio: v.permitido ? null : v.motivo,
      });
    }
    return { ok: true, sos } as const;
  });
}

export type RegistroSos = {
  chave: string;
  prescricaoId: string;
  pulseira: string;
  lote?: string;
  /** O sintoma que motivou a dose (obrigatório). */
  sintoma: string;
  excecao?: ExcecaoDeConferencia;
  segundaValidacao?: PinDeOutraPessoa;
  ip?: string | null;
};

export type FalhaDeLimiteSos = Falha<"limite_sos"> & {
  limite: "intervalo_minimo" | "limite_diario";
  liberaEm: string;
  mensagem: string;
};

export type ResultadoDoSos =
  | { ok: true; administracaoId: string; repetido: boolean; saldoDoLote: number | null }
  | Falha<
      | "dados_invalidos"
      | "nao_encontrado"
      | "nao_e_sos"
      | "chave_reutilizada"
      | "saldo_insuficiente"
      | "segunda_validacao_necessaria"
    >
  | (Falha<"conferencia_bloqueada"> & { bloqueios: Bloqueio[] })
  | FalhaDeLimiteSos
  | FalhaDeConfirmacao;

function mensagemDoLimite(v: Extract<ResultadoSos, { permitido: false }>): string {
  return v.motivo === "limite_diario"
    ? "Limite de doses em 24 horas atingido. Avise o enfermeiro."
    : "Ainda não passou o intervalo mínimo desde a última dose. Avise o enfermeiro.";
}

export async function registrarSos(
  servico: Servico,
  ator: SessaoAutenticada,
  e: RegistroSos,
): Promise<ResultadoDoSos> {
  exigirPermissao(ator.perfil, "administracao.registrar");
  const problemas: string[] = [];
  if (!ehUuid(e.chave)) problemas.push("Chave do registro inválida.");
  const sintoma = e.sintoma.trim();
  if (sintoma.length < MOTIVO_MIN || sintoma.length > MOTIVO_MAX) {
    problemas.push("Informe o sintoma que motivou a dose.");
  }
  if (e.excecao && e.lote !== undefined) {
    problemas.push("Leia a etiqueta OU use a exceção de conferência, não os dois.");
  }
  if (!e.excecao && e.lote === undefined) problemas.push("Leia a etiqueta do medicamento.");
  if (e.excecao) {
    if (!ehUuid(e.excecao.loteId)) problemas.push("Escolha o lote.");
    if (!MOTIVOS_DE_EXCECAO.includes(e.excecao.motivo))
      problemas.push("Motivo da exceção inválido.");
    const j = e.excecao.justificativa.trim().length;
    if (j < JUSTIFICATIVA_MIN || j > MOTIVO_MAX) {
      problemas.push(`Justifique a exceção (de ${JUSTIFICATIVA_MIN} a ${MOTIVO_MAX} caracteres).`);
    }
  }
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  if (!ehUuid(e.prescricaoId)) return falha("nao_encontrado");
  const agora = relogio(servico);

  try {
    return await comContexto(servico.pool, contexto(ator), async (c): Promise<ResultadoDoSos> => {
      const r = await c.query<LinhaSos>(`${SELECT_SOS} WHERE p.id = $1`, [e.prescricaoId]);
      const p = r.rows[0];
      if (!p) return falha("nao_encontrado");
      if (p.tipo !== "sos") return falha("nao_e_sos");
      // Serializa as doses SOS da mesma prescrição: duas pessoas não passam juntas pelo limite.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('sos:' || $1, 0))", [
        p.grupo_id,
      ]);

      const mesma = await registroDaChave(c, e.chave);
      if (mesma) {
        return mesma.prescricaoId === p.id && mesma.doseId === null
          ? { ok: true, administracaoId: mesma.id, repetido: true, saldoDoLote: null }
          : falha("chave_reutilizada");
      }

      const casa = await casaDoRegistro(c, agora);
      const vigente =
        p.status === "ativa" && p.idoso_status === "ativo" && estaVigente(p, casa.hoje);
      const pulseira = await lerPulseira(c, e.pulseira);
      const { leitura, lote } = await lerLoteDoRegistro(c, {
        lote: e.lote,
        loteEscolhido: e.excecao?.loteId,
      });
      const conf = conferirDose({
        idosoId: p.idoso_id,
        prescricao: {
          status: vigente ? "ativa" : "encerrada",
          medicamentoId: p.medicamento_id,
          principioAtivo: p.principio_ativo,
          nomeComercial: p.nome_comercial,
          dose: Number(p.dose),
          unidade: p.unidade,
          alergiasConfirmadas: p.alergias_confirmadas,
        },
        alergias: await alergiasDoIdoso(c, p.idoso_id),
        registroFinal: null,
        pulseira,
        lote: leitura,
        resultado: "administrada",
        hoje: casa.hoje,
        fuso: casa.fuso,
      });
      if (conf.bloqueios.length > 0) {
        await auditarBloqueio(c, ator, { entidade: "prescricao", id: p.id }, conf.bloqueios, e.ip);
        return { ...falha("conferencia_bloqueada"), bloqueios: conf.bloqueios };
      }

      const v = verificarLimiteSos(
        limiteDe(p),
        await dosesSosRecentes(c, p.grupo_id, agora),
        agora,
      );
      if (!v.permitido) {
        await registrarAuditoria(c, {
          acao: "administracao.sos_bloqueada",
          entidade: "prescricao",
          entidadeId: p.id,
          depois: { limite: v.motivo, liberaEm: v.liberaEm.toISOString() },
          dispositivoId: ator.dispositivoId,
          ip: e.ip,
        });
        return {
          ...falha("limite_sos"),
          limite: v.motivo,
          liberaEm: v.liberaEm.toISOString(),
          mensagem: mensagemDoLimite(v),
        };
      }

      if (p.alto_risco && !e.segundaValidacao) return falha("segunda_validacao_necessaria");
      let excecao = null;
      if (e.excecao) {
        const x = await confirmarEtapa(c, ator, "excecao", e.excecao.liberador, agora, e.ip);
        if (!x.ok) return x;
        excecao = {
          motivo: e.excecao.motivo,
          justificativa: e.excecao.justificativa,
          liberadaPor: x.pessoa.usuarioId,
        };
      }
      let validadorId: string | null = null;
      if (p.alto_risco && e.segundaValidacao) {
        const x = await confirmarEtapa(
          c,
          ator,
          "segunda_validacao",
          e.segundaValidacao,
          agora,
          e.ip,
        );
        if (!x.ok) return x;
        validadorId = x.pessoa.usuarioId;
      }

      const gravado = await gravarAdministracao(
        c,
        ator,
        {
          chave: e.chave,
          doseId: null,
          prescricaoId: p.id,
          idosoId: p.idoso_id,
          resultado: "administrada",
          motivo: sintoma,
          adiadaPara: null,
          lote,
          quantidade: Number(p.dose),
          ocorridaEm: agora,
          registradaEm: agora,
          metodo: excecao ? "excecao" : "qr",
          foraDaJanela: null,
          liberadaPor: null,
          excecao,
          validadorId,
        },
        e.ip,
      );
      return {
        ok: true,
        administracaoId: gravado.id,
        repetido: false,
        saldoDoLote: gravado.saldoDoLote,
      };
    });
  } catch (erro) {
    if (ehSaldoInsuficiente(erro)) return falha("saldo_insuficiente");
    throw erro;
  }
}
