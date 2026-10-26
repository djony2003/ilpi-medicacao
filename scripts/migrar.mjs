// Aplica as migrações SQL de db/migracoes, em ordem, cada uma em uma transação.
// O controle fica no schema "controle", que a aplicação não enxerga.
//
// Uma migração já aplicada nunca pode ser alterada: o checksum é conferido.
// Variável: MIGRATOR_DATABASE_URL.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error("Variável MIGRATOR_DATABASE_URL não definida. Veja .env.example.");
  process.exit(1);
}

const pasta = path.resolve(import.meta.dirname, "../db/migracoes");
const arquivos = fs
  .readdirSync(pasta)
  .filter((nome) => /^\d{4}_[a-z0-9_]+\.sql$/.test(nome))
  .sort();

const ID_BLOQUEIO = 7_310_001; // evita duas execuções simultâneas de migração

const cliente = new pg.Client({ connectionString: url });
await cliente.connect();
try {
  await cliente.query("SELECT pg_advisory_lock($1)", [ID_BLOQUEIO]);
  await cliente.query("CREATE SCHEMA IF NOT EXISTS controle");
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS controle.migracoes (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )
  `);

  const aplicadas = new Map(
    (await cliente.query("SELECT id, checksum FROM controle.migracoes")).rows.map((l) => [
      l.id,
      l.checksum,
    ]),
  );

  let novas = 0;
  for (const arquivo of arquivos) {
    const sql = fs.readFileSync(path.join(pasta, arquivo), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const anterior = aplicadas.get(arquivo);
    if (anterior) {
      if (anterior !== checksum) {
        throw new Error(
          `A migração ${arquivo} já foi aplicada e foi alterada. Crie uma nova migração.`,
        );
      }
      continue;
    }
    await cliente.query("BEGIN");
    try {
      await cliente.query(sql);
      await cliente.query("INSERT INTO controle.migracoes (id, checksum) VALUES ($1, $2)", [
        arquivo,
        checksum,
      ]);
      await cliente.query("COMMIT");
      novas += 1;
      console.log(`Aplicada: ${arquivo}`);
    } catch (erro) {
      await cliente.query("ROLLBACK");
      throw new Error(`Falha em ${arquivo}: ${erro.message}`);
    }
  }
  console.log(novas === 0 ? "Banco já está atualizado." : `${novas} migração(ões) aplicada(s).`);
} finally {
  await cliente.query("SELECT pg_advisory_unlock($1)", [ID_BLOQUEIO]).catch(() => {});
  await cliente.end();
}
