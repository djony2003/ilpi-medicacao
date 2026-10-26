import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tabelasSemRls } from "@/compartilhado/banco/verificar-rls";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";

describe("RLS em todas as tabelas do schema public", () => {
  let app: pg.Pool;
  let migrador: pg.Pool;

  beforeAll(() => {
    app = criarPoolApp();
    migrador = criarPoolMigrador(1);
  });
  afterAll(async () => {
    await app.end();
    await migrador.end();
  });

  it("nenhuma tabela do schema atual está sem RLS habilitado e forçado", async () => {
    // Este é o portão de qualidade: toda migração futura que criar uma tabela sem RLS
    // faz este teste falhar, e a CI bloqueia a alteração.
    expect(await tabelasSemRls(app)).toEqual([]);
  });

  it("detecta uma tabela sem RLS, uma só com ENABLE e aprova uma com ENABLE e FORCE", async () => {
    // DDL é transacional no PostgreSQL: tudo é desfeito no ROLLBACK, sem sobrar tabela de teste.
    const cliente = await migrador.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("CREATE TABLE teste_sem_rls (id int)");
      expect(await tabelasSemRls(cliente)).toEqual(["teste_sem_rls"]);

      await cliente.query("ALTER TABLE teste_sem_rls ENABLE ROW LEVEL SECURITY");
      expect(await tabelasSemRls(cliente)).toEqual(["teste_sem_rls"]);

      await cliente.query("ALTER TABLE teste_sem_rls FORCE ROW LEVEL SECURITY");
      expect(await tabelasSemRls(cliente)).toEqual([]);
    } finally {
      await cliente.query("ROLLBACK");
      cliente.release();
    }
  });
});
