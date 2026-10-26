import type { Pool, PoolClient } from "pg";

// Busca por chave secreta antes de existir contexto de casa (ver ADR-002).
//
// Roda em transação SOMENTE LEITURA: o banco recusa qualquer escrita aqui. Serve apenas para
// descobrir a qual casa uma linha pertence. Depois disso, tudo continua em comContexto.

export type ChaveDeBusca = "login_email" | "sessao_hash" | "dispositivo_hash" | "ativacao_hash";

const VARIAVEL: Record<ChaveDeBusca, string> = {
  login_email: "app.login_email",
  sessao_hash: "app.sessao_hash",
  dispositivo_hash: "app.dispositivo_hash",
  ativacao_hash: "app.ativacao_hash",
};

export async function comBusca<T>(
  pool: Pool,
  chave: ChaveDeBusca,
  valor: string,
  fn: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (valor.length === 0) throw new Error("Chave de busca vazia.");

  const cliente = await pool.connect();
  let conexaoComprometida = false;
  try {
    await cliente.query("BEGIN READ ONLY");
    await cliente.query("SELECT set_config($1, $2, true)", [VARIAVEL[chave], valor]);
    const resultado = await fn(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (erro) {
    try {
      await cliente.query("ROLLBACK");
    } catch {
      conexaoComprometida = true;
    }
    throw erro;
  } finally {
    cliente.release(conexaoComprometida);
  }
}
