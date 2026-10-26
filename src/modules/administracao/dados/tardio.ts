import { comContexto, ehUuid } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { ehSaldoInsuficiente } from "@/modules/estoque";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import { conferirDose, type Bloqueio } from "../dominio/conferencia";
import { dataLocalDe } from "../dominio/tempo";
import {
  alergiasDoIdoso,
  auditarBloqueio,
  casaDoRegistro,
  confirmarEtapa,
  contexto,
  ehViolacaoDaDoseUnica,
  gravarAdministracao,
  lerLoteDoRegistro,
  registroDaChave,
  type FalhaDeConfirmacao,
  type PinDeOutraPessoa,
} from "./comum";
import {
  MOTIVO_MAX,
  MOTIVO_MIN,
  carregarDose,
  historico,
  prescricaoDe,
  situacaoDoHistorico,
} from "./registro";

// Registro tardio (spec 5.8): a dose foi dada (ou recusada) durante uma queda de internet, anotada
// na folha de contingência, e é lançada depois com o horário real. Não há leitura de pulseira
// (o paciente não está diante do tablet), então:
//  - pede a senha ou o PIN de novo de quem lança;
//  - o motivo é obrigatório e o registro leva a marca "tardio" na tabela e na auditoria;
//  - alergia, prescrição, remédio, validade (na data em que foi dado) e saldo valem como sempre;
//  - alto risco continua exigindo a segunda pessoa.

const MIN = 60_000;
const DIA = 24 * 60 * MIN;
/** Até quando depois do horário previsto uma dose pode ser lançada como tardia. */
export const PRAZO_DO_REGISTRO_TARDIO_DIAS = 7;

export type RegistroTardio = {
  chave: string;
  doseId: string;
  resultado: "administrada" | "recusada" | "nao_administrada";
  /** ISO 8601: quando aconteceu de verdade (o que está na folha). */
  ocorridaEm: string;
  motivo: string;
  /** Etiqueta do lote usado (QR ou código digitado). Obrigatória em "administrada". */
  lote?: string;
  segundaValidacao?: PinDeOutraPessoa;
  ip?: string | null;
};

export type ResultadoDoTardio =
  | { ok: true; administracaoId: string; repetido: boolean; saldoDoLote: number | null }
  | Falha<
      | "dados_invalidos"
      | "nao_encontrado"
      | "dose_cancelada"
      | "chave_reutilizada"
      | "saldo_insuficiente"
      | "segunda_validacao_necessaria"
      | "prazo_do_registro_tardio"
    >
  | (Falha<"conferencia_bloqueada"> & { bloqueios: Bloqueio[] })
  | FalhaDeConfirmacao;

export async function registrarTardio(
  servico: Servico,
  ator: SessaoAutenticada,
  e: RegistroTardio,
): Promise<ResultadoDoTardio> {
  exigirPermissao(ator.perfil, "administracao.registrar");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);

  const problemas: string[] = [];
  if (!ehUuid(e.chave)) problemas.push("Chave do registro inválida.");
  if (!["administrada", "recusada", "nao_administrada"].includes(e.resultado)) {
    problemas.push("Resultado inválido para registro tardio.");
  }
  const motivo = e.motivo.trim();
  if (motivo.length < MOTIVO_MIN || motivo.length > MOTIVO_MAX) {
    problemas.push("Informe o motivo do registro tardio.");
  }
  const ocorridaEm = new Date(e.ocorridaEm);
  if (Number.isNaN(ocorridaEm.getTime())) problemas.push("Informe quando a dose aconteceu.");
  else if (ocorridaEm.getTime() > agora.getTime()) {
    problemas.push("O horário informado ainda não chegou.");
  }
  if (e.resultado === "administrada" && e.lote === undefined) {
    problemas.push("Leia ou digite o código da etiqueta do lote usado.");
  }
  if (e.resultado !== "administrada" && e.lote !== undefined) {
    problemas.push("Só a dose administrada usa lote.");
  }
  if (problemas.length > 0) return dadosInvalidos(...problemas);

  try {
    return await comContexto(
      servico.pool,
      contexto(ator),
      async (c): Promise<ResultadoDoTardio> => {
        const d = await carregarDose(c, e.doseId, true);
        if (!d) return falha("nao_encontrado");
        const mesma = await registroDaChave(c, e.chave);
        if (mesma) {
          return mesma.doseId === d.id && mesma.resultado === e.resultado
            ? { ok: true, administracaoId: mesma.id, repetido: true, saldoDoLote: null }
            : falha("chave_reutilizada");
        }
        // Idoso internado DEPOIS da dose não cancela a dose que já passou: ela ainda pode ser lançada.
        if (d.cancelada_em !== null) return falha("dose_cancelada");

        const casa = await casaDoRegistro(c, agora);
        if (d.prevista_em.getTime() < agora.getTime() - PRAZO_DO_REGISTRO_TARDIO_DIAS * DIA) {
          return falha("prazo_do_registro_tardio");
        }
        const cedo = d.prevista_em.getTime() - casa.janela.limiteMaiorMin * MIN;
        if (ocorridaEm.getTime() < cedo || ocorridaEm.getTime() > d.prevista_em.getTime() + DIA) {
          return dadosInvalidos("O horário informado não corresponde a esta dose.");
        }

        // A prescrição valia no momento da dose? (pode ter sido encerrada depois, sem culpa de ninguém)
        const enc = await c.query<{ encerrada_em: Date | null }>(
          "SELECT encerrada_em FROM prescricao WHERE id = $1",
          [d.prescricao_id],
        );
        const encerradaEm = enc.rows[0]?.encerrada_em ?? null;
        const valiaNaHora = encerradaEm === null || encerradaEm.getTime() > ocorridaEm.getTime();

        const h = await historico(c, d.id);
        const { registroFinal } = situacaoDoHistorico(h, d.prevista_em);
        const { leitura, lote } = await lerLoteDoRegistro(c, { lote: e.lote });
        const conf = conferirDose({
          idosoId: d.idoso_id,
          prescricao: { ...prescricaoDe(d), status: valiaNaHora ? "ativa" : "encerrada" },
          alergias: e.resultado === "administrada" ? await alergiasDoIdoso(c, d.idoso_id) : [],
          registroFinal,
          pulseira: null,
          lote: leitura,
          resultado: e.resultado,
          // Validade do lote na data em que o remédio foi dado.
          hoje: dataLocalDe(ocorridaEm, casa.fuso),
          fuso: casa.fuso,
        });
        if (conf.bloqueios.length > 0) {
          await auditarBloqueio(
            c,
            ator,
            { entidade: "dose_agendada", id: d.id },
            conf.bloqueios,
            e.ip,
          );
          return { ...falha("conferencia_bloqueada"), bloqueios: conf.bloqueios };
        }

        const exigeValidacao = d.alto_risco && e.resultado === "administrada";
        if (exigeValidacao && !e.segundaValidacao) return falha("segunda_validacao_necessaria");
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
            motivo,
            adiadaPara: null,
            lote: e.resultado === "administrada" ? lote : null,
            quantidade: e.resultado === "administrada" ? Number(d.dose) : null,
            ocorridaEm,
            registradaEm: agora,
            metodo: "tardio",
            foraDaJanela: null,
            liberadaPor: null,
            excecao: null,
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
      },
    );
  } catch (erro) {
    if (ehSaldoInsuficiente(erro)) return falha("saldo_insuficiente");
    if (ehViolacaoDaDoseUnica(erro)) {
      return {
        ...falha("conferencia_bloqueada"),
        bloqueios: [
          { codigo: "dose_ja_registrada", mensagem: "Dose já registrada", acao: "Nenhuma." },
        ],
      };
    }
    throw erro;
  }
}
