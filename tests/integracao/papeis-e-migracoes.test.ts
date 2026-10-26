import { execFileSync } from "node:child_process";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";

const raiz = path.resolve(import.meta.dirname, "../..");

describe("papéis do banco", () => {
  let app: pg.Pool;
  let migrador: pg.Pool;

  beforeAll(() => {
    app = criarPoolApp();
    migrador = criarPoolMigrador();
  });
  afterAll(async () => {
    await app.end();
    await migrador.end();
  });

  const atributos = `
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    FROM pg_roles WHERE rolname = current_user
  `;

  it("o papel da aplicação não é superusuário, não ignora RLS e não cria banco nem papéis", async () => {
    const { rows } = await app.query(atributos);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it("o papel das migrações também não é superusuário nem ignora RLS", async () => {
    const { rows } = await migrador.query(atributos);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it("a aplicação não consegue criar tabelas no schema public", async () => {
    await expect(app.query("CREATE TABLE teste_proibido (id int)")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("a aplicação não enxerga o controle de migrações", async () => {
    await expect(app.query("SELECT * FROM controle.migracoes")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("tabelas novas dão à aplicação leitura, inserção e atualização, mas não exclusão", async () => {
    await migrador.query("DROP TABLE IF EXISTS teste_privilegios");
    await migrador.query("CREATE TABLE teste_privilegios (id int)");
    try {
      const { rows } = await app.query(`
        SELECT
          has_table_privilege(current_user, 'teste_privilegios', 'SELECT') AS ler,
          has_table_privilege(current_user, 'teste_privilegios', 'INSERT') AS inserir,
          has_table_privilege(current_user, 'teste_privilegios', 'UPDATE') AS atualizar,
          has_table_privilege(current_user, 'teste_privilegios', 'DELETE') AS excluir,
          has_table_privilege(current_user, 'teste_privilegios', 'TRUNCATE') AS truncar
      `);
      expect(rows[0]).toEqual({
        ler: true,
        inserir: true,
        atualizar: true,
        excluir: false,
        truncar: false,
      });
    } finally {
      await migrador.query("DROP TABLE IF EXISTS teste_privilegios");
    }
  });
});

describe("runner de migrações", () => {
  it("rodar de novo é seguro e não reaplica nada", () => {
    const saida = execFileSync(process.execPath, [path.join(raiz, "scripts", "migrar.mjs")], {
      env: process.env,
      encoding: "utf8",
    });
    expect(saida).toContain("Banco já está atualizado.");
  });
});
