import type { Correio } from "@/compartilhado/correio";
import {
  gerarEscalaDeTodasAsCasas,
  type ResultadoDoAgendador,
  type ServicoDeGeracao,
} from "@/modules/administracao";
import { casasAtivas, enviarAlertasDaCasa, verificarAlertasDaCasa } from "@/modules/alertas";

// Laço do agendador: de tempos em tempos, gera as doses de todas as casas, verifica os alertas e
// envia os e-mails da fila. Duas cópias rodando ao mesmo tempo são inofensivas: a geração é
// idempotente, a verificação de cada casa tem trava (a segunda cópia pula) e o envio pega cada
// e-mail uma vez só.

/** 5 minutos: dose atrasada é avisada no máximo 5 minutos depois de sair da janela. */
export const INTERVALO_PADRAO_MS = 5 * 60_000;

export type OpcoesDosAlertas = {
  /** Sem correio configurado, os alertas ficam só no painel e os e-mails esperam na fila. */
  correio?: Correio;
  linkDoPainel?: string;
};

export type ResultadoDosAlertas = {
  casas: number;
  abertos: number;
  resolvidos: number;
  escalados: number;
  emailsEnviados: number;
  falhas: { casaId: string; etapa: "verificar" | "enviar"; erro: string }[];
};

/** Verifica os alertas e envia os e-mails de todas as casas; a falha de uma não para as outras. */
export async function alertasDeTodasAsCasas(
  servico: ServicoDeGeracao,
  opcoes: OpcoesDosAlertas = {},
): Promise<ResultadoDosAlertas> {
  const casas = await casasAtivas(servico.pool);
  const r: ResultadoDosAlertas = {
    casas: casas.length,
    abertos: 0,
    resolvidos: 0,
    escalados: 0,
    emailsEnviados: 0,
    falhas: [],
  };
  for (const casaId of casas) {
    try {
      const v = await verificarAlertasDaCasa(servico, casaId);
      r.abertos += v.abertos;
      r.resolvidos += v.resolvidos;
      r.escalados += v.escalados;
    } catch (erro) {
      r.falhas.push({
        casaId,
        etapa: "verificar",
        erro: erro instanceof Error ? erro.name : "Erro",
      });
    }
    if (!opcoes.correio) continue;
    try {
      const e = await enviarAlertasDaCasa(
        servico,
        casaId,
        opcoes.correio,
        opcoes.linkDoPainel ?? "/painel",
      );
      r.emailsEnviados += e.enviados;
    } catch (erro) {
      r.falhas.push({ casaId, etapa: "enviar", erro: erro instanceof Error ? erro.name : "Erro" });
    }
  }
  return r;
}

export type Registro = (nivel: "info" | "error", mensagem: string, dados?: object) => void;

export async function executarUmaRodada(
  servico: ServicoDeGeracao,
  registrar: Registro,
  opcoes: OpcoesDosAlertas = {},
): Promise<ResultadoDoAgendador | null> {
  try {
    const r = await gerarEscalaDeTodasAsCasas(servico);
    // As doses vêm antes dos alertas: o alerta de dose atrasada olha para as doses já geradas.
    const a = await alertasDeTodasAsCasas(servico, opcoes);
    registrar(r.falhas.length + a.falhas.length > 0 ? "error" : "info", "rodada concluída", {
      casas: r.casas,
      criadas: r.criadas,
      falhas: r.falhas,
      alertas: {
        abertos: a.abertos,
        resolvidos: a.resolvidos,
        escalados: a.escalados,
        emailsEnviados: a.emailsEnviados,
        falhas: a.falhas,
      },
    });
    return r;
  } catch (erro) {
    // Falha geral (banco fora do ar, por exemplo): registra e tenta de novo na próxima rodada.
    registrar("error", "rodada falhou", { erro: erro instanceof Error ? erro.name : "Erro" });
    return null;
  }
}

export async function rodarAgendador(opcoes: {
  servico: ServicoDeGeracao;
  registrar: Registro;
  intervaloMs?: number;
  sinal: AbortSignal;
  alertas?: OpcoesDosAlertas;
}): Promise<void> {
  const intervalo = opcoes.intervaloMs ?? INTERVALO_PADRAO_MS;
  while (!opcoes.sinal.aborted) {
    await executarUmaRodada(opcoes.servico, opcoes.registrar, opcoes.alertas);
    await esperar(intervalo, opcoes.sinal);
  }
}

function esperar(ms: number, sinal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    if (sinal.aborted) return resolver();
    const t = setTimeout(fim, ms);
    function fim() {
      clearTimeout(t);
      sinal.removeEventListener("abort", fim);
      resolver();
    }
    sinal.addEventListener("abort", fim);
  });
}
