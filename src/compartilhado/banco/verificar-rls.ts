import type { Pool, PoolClient } from "pg";

// Garante que nenhuma tabela do schema public esteja sem isolamento por linha.
//
// Toda tabela precisa ter RLS habilitado (ENABLE) e forçado (FORCE). O FORCE faz a política valer
// também para o dono da tabela, que é o papel das migrações.

export async function tabelasSemRls(banco: Pool | PoolClient): Promise<string[]> {
  const resultado = await (banco as Pool).query<{ tabela: string }>(`
    SELECT c.relname AS tabela
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    ORDER BY c.relname
  `);
  return resultado.rows.map((linha) => linha.tabela);
}
