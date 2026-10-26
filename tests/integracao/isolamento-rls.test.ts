import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { CASA_A, CASA_B, USUARIO_A, criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";

// Prova, contra um PostgreSQL real, que o isolamento entre casas é feito pelo banco.
// A tabela abaixo usa exatamente o padrão de política que toda tabela de negócio vai seguir.

describe("isolamento entre casas (RLS)", () => {
  let app: pg.Pool;
  let migrador: pg.Pool;

  beforeAll(async () => {
    app = criarPoolApp();
    migrador = criarPoolMigrador();
    await migrador.query("DROP TABLE IF EXISTS teste_rls_isolamento");
    await migrador.query(`
      CREATE TABLE teste_rls_isolamento (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        casa_id uuid NOT NULL,
        valor text NOT NULL
      )
    `);
    await migrador.query("ALTER TABLE teste_rls_isolamento ENABLE ROW LEVEL SECURITY");
    await migrador.query("ALTER TABLE teste_rls_isolamento FORCE ROW LEVEL SECURITY");
    await migrador.query(`
      CREATE POLICY isolamento ON teste_rls_isolamento
        USING (casa_id = app_casa_id())
        WITH CHECK (casa_id = app_casa_id())
    `);
  });

  afterAll(async () => {
    await migrador.query("DROP TABLE IF EXISTS teste_rls_isolamento");
    await app.end();
    await migrador.end();
  });

  beforeEach(async () => {
    await migrador.query("TRUNCATE teste_rls_isolamento");
  });

  async function inserir(casaId: string, valor: string) {
    await comContexto(app, { casaId }, (c) =>
      c.query("INSERT INTO teste_rls_isolamento (casa_id, valor) VALUES ($1, $2)", [casaId, valor]),
    );
  }

  async function valoresVistosPor(casaId: string): Promise<string[]> {
    return comContexto(app, { casaId }, async (c) => {
      const { rows } = await c.query("SELECT valor FROM teste_rls_isolamento ORDER BY valor");
      return rows.map((linha: { valor: string }) => linha.valor);
    });
  }

  it("cada casa enxerga apenas as próprias linhas", async () => {
    await inserir(CASA_A, "a1");
    await inserir(CASA_A, "a2");
    await inserir(CASA_B, "b1");

    expect(await valoresVistosPor(CASA_A)).toEqual(["a1", "a2"]);
    expect(await valoresVistosPor(CASA_B)).toEqual(["b1"]);
  });

  it("sem contexto de casa, nenhuma linha é visível", async () => {
    await inserir(CASA_A, "a1");
    const { rows } = await app.query("SELECT count(*)::int AS total FROM teste_rls_isolamento");
    expect(rows[0].total).toBe(0);
  });

  it("o papel das migrações também fica sujeito à política (FORCE)", async () => {
    await inserir(CASA_A, "a1");
    const { rows } = await migrador.query(
      "SELECT count(*)::int AS total FROM teste_rls_isolamento",
    );
    expect(rows[0].total).toBe(0);
  });

  it("não é possível gravar uma linha em nome de outra casa", async () => {
    await expect(
      comContexto(app, { casaId: CASA_A }, (c) =>
        c.query("INSERT INTO teste_rls_isolamento (casa_id, valor) VALUES ($1, 'intruso')", [
          CASA_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("atualizar linhas de outra casa não afeta nada", async () => {
    await inserir(CASA_B, "b1");
    const resultado = await comContexto(app, { casaId: CASA_A }, (c) =>
      c.query("UPDATE teste_rls_isolamento SET valor = 'adulterado'"),
    );
    expect(resultado.rowCount).toBe(0);
    expect(await valoresVistosPor(CASA_B)).toEqual(["b1"]);
  });

  it("o contexto não vaza para a próxima requisição que reutiliza a conexão", async () => {
    // Pool de uma única conexão: a segunda chamada necessariamente reutiliza a primeira.
    const pool = criarPoolApp(1);
    try {
      await comContexto(pool, { casaId: CASA_A, usuarioId: USUARIO_A }, (c) =>
        c.query("INSERT INTO teste_rls_isolamento (casa_id, valor) VALUES ($1, 'a1')", [CASA_A]),
      );

      const { rows } = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM teste_rls_isolamento) AS visiveis,
          NULLIF(current_setting('app.casa_id', true), '') AS casa,
          NULLIF(current_setting('app.usuario_id', true), '') AS usuario
      `);
      expect(rows[0]).toEqual({ visiveis: 0, casa: null, usuario: null });
    } finally {
      await pool.end();
    }
  });

  it("uma falha dentro da transação desfaz tudo e deixa a conexão limpa", async () => {
    const pool = criarPoolApp(1);
    try {
      await expect(
        comContexto(pool, { casaId: CASA_A }, async (c) => {
          await c.query("INSERT INTO teste_rls_isolamento (casa_id, valor) VALUES ($1, 'a1')", [
            CASA_A,
          ]);
          throw new Error("falha simulada");
        }),
      ).rejects.toThrow("falha simulada");

      expect(await valoresVistosPor(CASA_A)).toEqual([]);

      const { rows } = await pool.query(
        "SELECT NULLIF(current_setting('app.casa_id', true), '') AS casa",
      );
      expect(rows[0].casa).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("recusa identificadores que não sejam UUID antes de tocar no banco", async () => {
    await expect(comContexto(app, { casaId: "1' OR '1'='1" }, async () => 1)).rejects.toThrow(
      /casaId deve ser um UUID/,
    );
    await expect(
      comContexto(app, { casaId: CASA_A, usuarioId: "nao-e-uuid" }, async () => 1),
    ).rejects.toThrow(/usuarioId deve ser um UUID/);
  });

  it("um valor de casa inválido no banco falha fechado, sem liberar linhas", async () => {
    const cliente = await app.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("SELECT set_config('app.casa_id', 'lixo', true)");
      await expect(cliente.query("SELECT * FROM teste_rls_isolamento")).rejects.toThrow(
        /invalid input syntax for type uuid/i,
      );
    } finally {
      await cliente.query("ROLLBACK");
      cliente.release();
    }
  });
});
