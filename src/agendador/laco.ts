import {
  gerarEscalaDeTodasAsCasas,
  type ResultadoDoAgendador,
  type ServicoDeGeracao,
} from "@/modules/administracao";

// Laço do agendador: de tempos em tempos, gera as doses de todas as casas. Duas cópias rodando ao
// mesmo tempo são inofensivas (a geração é idempotente e segura em paralelo), então não há trava.

export const INTERVALO_PADRAO_MS = 15 * 60_000;

export type Registro = (nivel: "info" | "error", mensagem: string, dados?: object) => void;

export async function executarUmaRodada(
  servico: ServicoDeGeracao,
  registrar: Registro,
): Promise<ResultadoDoAgendador | null> {
  try {
    const r = await gerarEscalaDeTodasAsCasas(servico);
    registrar(r.falhas.length > 0 ? "error" : "info", "rodada concluída", {
      casas: r.casas,
      criadas: r.criadas,
      falhas: r.falhas,
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
}): Promise<void> {
  const intervalo = opcoes.intervaloMs ?? INTERVALO_PADRAO_MS;
  while (!opcoes.sinal.aborted) {
    await executarUmaRodada(opcoes.servico, opcoes.registrar);
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
