import { falha, type Falha } from "@/compartilhado/resultado";

// O banco recusa qualquer movimento que deixaria o saldo de um lote negativo (gatilho
// movimento_estoque_saldo). A checagem na aplicação dá a mensagem boa no caso comum; esta tradução
// cobre a corrida: dois movimentos simultâneos que passaram juntos pela checagem.

export function ehSaldoInsuficiente(erro: unknown): boolean {
  const e = erro as { code?: string; constraint?: string } | null;
  return e?.code === "23514" && e.constraint === "saldo_do_lote_nao_negativo";
}

export async function traduzirSaldoInsuficiente<T>(
  operacao: () => Promise<T>,
): Promise<T | Falha<"saldo_insuficiente">> {
  try {
    return await operacao();
  } catch (erro) {
    if (ehSaldoInsuficiente(erro)) return falha("saldo_insuficiente");
    throw erro;
  }
}
