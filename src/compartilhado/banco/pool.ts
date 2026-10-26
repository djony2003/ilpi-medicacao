import pg from "pg";
import { ambiente } from "../ambiente";

// Pool único de conexões da aplicação (papel ilpi_app). Em desenvolvimento o Next recarrega
// módulos a cada alteração; guardar o pool em globalThis evita abrir um pool novo a cada recarga.

const globais = globalThis as typeof globalThis & { __ilpiPool?: pg.Pool };

export function obterPool(): pg.Pool {
  globais.__ilpiPool ??= new pg.Pool({
    connectionString: ambiente().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return globais.__ilpiPool;
}
