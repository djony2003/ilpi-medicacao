import type { PoolClient } from "pg";
import { comContexto, ehUuid } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { ehSaldoInsuficiente, loteVencido, lotesParaUso } from "@/modules/estoque";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import type { ConflitoDeAlergia } from "@/modules/prescricoes";
import {
  RESULTADOS,
  conferirDose,
  problemaNoAdiamento,
  regraDeHorario,
  usaMedicamento,
  type Bloqueio,
  type PrescricaoParaConferir,
  type RegistroAnterior,
  type ResultadoDaAdministracao,
} from "../dominio/conferencia";
import {
  MOTIVOS_DE_EXCECAO,
  alergiasDoIdoso,
  auditarBloqueio,
  casaDoRegistro,
  confirmarEtapa,
  contexto,
  ehViolacaoDaDoseUnica,
  gravarAdministracao,
  lerLoteDoRegistro,
  lerPulseira,
  registroDaChave,
  type ExcecaoDeConferencia,
  type FalhaDeConfirmacao,
  type PinDeOutraPessoa,
} from "./comum";

// Registro da dose agendada no tablet (spec 5.3): pulseira, etiqueta, conferência e resultado.
//
// O servidor não guarda "passo a passo": cada chamada traz tudo o que foi lido, e o registro refaz
// a conferência inteira dentro da transação que grava, com a dose travada. Assim, o que a tela
// mostrou não precisa ser confiado, e duas leituras simultâneas da mesma dose viram um só registro.

export const MOTIVO_MIN = 3;
export const MOTIVO_MAX = 500;
export const JUSTIFICATIVA_MIN = 10;

export type LinhaDaDose = {
  id: string;
  prescricao_id: string;
  idoso_id: string;
  idoso_nome: string;
  idoso_status: string;
  quarto: string | null;
  prevista_em: Date;
  cancelada_em: Date | null;
  data_local: string;
  hora_local: string;
  status: PrescricaoParaConferir["status"];
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
};

export async function carregarDose(
  c: PoolClient,
  doseId: string,
  travar: boolean,
): Promise<LinhaDaDose | null> {
  if (!ehUuid(doseId)) return null;
  // A trava fica só na linha da dose: é ela que serializa dois registros da mesma dose.
  const r = await c.query<LinhaDaDose>(
    `SELECT d.id, d.prescricao_id, d.idoso_id, i.nome AS idoso_nome, i.status::text AS idoso_status,
            i.quarto, d.prevista_em, d.cancelada_em, d.data_local::text AS data_local,
            to_char(d.hora_local, 'HH24:MI') AS hora_local, p.status, p.medicamento_id,
            m.nome_comercial, m.principio_ativo, m.concentracao, p.dose::text AS dose,
            p.unidade::text AS unidade, p.via::text AS via, p.instrucoes, p.alto_risco,
            p.alergias_confirmadas
       FROM dose_agendada d
       JOIN prescricao p ON p.id = d.prescricao_id AND p.casa_id = d.casa_id
       JOIN medicamento m ON m.id = p.medicamento_id AND m.casa_id = p.casa_id
       JOIN idoso i ON i.id = d.idoso_id AND i.casa_id = d.casa_id
      WHERE d.id = $1
      ${travar ? "FOR UPDATE OF d" : ""}`,
    [doseId],
  );
  return r.rows[0] ?? null;
}

export type RegistroDaDose = {
  id: string;
  resultado: ResultadoDaAdministracao;
  motivo: string | null;
  adiadaPara: string | null;
  usuarioNome: string;
  ocorridaEm: string;
  registradaEm: string;
  metodo: "qr" | "excecao" | "tardio";
  loteNumero: string | null;
  validadorNome: string | null;
};

export async function historico(c: PoolClient, doseId: string): Promise<RegistroDaDose[]> {
  const r = await c.query<{
    id: string;
    resultado: ResultadoDaAdministracao;
    motivo: string | null;
    adiada_para: Date | null;
    usuario_nome: string;
    ocorrida_em: Date;
    registrada_em: Date;
    metodo: RegistroDaDose["metodo"];
    numero_lote: string | null;
    validador_nome: string | null;
  }>(
    `SELECT a.id, a.resultado, a.motivo, a.adiada_para, u.nome AS usuario_nome, a.ocorrida_em,
            a.registrada_em, a.metodo, l.numero_lote, v.nome AS validador_nome
       FROM administracao a
       JOIN usuario u ON u.id = a.usuario_id
       LEFT JOIN lote_estoque l ON l.id = a.lote_id
       LEFT JOIN segunda_validacao s ON s.administracao_id = a.id
       LEFT JOIN usuario v ON v.id = s.validador_id
      WHERE a.dose_agendada_id = $1
      ORDER BY a.seq`,
    [doseId],
  );
  return r.rows.map((a) => ({
    id: a.id,
    resultado: a.resultado,
    motivo: a.motivo,
    adiadaPara: a.adiada_para?.toISOString() ?? null,
    usuarioNome: a.usuario_nome,
    ocorridaEm: a.ocorrida_em.toISOString(),
    registradaEm: a.registrada_em.toISOString(),
    metodo: a.metodo,
    loteNumero: a.numero_lote,
    validadorNome: a.validador_nome,
  }));
}

export function situacaoDoHistorico(h: RegistroDaDose[], prevista: Date) {
  const final = h.find((a) => a.resultado !== "adiada") ?? null;
  const adiamentos = h.filter((a) => a.resultado === "adiada");
  const ultimo = adiamentos.at(-1);
  const referencia = ultimo?.adiadaPara ? new Date(ultimo.adiadaPara) : prevista;
  const registroFinal: RegistroAnterior | null = final
    ? { usuarioNome: final.usuarioNome, ocorridaEm: new Date(final.ocorridaEm) }
    : null;
  return { final, referencia, registroFinal };
}

export const prescricaoDe = (d: LinhaDaDose): PrescricaoParaConferir => ({
  status: d.status,
  medicamentoId: d.medicamento_id,
  principioAtivo: d.principio_ativo,
  nomeComercial: d.nome_comercial,
  dose: Number(d.dose),
  unidade: d.unidade,
  alergiasConfirmadas: d.alergias_confirmadas,
});

// ------------------------------------------------------------------------------------------
// Conferência (o que a tela mostra a cada leitura)

export type ConferenciaDaDose = {
  dose: {
    id: string;
    idosoId: string;
    idosoNome: string;
    quarto: string | null;
    medicamento: { nome: string; principioAtivo: string; concentracao: string | null };
    dose: number;
    unidade: string;
    via: string;
    instrucoes: string | null;
    altoRisco: boolean;
    dataLocal: string;
    horaLocal: string;
    previstaEm: string;
    /** Horário que vale para a janela: o previsto, ou o novo se a dose foi adiada. */
    referenciaEm: string;
  };
  alergias: Array<{ substancia: string; gravidade: string }>;
  /** Alergias que coincidem mas foram confirmadas por quem prescreveu: avisar, sem bloquear. */
  alergiasConfirmadas: ConflitoDeAlergia[];
  /** Pulseira e etiqueta já lidas e conferidas (null = ainda não lida). */
  pulseiraConferida: boolean | null;
  lote: { numeroLote: string; validade: string; saldo: number; unidade: string } | null;
  bloqueios: Bloqueio[];
  horario: { tipo: "livre" } | { tipo: "exige_motivo"; sentido: "atrasado" | "adiantado" };
  /** Até quando a dose pode ser adiada (horário previsto + limite maior da casa). */
  adiarAte: string;
  exigeSegundaValidacao: boolean;
  historico: RegistroDaDose[];
};

export type PedidoDeConferencia = {
  doseId: string;
  pulseira?: string;
  lote?: string;
  ip?: string | null;
};

/**
 * Confere o que já foi lido (pulseira, depois etiqueta) sem gravar o registro. Bloqueio com
 * leitura feita fica na trilha de auditoria.
 */
export async function conferirDoseAgendada(
  servico: Servico,
  ator: SessaoAutenticada,
  p: PedidoDeConferencia,
): Promise<
  { ok: true; conferencia: ConferenciaDaDose } | Falha<"nao_encontrado" | "dose_cancelada">
> {
  exigirPermissao(ator.perfil, "administracao.registrar");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const d = await carregarDose(c, p.doseId, false);
    if (!d) return falha("nao_encontrado");
    if (d.cancelada_em !== null || d.idoso_status !== "ativo") return falha("dose_cancelada");
    const casa = await casaDoRegistro(c, agora);
    const h = await historico(c, d.id);
    const { referencia, registroFinal } = situacaoDoHistorico(h, d.prevista_em);
    const alergias = await alergiasDoIdoso(c, d.idoso_id);
    const pulseira = p.pulseira !== undefined ? await lerPulseira(c, p.pulseira) : null;
    const { leitura, lote } = await lerLoteDoRegistro(c, { lote: p.lote });
    const conf = conferirDose({
      idosoId: d.idoso_id,
      prescricao: prescricaoDe(d),
      alergias,
      registroFinal,
      pulseira,
      lote: leitura,
      resultado: "administrada",
      hoje: casa.hoje,
      fuso: casa.fuso,
    });
    const horario = regraDeHorario(referencia, agora, casa.janela);
    const bloqueios = [...conf.bloqueios];
    if (horario.tipo === "bloqueio" && !registroFinal) bloqueios.push(horario.bloqueio);
    if (bloqueios.length > 0 && (pulseira || leitura)) {
      await auditarBloqueio(c, ator, { entidade: "dose_agendada", id: d.id }, bloqueios, p.ip);
    }
    return {
      ok: true,
      conferencia: {
        dose: {
          id: d.id,
          idosoId: d.idoso_id,
          idosoNome: d.idoso_nome,
          quarto: d.quarto,
          medicamento: {
            nome: d.nome_comercial,
            principioAtivo: d.principio_ativo,
            concentracao: d.concentracao,
          },
          dose: Number(d.dose),
          unidade: d.unidade,
          via: d.via,
          instrucoes: d.instrucoes,
          altoRisco: d.alto_risco,
          dataLocal: d.data_local,
          horaLocal: d.hora_local,
          previstaEm: d.prevista_em.toISOString(),
          referenciaEm: referencia.toISOString(),
        },
        alergias: alergias.map((a) => ({ substancia: a.substancia, gravidade: a.gravidade })),
        alergiasConfirmadas: conf.alergiasConfirmadas,
        pulseiraConferida:
          pulseira === null ? null : !conf.bloqueios.some((b) => b.codigo.startsWith("pulseira")),
        lote: lote
          ? {
              numeroLote: lote.numeroLote,
              validade: lote.validade,
              saldo: lote.saldo,
              unidade: lote.unidade,
            }
          : null,
        bloqueios,
        horario: horario.tipo === "bloqueio" ? { tipo: "livre" } : horario,
        adiarAte: new Date(
          d.prevista_em.getTime() + casa.janela.limiteMaiorMin * 60_000,
        ).toISOString(),
        exigeSegundaValidacao: d.alto_risco,
        historico: h,
      },
    } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Registro

export type RegistroDeDose = {
  /** Gerada pelo tablet para esta tentativa (UUID): reenviar a mesma não duplica o registro. */
  chave: string;
  doseId: string;
  resultado: ResultadoDaAdministracao;
  /** Leitura da pulseira. Obrigatória, salvo em "não administrada". */
  pulseira?: string;
  /** Leitura da etiqueta do lote. Obrigatória em "administrada", salvo na exceção. */
  lote?: string;
  motivo?: string;
  /** ISO 8601. Só em "adiada". */
  adiadaPara?: string;
  excecao?: ExcecaoDeConferencia;
  segundaValidacao?: PinDeOutraPessoa;
  /** Enfermeiro que libera a dose antes do limite de antecipação. */
  liberacao?: PinDeOutraPessoa;
  ip?: string | null;
};

export type ResultadoDoRegistro =
  | {
      ok: true;
      administracaoId: string;
      resultado: ResultadoDaAdministracao;
      /** Reenvio da mesma tentativa: nada novo foi gravado. */
      repetido: boolean;
      saldoDoLote: number | null;
    }
  | Falha<
      | "dados_invalidos"
      | "nao_encontrado"
      | "dose_cancelada"
      | "chave_reutilizada"
      | "saldo_insuficiente"
      | "segunda_validacao_necessaria"
    >
  | (Falha<"conferencia_bloqueada"> & { bloqueios: Bloqueio[] })
  | (Falha<"motivo_obrigatorio"> & { sentido: "atrasado" | "adiantado" })
  | FalhaDeConfirmacao;

function problemasDoPedido(e: RegistroDeDose): string[] {
  const problemas: string[] = [];
  if (!ehUuid(e.chave)) problemas.push("Chave do registro inválida.");
  if (!RESULTADOS.includes(e.resultado)) problemas.push("Resultado desconhecido.");
  const motivo = e.motivo?.trim() ?? "";
  if (motivo.length > MOTIVO_MAX) problemas.push(`O motivo pode ter até ${MOTIVO_MAX} caracteres.`);
  if (e.resultado !== "administrada" && motivo.length < MOTIVO_MIN) {
    problemas.push("Informe o motivo.");
  }
  if (e.resultado !== "nao_administrada" && e.pulseira === undefined) {
    problemas.push("Leia a pulseira do paciente.");
  }
  if (e.resultado === "administrada") {
    if (e.excecao && e.lote !== undefined) {
      problemas.push("Leia a etiqueta OU use a exceção de conferência, não os dois.");
    }
    if (!e.excecao && e.lote === undefined) problemas.push("Leia a etiqueta do medicamento.");
  } else if (e.lote !== undefined || e.excecao) {
    problemas.push("Só a dose administrada usa lote.");
  }
  if ((e.resultado === "adiada") !== (e.adiadaPara !== undefined)) {
    problemas.push(
      e.resultado === "adiada" ? "Informe o novo horário." : "Só a dose adiada tem novo horário.",
    );
  }
  if (e.excecao) {
    if (!ehUuid(e.excecao.loteId)) problemas.push("Escolha o lote.");
    if (!MOTIVOS_DE_EXCECAO.includes(e.excecao.motivo))
      problemas.push("Motivo da exceção inválido.");
    const j = e.excecao.justificativa.trim().length;
    if (j < JUSTIFICATIVA_MIN || j > MOTIVO_MAX) {
      problemas.push(`Justifique a exceção (de ${JUSTIFICATIVA_MIN} a ${MOTIVO_MAX} caracteres).`);
    }
  }
  return problemas;
}

/**
 * Grava o resultado de uma dose agendada. Refaz toda a conferência com a dose travada, confirma
 * as identidades exigidas (liberação, exceção, segunda validação) e, se o remédio foi dado, baixa
 * o lote, tudo na mesma transação.
 */
export async function registrarDose(
  servico: Servico,
  ator: SessaoAutenticada,
  e: RegistroDeDose,
): Promise<ResultadoDoRegistro> {
  exigirPermissao(ator.perfil, "administracao.registrar");
  const problemas = problemasDoPedido(e);
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  const agora = relogio(servico);

  try {
    return await comContexto(
      servico.pool,
      contexto(ator),
      async (c): Promise<ResultadoDoRegistro> => {
        const d = await carregarDose(c, e.doseId, true);
        if (!d) return falha("nao_encontrado");

        // Depois da trava: se a mesma tentativa chegou duas vezes, a segunda enxerga a primeira.
        const mesma = await registroDaChave(c, e.chave);
        if (mesma) {
          return mesma.doseId === d.id && mesma.resultado === e.resultado
            ? {
                ok: true,
                administracaoId: mesma.id,
                resultado: e.resultado,
                repetido: true,
                saldoDoLote: null,
              }
            : falha("chave_reutilizada");
        }
        if (d.cancelada_em !== null || d.idoso_status !== "ativo") return falha("dose_cancelada");

        const casa = await casaDoRegistro(c, agora);
        const h = await historico(c, d.id);
        const { referencia, registroFinal } = situacaoDoHistorico(h, d.prevista_em);
        const pulseira = e.pulseira !== undefined ? await lerPulseira(c, e.pulseira) : null;
        const { leitura, lote } = await lerLoteDoRegistro(c, {
          lote: e.lote,
          loteEscolhido: e.excecao?.loteId,
        });
        const conf = conferirDose({
          idosoId: d.idoso_id,
          prescricao: prescricaoDe(d),
          alergias: usaMedicamento(e.resultado) ? await alergiasDoIdoso(c, d.idoso_id) : [],
          registroFinal,
          pulseira,
          lote: leitura,
          resultado: e.resultado,
          hoje: casa.hoje,
          fuso: casa.fuso,
        });
        const bloqueios = [...conf.bloqueios];
        const horario = regraDeHorario(referencia, agora, casa.janela);
        const precisaLiberar =
          horario.tipo === "bloqueio" && horario.bloqueio.codigo === "horario_antecipado";
        if (horario.tipo === "bloqueio" && !registroFinal && !(precisaLiberar && e.liberacao)) {
          bloqueios.push(horario.bloqueio);
        }
        if (bloqueios.length > 0) {
          await auditarBloqueio(c, ator, { entidade: "dose_agendada", id: d.id }, bloqueios, e.ip);
          return { ...falha("conferencia_bloqueada"), bloqueios };
        }

        const foraDaJanela =
          horario.tipo === "exige_motivo" ? horario.sentido : precisaLiberar ? "adiantado" : null;
        if (foraDaJanela && (e.motivo?.trim().length ?? 0) < MOTIVO_MIN) {
          return { ...falha("motivo_obrigatorio"), sentido: foraDaJanela };
        }

        let adiadaPara: Date | null = null;
        if (e.resultado === "adiada") {
          adiadaPara = new Date(e.adiadaPara ?? "");
          const problema = problemaNoAdiamento(adiadaPara, d.prevista_em, agora, casa.janela);
          if (problema) return dadosInvalidos(problema);
        }

        const exigeValidacao = d.alto_risco && e.resultado === "administrada";
        if (exigeValidacao && !e.segundaValidacao) return falha("segunda_validacao_necessaria");

        // Identidades: só depois de tudo conferido, e nada é gravado se alguma falhar (o contador
        // de erros de PIN, sim: ele é o que impede o chute).
        let liberadaPor: string | null = null;
        if (precisaLiberar && e.liberacao) {
          const r = await confirmarEtapa(c, ator, "liberacao", e.liberacao, agora, e.ip);
          if (!r.ok) return r;
          liberadaPor = r.pessoa.usuarioId;
        }
        let excecao = null;
        if (e.excecao) {
          const r = await confirmarEtapa(c, ator, "excecao", e.excecao.liberador, agora, e.ip);
          if (!r.ok) return r;
          excecao = {
            motivo: e.excecao.motivo,
            justificativa: e.excecao.justificativa,
            liberadaPor: r.pessoa.usuarioId,
          };
        }
        let validadorId: string | null = null;
        if (exigeValidacao && e.segundaValidacao) {
          const r = await confirmarEtapa(
            c,
            ator,
            "segunda_validacao",
            e.segundaValidacao,
            agora,
            e.ip,
          );
          if (!r.ok) return r;
          validadorId = r.pessoa.usuarioId;
        }

        const gravado = await gravarAdministracao(
          c,
          ator,
          {
            chave: e.chave,
            doseId: d.id,
            prescricaoId: d.prescricao_id,
            idosoId: d.idoso_id,
            resultado: e.resultado,
            motivo: e.motivo ?? null,
            adiadaPara,
            lote: e.resultado === "administrada" ? lote : null,
            quantidade: e.resultado === "administrada" ? Number(d.dose) : null,
            ocorridaEm: agora,
            registradaEm: agora,
            metodo: excecao ? "excecao" : "qr",
            foraDaJanela,
            liberadaPor,
            excecao,
            validadorId,
          },
          e.ip,
        );
        return {
          ok: true,
          administracaoId: gravado.id,
          resultado: e.resultado,
          repetido: false,
          saldoDoLote: gravado.saldoDoLote,
        };
      },
    );
  } catch (erro) {
    // Corridas que passaram juntas pela conferência: o banco decide, e a tela recebe a mensagem.
    if (ehSaldoInsuficiente(erro)) return falha("saldo_insuficiente");
    if (ehViolacaoDaDoseUnica(erro)) {
      return { ...falha("conferencia_bloqueada"), bloqueios: [bloqueioDeDoseRegistrada()] };
    }
    throw erro;
  }
}

function bloqueioDeDoseRegistrada(): Bloqueio {
  return { codigo: "dose_ja_registrada", mensagem: "Dose já registrada", acao: "Nenhuma." };
}

/** Detalhe de uma dose para a tela: o que é, a situação e o histórico de registros. */
export async function obterDose(
  servico: Servico,
  ator: SessaoAutenticada,
  doseId: string,
): ReturnType<typeof conferirDoseAgendada> {
  return conferirDoseAgendada(servico, ator, { doseId });
}

export type LoteDisponivel = {
  id: string;
  numeroLote: string;
  validade: string;
  vencido: boolean;
  saldo: number;
  unidade: string;
  destino: "comum" | "individual";
};

/** Lotes que podem atender esta dose, para escolher à mão na exceção de conferência. */
export async function lotesDaDose(
  servico: Servico,
  ator: SessaoAutenticada,
  doseId: string,
): Promise<{ ok: true; lotes: LoteDisponivel[] } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "administracao.registrar");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const d = await carregarDose(c, doseId, false);
    if (!d) return falha("nao_encontrado");
    const casa = await casaDoRegistro(c, agora);
    const lotes = await lotesParaUso(c, d.medicamento_id, d.idoso_id);
    return {
      ok: true,
      lotes: lotes.map((l) => ({
        id: l.id,
        numeroLote: l.numeroLote,
        validade: l.validade,
        vencido: loteVencido(l.validade, casa.hoje),
        saldo: l.saldo,
        unidade: l.unidade,
        destino: l.idosoId === null ? ("comum" as const) : ("individual" as const),
      })),
    } as const;
  });
}
