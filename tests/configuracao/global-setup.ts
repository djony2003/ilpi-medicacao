import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Prepara o banco de teste antes da suíte. Os testes sempre usam o banco "ilpi_test",
// nunca o banco de desenvolvimento, porque criam e removem tabelas temporárias.
//
// Quando há credencial de administrador, o banco de teste é recriado do zero a cada execução.
// Isso garante que as migrações funcionam a partir do vazio e que não sobram dados de execuções
// anteriores (a auditoria, por exemplo, não permite apagar linhas).

const NOME_BANCO_TESTE = "ilpi_test";

function trocarBanco(url: string, banco: string): string {
  const destino = new URL(url);
  destino.pathname = `/${banco}`;
  return destino.toString();
}

async function recriarBancoDeTeste(adminUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${NOME_BANCO_TESTE} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

export default async function setup() {
  const raiz = path.resolve(import.meta.dirname, "../..");
  const arquivoEnv = path.join(raiz, ".env");
  if (fs.existsSync(arquivoEnv)) process.loadEnvFile(arquivoEnv);

  for (const nome of ["DATABASE_URL", "MIGRATOR_DATABASE_URL"]) {
    const valor = process.env[nome];
    if (!valor) {
      throw new Error(
        `Variável ${nome} não definida. Copie .env.example para .env e rode "npm run db:setup".`,
      );
    }
    process.env[nome] = trocarBanco(valor, NOME_BANCO_TESTE);
  }

  // Papel do agendador: se o .env antigo não o define, usa um valor só de teste.
  process.env.ILPI_AGENDADOR_PASSWORD ??= "agendador_dev_local";
  const destinoApp = new URL(process.env.DATABASE_URL ?? "");
  destinoApp.username = "ilpi_agendador";
  destinoApp.password = process.env.ILPI_AGENDADOR_PASSWORD;
  process.env.AGENDADOR_DATABASE_URL = destinoApp.toString();

  // Chave fixa, só para testes: o valor nunca é usado fora desta suíte.
  process.env.CHAVE_CAMPOS ??= Buffer.alloc(32, 9).toString("base64");

  const executar = (script: string) =>
    execFileSync(process.execPath, [path.join(raiz, "scripts", script)], {
      env: process.env,
      stdio: "inherit",
    });

  if (process.env.ADMIN_DATABASE_URL) {
    await recriarBancoDeTeste(process.env.ADMIN_DATABASE_URL);
    executar("db-setup.mjs");
  }
  executar("migrar.mjs");
}
