import type { Pool, PoolClient } from "pg";

// Caminho único para consultar dados de uma casa.
//
// Abre uma transação, define a casa e o usuário com set_config(..., is_local = true) (equivalente
// a SET LOCAL, mas aceita parâmetros) e executa a função recebida. As políticas de RLS leem esses
// valores por app_casa_id() e app_usuario_id(). Como os valores são locais à transação, eles
// desaparecem no COMMIT ou ROLLBACK e não vazam para a próxima requisição que reutilizar a conexão.

export type ContextoRequisicao = {
  casaId: string;
  usuarioId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ehUuid(valor: unknown): valor is string {
  return typeof valor === "string" && UUID.test(valor);
}

export async function comContexto<T>(
  pool: Pool,
  contexto: ContextoRequisicao,
  fn: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (!ehUuid(contexto.casaId)) {
    throw new Error("Contexto inválido: casaId deve ser um UUID.");
  }
  if (contexto.usuarioId !== undefined && !ehUuid(contexto.usuarioId)) {
    throw new Error("Contexto inválido: usuarioId deve ser um UUID.");
  }

  const cliente = await pool.connect();
  let conexaoComprometida = false;
  try {
    await cliente.query("BEGIN");
    await cliente.query(
      "SELECT set_config('app.casa_id', $1, true), set_config('app.usuario_id', $2, true)",
      [contexto.casaId, contexto.usuarioId ?? ""],
    );
    const resultado = await fn(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (erro) {
    try {
      await cliente.query("ROLLBACK");
    } catch {
      // Se nem o ROLLBACK funcionou, a conexão não é confiável: descartar em vez de devolver ao pool.
      conexaoComprometida = true;
    }
    throw erro;
  } finally {
    cliente.release(conexaoComprometida);
  }
}
