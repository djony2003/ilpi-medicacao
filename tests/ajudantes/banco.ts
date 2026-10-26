import pg from "pg";

function exigir(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variável ${nome} ausente: o global-setup deveria tê-la definido.`);
  return valor;
}

/** Pool com o papel da aplicação (sem superusuário, sem BYPASSRLS). */
export function criarPoolApp(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: exigir("DATABASE_URL"), max });
}

/** Pool com o papel dono do schema, usado para preparar tabelas de teste. */
export function criarPoolMigrador(max = 2): pg.Pool {
  return new pg.Pool({ connectionString: exigir("MIGRATOR_DATABASE_URL"), max });
}

/**
 * Conexão de superusuário ao banco de teste, usada só para simular adulteração direta no banco
 * (algo que nenhum papel da aplicação consegue fazer). Devolve null se não houver credencial.
 */
export async function abrirAdmin(): Promise<pg.Client | null> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) return null;
  const url = new URL(adminUrl);
  url.pathname = new URL(exigir("DATABASE_URL")).pathname;
  const cliente = new pg.Client({ connectionString: url.toString() });
  await cliente.connect();
  return cliente;
}

export const TEM_ADMIN = Boolean(process.env.ADMIN_DATABASE_URL);

export const CASA_A = "11111111-1111-4111-8111-111111111111";
export const CASA_B = "22222222-2222-4222-8222-222222222222";
export const USUARIO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
