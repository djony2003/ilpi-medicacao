import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Prepara o banco de teste antes da suíte. Os testes sempre usam o banco "ilpi_test",
// nunca o banco de desenvolvimento, porque criam e removem tabelas temporárias.

const NOME_BANCO_TESTE = "ilpi_test";

function trocarBanco(url: string, banco: string): string {
  const destino = new URL(url);
  destino.pathname = `/${banco}`;
  return destino.toString();
}

export default function setup() {
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

  const executar = (script: string) =>
    execFileSync(process.execPath, [path.join(raiz, "scripts", script)], {
      env: process.env,
      stdio: "inherit",
    });

  if (process.env.ADMIN_DATABASE_URL) executar("db-setup.mjs");
  executar("migrar.mjs");
}
