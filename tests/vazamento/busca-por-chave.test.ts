import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comBusca } from "@/compartilhado/banco/busca";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarToken, hashDeToken } from "@/compartilhado/tokens";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario, type UsuarioDeTeste } from "../ajudantes/dados";

// Mecanismo do ADR-002: a busca por chave secreta só revela a linha de quem conhece a chave,
// nunca outra casa, e nunca permite escrita.

describe("busca por chave secreta sob RLS (ADR-002)", () => {
  let app: pg.Pool;
  let migrador: pg.Pool;
  let casaA: string;
  let casaB: string;
  let usuarioA: UsuarioDeTeste;
  let usuarioB: UsuarioDeTeste;
  const tokenSessaoA = gerarToken();
  const tokenSessaoB = gerarToken();
  const tokenDispositivoA = gerarToken();
  const codigoAtivacaoB = "ATIVACAOBB";

  beforeAll(async () => {
    app = criarPoolApp();
    migrador = criarPoolMigrador();
    casaA = await criarCasa(migrador, "Casa A");
    casaB = await criarCasa(migrador, "Casa B");
    usuarioA = await criarUsuario(migrador, casaA, { perfil: "gestor" });
    usuarioB = await criarUsuario(migrador, casaB, { perfil: "gestor" });

    const dispositivoA = randomUUID();
    await comContexto(migrador, { casaId: casaA }, async (c) => {
      await c.query(
        "INSERT INTO dispositivo (id, casa_id, nome, token_hash, ativado_em) VALUES ($1, $2, 'Tablet A', $3, now())",
        [dispositivoA, casaA, hashDeToken(tokenDispositivoA)],
      );
      await c.query(
        `INSERT INTO sessao (casa_id, usuario_id, tipo, token_hash, expira_em, inatividade_segundos)
         VALUES ($1, $2, 'web', $3, now() + interval '1 hour', 1800)`,
        [casaA, usuarioA.id, hashDeToken(tokenSessaoA)],
      );
    });
    await comContexto(migrador, { casaId: casaB }, async (c) => {
      await c.query(
        "INSERT INTO dispositivo (casa_id, nome, codigo_ativacao_hash, codigo_expira_em) VALUES ($1, 'Tablet B', $2, now() + interval '1 day')",
        [casaB, hashDeToken(codigoAtivacaoB)],
      );
      await c.query(
        `INSERT INTO sessao (casa_id, usuario_id, tipo, token_hash, expira_em, inatividade_segundos)
         VALUES ($1, $2, 'web', $3, now() + interval '1 hour', 1800)`,
        [casaB, usuarioB.id, hashDeToken(tokenSessaoB)],
      );
    });
  });

  afterAll(async () => {
    await app.end();
    await migrador.end();
  });

  const contar = (c: pg.PoolClient, tabela: string) =>
    c.query(`SELECT count(*)::int AS n FROM ${tabela}`).then((r) => r.rows[0].n as number);

  it("sem contexto e sem chave, nenhuma das tabelas de identidade revela linhas", async () => {
    for (const tabela of ["casa", "usuario", "dispositivo", "sessao"]) {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      expect(rows[0].n, tabela).toBe(0);
    }
  });

  it("a busca por e-mail devolve só o usuário daquele e-mail", async () => {
    const achado = await comBusca(app, "login_email", usuarioA.email ?? "", async (c) => {
      const { rows } = await c.query("SELECT id, casa_id FROM usuario");
      return rows;
    });
    expect(achado).toEqual([{ id: usuarioA.id, casa_id: casaA }]);
  });

  it("a chave de uma casa não revela nada de outra: cada tabela devolve no máximo uma linha", async () => {
    await comBusca(app, "login_email", usuarioA.email ?? "", async (c) => {
      expect(await contar(c, "usuario")).toBe(1);
      // A chave de e-mail não abre as outras tabelas.
      expect(await contar(c, "sessao")).toBe(0);
      expect(await contar(c, "dispositivo")).toBe(0);
      expect(await contar(c, "casa")).toBe(0);
    });
  });

  it("e-mail desconhecido ou de outra casa não encontra o usuário errado", async () => {
    const nenhum = await comBusca(app, "login_email", "ninguem@exemplo.test", (c) =>
      c.query("SELECT id FROM usuario").then((r) => r.rows),
    );
    expect(nenhum).toEqual([]);
  });

  it("a busca por sessão acha só a sessão do token informado", async () => {
    const linhas = await comBusca(app, "sessao_hash", hashDeToken(tokenSessaoB), (c) =>
      c.query("SELECT casa_id, usuario_id FROM sessao").then((r) => r.rows),
    );
    expect(linhas).toEqual([{ casa_id: casaB, usuario_id: usuarioB.id }]);
  });

  it("um token de sessão adulterado não encontra nada", async () => {
    const linhas = await comBusca(app, "sessao_hash", hashDeToken(`${tokenSessaoA}x`), (c) =>
      c.query("SELECT id FROM sessao").then((r) => r.rows),
    );
    expect(linhas).toEqual([]);
  });

  it("a busca de dispositivo funciona por token do aparelho e por código de ativação", async () => {
    const porToken = await comBusca(app, "dispositivo_hash", hashDeToken(tokenDispositivoA), (c) =>
      c.query("SELECT casa_id FROM dispositivo").then((r) => r.rows),
    );
    expect(porToken).toEqual([{ casa_id: casaA }]);

    const porCodigo = await comBusca(app, "ativacao_hash", hashDeToken(codigoAtivacaoB), (c) =>
      c.query("SELECT casa_id FROM dispositivo").then((r) => r.rows),
    );
    expect(porCodigo).toEqual([{ casa_id: casaB }]);
  });

  it("o token do aparelho não serve como código de ativação, e vice-versa", async () => {
    const cruzado1 = await comBusca(app, "ativacao_hash", hashDeToken(tokenDispositivoA), (c) =>
      c.query("SELECT id FROM dispositivo").then((r) => r.rows),
    );
    const cruzado2 = await comBusca(app, "dispositivo_hash", hashDeToken(codigoAtivacaoB), (c) =>
      c.query("SELECT id FROM dispositivo").then((r) => r.rows),
    );
    expect(cruzado1).toEqual([]);
    expect(cruzado2).toEqual([]);
  });

  it("a transação de busca é somente leitura: o banco recusa escrita", async () => {
    await expect(
      comBusca(app, "login_email", usuarioA.email ?? "", (c) =>
        c.query("UPDATE usuario SET nome = 'adulterado'"),
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it("chave vazia é recusada, e uma variável vazia definida à mão não libera linhas", async () => {
    await expect(comBusca(app, "login_email", "", async () => 1)).rejects.toThrow(/vazia/);

    const cliente = await app.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("SELECT set_config('app.login_email', '', true)");
      expect(await contar(cliente, "usuario")).toBe(0);
    } finally {
      await cliente.query("ROLLBACK");
      cliente.release();
    }
  });

  it("a chave não vaza para a próxima requisição que reutiliza a conexão", async () => {
    const pool = criarPoolApp(1);
    try {
      await comBusca(pool, "login_email", usuarioA.email ?? "", async () => 1);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM usuario");
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("o contexto normal de uma casa continua isolado das linhas de outra", async () => {
    const vistos = await comContexto(app, { casaId: casaA }, (c) =>
      c.query("SELECT id FROM usuario").then((r) => r.rows.map((l: { id: string }) => l.id)),
    );
    expect(vistos).toEqual([usuarioA.id]);
  });
});

describe("restrições do esquema de identidade", () => {
  let app: pg.Pool;
  let migrador: pg.Pool;
  let casa: string;

  beforeAll(async () => {
    app = criarPoolApp();
    migrador = criarPoolMigrador();
    casa = await criarCasa(migrador);
  });
  afterAll(async () => {
    await app.end();
    await migrador.end();
  });

  const inserir = (campos: { email?: string | null; perfil: string }) =>
    comContexto(migrador, { casaId: casa }, (c) =>
      c.query("INSERT INTO usuario (casa_id, nome, email, perfil) VALUES ($1, 'x', $2, $3)", [
        casa,
        campos.email ?? null,
        campos.perfil,
      ]),
    );

  it("gestor e enfermeiro exigem e-mail; cuidador não", async () => {
    await expect(inserir({ perfil: "gestor" })).rejects.toThrow(/usuario_email_obrigatorio/);
    await expect(inserir({ perfil: "enfermeiro" })).rejects.toThrow(/usuario_email_obrigatorio/);
    await expect(inserir({ perfil: "cuidador" })).resolves.toBeDefined();
  });

  it("o e-mail precisa estar em minúsculas e ser único no sistema", async () => {
    await expect(inserir({ perfil: "gestor", email: "Maiuscula@Exemplo.Test" })).rejects.toThrow(
      /usuario_email_minusculo/,
    );
    const email = `unico-${randomUUID()}@exemplo.test`;
    await inserir({ perfil: "gestor", email });
    await expect(inserir({ perfil: "enfermeiro", email })).rejects.toThrow(/usuario_email_unico/);
  });

  it("uma sessão de tablet exige dispositivo", async () => {
    const usuario = await criarUsuario(migrador, casa, { perfil: "cuidador", senha: null });
    await expect(
      comContexto(migrador, { casaId: casa }, (c) =>
        c.query(
          `INSERT INTO sessao (casa_id, usuario_id, tipo, token_hash, expira_em, inatividade_segundos)
           VALUES ($1, $2, 'tablet', 'h', now() + interval '1 hour', 120)`,
          [casa, usuario.id],
        ),
      ),
    ).rejects.toThrow(/sessao_tablet_tem_dispositivo/);
  });

  it("a aplicação não consegue apagar usuários, sessões nem dispositivos", async () => {
    for (const tabela of ["usuario", "sessao", "dispositivo", "casa"]) {
      await expect(
        comContexto(app, { casaId: casa }, (c) => c.query(`DELETE FROM ${tabela}`)),
        tabela,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
