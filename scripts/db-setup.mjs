// Prepara o banco: cria os papéis e o banco de dados, de forma idempotente.
//
// Papéis:
//   ilpi_migrador  dono dos objetos; roda as migrações.
//   ilpi_app       usado pela aplicação; sem superusuário, sem BYPASSRLS, sem criar objetos.
//
// Variáveis: ADMIN_DATABASE_URL (superusuário), MIGRATOR_DATABASE_URL (define o nome do banco),
// ILPI_APP_PASSWORD, ILPI_MIGRADOR_PASSWORD.

import pg from "pg";

const PAPEL_APP = "ilpi_app";
const PAPEL_MIGRADOR = "ilpi_migrador";

function exigir(nome) {
  const valor = process.env[nome];
  if (!valor) {
    console.error(`Variável ${nome} não definida. Veja .env.example.`);
    process.exit(1);
  }
  return valor;
}

const adminUrl = exigir("ADMIN_DATABASE_URL");
const migradorUrl = exigir("MIGRATOR_DATABASE_URL");
const senhaApp = exigir("ILPI_APP_PASSWORD");
const senhaMigrador = exigir("ILPI_MIGRADOR_PASSWORD");

const nomeBanco = decodeURIComponent(new URL(migradorUrl).pathname.slice(1));
if (!/^[a-z][a-z0-9_]*$/.test(nomeBanco)) {
  console.error(`Nome de banco inválido: "${nomeBanco}". Use letras minúsculas, números e _.`);
  process.exit(1);
}

async function garantirPapel(cliente, nome, senha) {
  const existe = await cliente.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [nome]);
  const comando = existe.rowCount === 0 ? "CREATE ROLE" : "ALTER ROLE";
  await cliente.query(
    `${comando} ${cliente.escapeIdentifier(nome)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ` +
      `NOREPLICATION NOBYPASSRLS PASSWORD ${cliente.escapeLiteral(senha)}`,
  );
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await garantirPapel(admin, PAPEL_MIGRADOR, senhaMigrador);
  await garantirPapel(admin, PAPEL_APP, senhaApp);

  const banco = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [nomeBanco]);
  if (banco.rowCount === 0) {
    await admin.query(
      `CREATE DATABASE ${admin.escapeIdentifier(nomeBanco)} OWNER ${PAPEL_MIGRADOR} ENCODING 'UTF8'`,
    );
  }
  const bancoId = admin.escapeIdentifier(nomeBanco);
  await admin.query(`REVOKE ALL ON DATABASE ${bancoId} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${bancoId} TO ${PAPEL_APP}, ${PAPEL_MIGRADOR}`);
} finally {
  await admin.end();
}

// Ajustes dentro do banco de destino.
const urlBanco = new URL(adminUrl);
urlBanco.pathname = `/${nomeBanco}`;
const noBanco = new pg.Client({ connectionString: urlBanco.toString() });
await noBanco.connect();
try {
  await noBanco.query(`ALTER SCHEMA public OWNER TO ${PAPEL_MIGRADOR}`);
  await noBanco.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await noBanco.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL_APP}`);
} finally {
  await noBanco.end();
}

console.log(`Banco "${nomeBanco}" pronto (papéis ${PAPEL_MIGRADOR} e ${PAPEL_APP}).`);
