import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { registrarAuditoria, verificarCadeiaDeAuditoria } from "@/modules/auditoria";
import { TEM_ADMIN, abrirAdmin, criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario, type UsuarioDeTeste } from "../ajudantes/dados";

describe("trilha de auditoria", () => {
  let app: pg.Pool;
  let migrador: pg.Pool;
  let casaA: string;
  let casaB: string;
  let usuarioA: UsuarioDeTeste;
  let usuarioB: UsuarioDeTeste;

  beforeAll(async () => {
    app = criarPoolApp(8);
    migrador = criarPoolMigrador();
    casaA = await criarCasa(migrador, "Casa A");
    casaB = await criarCasa(migrador, "Casa B");
    usuarioA = await criarUsuario(migrador, casaA, { perfil: "enfermeiro" });
    usuarioB = await criarUsuario(migrador, casaB, { perfil: "enfermeiro" });
  });
  afterAll(async () => {
    await app.end();
    await migrador.end();
  });

  const registrar = (casaId: string, usuarioId: string, acao: string, extra = {}) =>
    comContexto(app, { casaId, usuarioId }, (c) =>
      registrarAuditoria(c, { acao, entidade: "teste", ...extra }),
    );

  const ler = (casaId: string, usuarioId: string) =>
    comContexto(app, { casaId, usuarioId }, (c) =>
      c
        .query(
          "SELECT seq, usuario_id, acao, hash_anterior, hash, depois FROM auditoria ORDER BY seq",
        )
        .then((r) => r.rows),
    );

  describe("registro e encadeamento", () => {
    it("grava casa e usuário do contexto e encadeia cada linha na anterior", async () => {
      const casa = await criarCasa(migrador);
      const usuario = await criarUsuario(migrador, casa, { perfil: "gestor" });
      await registrar(casa, usuario.id, "teste.um");
      await registrar(casa, usuario.id, "teste.dois", { depois: { valor: 2 } });
      await registrar(casa, usuario.id, "teste.tres");

      const linhas = await ler(casa, usuario.id);
      expect(linhas.map((l) => l.seq)).toEqual(["1", "2", "3"]);
      expect(linhas.map((l) => l.acao)).toEqual(["teste.um", "teste.dois", "teste.tres"]);
      expect(linhas.every((l) => l.usuario_id === usuario.id)).toBe(true);
      expect(linhas[0].hash_anterior).toBeNull();
      expect(linhas[1].hash_anterior).toBe(linhas[0].hash);
      expect(linhas[2].hash_anterior).toBe(linhas[1].hash);
      expect(linhas.every((l) => /^[0-9a-f]{64}$/.test(l.hash))).toBe(true);
      expect(new Set(linhas.map((l) => l.hash)).size).toBe(3);
      expect(linhas[1].depois).toEqual({ valor: 2 });
    });

    it("cada casa tem a própria cadeia, começando em 1", async () => {
      await registrar(casaA, usuarioA.id, "teste.a");
      await registrar(casaB, usuarioB.id, "teste.b");
      const daA = await ler(casaA, usuarioA.id);
      const daB = await ler(casaB, usuarioB.id);
      expect(daA[0].seq).toBe("1");
      expect(daB[0].seq).toBe("1");
      expect(daA.every((l) => l.acao !== "teste.b")).toBe(true);
      expect(daB.every((l) => l.acao !== "teste.a")).toBe(true);
    });

    it("quem insere não escolhe a própria posição nem o hash", async () => {
      const casa = await criarCasa(migrador);
      const usuario = await criarUsuario(migrador, casa, { perfil: "gestor" });
      await comContexto(app, { casaId: casa, usuarioId: usuario.id }, (c) =>
        c.query(
          `INSERT INTO auditoria (casa_id, seq, acao, entidade, ocorrido_em, hash)
           VALUES ($1, 999, 'teste.forjado', 'x', '2000-01-01', 'forjado')`,
          [casa],
        ),
      );
      const [linha] = await ler(casa, usuario.id);
      expect(linha.seq).toBe("1");
      expect(linha.hash).not.toBe("forjado");
    });

    it("escritas simultâneas da mesma casa formam uma cadeia sem buracos nem repetições", async () => {
      const casa = await criarCasa(migrador);
      const usuario = await criarUsuario(migrador, casa, { perfil: "gestor" });
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          registrar(casa, usuario.id, "teste.paralelo", { depois: { i } }),
        ),
      );
      const linhas = await ler(casa, usuario.id);
      expect(linhas.map((l) => Number(l.seq))).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      for (let i = 1; i < linhas.length; i += 1) {
        expect(linhas[i].hash_anterior).toBe(linhas[i - 1].hash);
      }
      const problema = await comContexto(app, { casaId: casa }, (c) =>
        verificarCadeiaDeAuditoria(c),
      );
      expect(problema).toBeNull();
    });

    it("se a transação do chamador desfaz, o registro de auditoria também desfaz", async () => {
      const casa = await criarCasa(migrador);
      const usuario = await criarUsuario(migrador, casa, { perfil: "gestor" });
      await expect(
        comContexto(app, { casaId: casa, usuarioId: usuario.id }, async (c) => {
          await registrarAuditoria(c, { acao: "teste.desfeito", entidade: "x" });
          throw new Error("falha depois de auditar");
        }),
      ).rejects.toThrow("falha depois de auditar");
      expect(await ler(casa, usuario.id)).toEqual([]);
    });
  });

  describe("recusas", () => {
    it("exige contexto de casa", async () => {
      const cliente = await app.connect();
      try {
        await expect(
          registrarAuditoria(cliente, { acao: "teste.sem_contexto", entidade: "x" }),
        ).rejects.toThrow(/row-level security|null value|casa_id/i);
      } finally {
        cliente.release();
      }
    });

    it("não grava na cadeia de outra casa", async () => {
      await expect(
        comContexto(app, { casaId: casaA, usuarioId: usuarioA.id }, (c) =>
          c.query(
            "INSERT INTO auditoria (casa_id, acao, entidade, ocorrido_em, hash) VALUES ($1, 'teste.intruso', 'x', now(), 'h')",
            [casaB],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("recusa ação fora do formato e segredos em antes/depois", async () => {
      await expect(registrar(casaA, usuarioA.id, "SemPonto")).rejects.toThrow(
        /Ação de auditoria inválida/,
      );
      await expect(
        registrar(casaA, usuarioA.id, "teste.segredo", { depois: { senha_hash: "$argon2id$..." } }),
      ).rejects.toThrow(/segredo/);
      await expect(
        registrar(casaA, usuarioA.id, "teste.segredo", { antes: { dados: { pinHash: "x" } } }),
      ).rejects.toThrow(/dados\.pinHash/);
    });

    it("aceita estados booleanos de campos sensíveis (ex.: pin_trocar)", async () => {
      await expect(
        registrar(casaA, usuarioA.id, "teste.estado", {
          depois: { pin_trocar: true, totp_ativo: false },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("imutabilidade", () => {
    it("a aplicação não consegue alterar nem apagar", async () => {
      await registrar(casaA, usuarioA.id, "teste.imutavel");
      await expect(
        comContexto(app, { casaId: casaA }, (c) =>
          c.query("UPDATE auditoria SET acao = 'teste.adulterado'"),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        comContexto(app, { casaId: casaA }, (c) => c.query("DELETE FROM auditoria")),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        comContexto(app, { casaId: casaA }, (c) => c.query("TRUNCATE auditoria")),
      ).rejects.toThrow(/permission denied/i);
    });

    it("nem o dono do schema altera ou apaga linhas (RLS) nem esvazia a tabela (gatilho)", async () => {
      const antes = await ler(casaA, usuarioA.id);
      await comContexto(migrador, { casaId: casaA }, async (c) => {
        // Sem política de UPDATE ou DELETE, o dono não enxerga linhas para alterar: 0 afetadas.
        expect((await c.query("UPDATE auditoria SET acao = 'teste.adulterado'")).rowCount).toBe(0);
        expect((await c.query("DELETE FROM auditoria")).rowCount).toBe(0);
      });
      await expect(
        comContexto(migrador, { casaId: casaA }, (c) => c.query("TRUNCATE auditoria")),
      ).rejects.toThrow(/imutável/);
      expect(await ler(casaA, usuarioA.id)).toEqual(antes);
    });

    it.skipIf(!TEM_ADMIN)(
      "até quem ignora o RLS (superusuário) é barrado pelos gatilhos",
      async () => {
        const admin = await abrirAdmin();
        if (!admin) return;
        try {
          await expect(
            admin.query("UPDATE auditoria SET acao = 'teste.adulterado'"),
          ).rejects.toThrow(/imutável/);
          await expect(admin.query("DELETE FROM auditoria")).rejects.toThrow(/imutável/);
          await expect(admin.query("TRUNCATE auditoria")).rejects.toThrow(/imutável/);
        } finally {
          await admin.end();
        }
      },
    );
  });

  describe.skipIf(!TEM_ADMIN)("detecção de adulteração (simulada com superusuário)", () => {
    // Para simular um ataque direto ao banco, o superusuário desliga os gatilhos de
    // imutabilidade, altera os dados e liga de novo. A cadeia precisa acusar o estrago.

    async function adulterar(sql: string, parametros: unknown[] = []) {
      const admin = await abrirAdmin();
      if (!admin) throw new Error("sem admin");
      try {
        await admin.query("ALTER TABLE auditoria DISABLE TRIGGER USER");
        try {
          await admin.query(sql, parametros);
        } finally {
          await admin.query("ALTER TABLE auditoria ENABLE TRIGGER USER");
        }
      } finally {
        await admin.end();
      }
    }

    async function novaCadeia(tamanho: number) {
      const casa = await criarCasa(migrador);
      const usuario = await criarUsuario(migrador, casa, { perfil: "gestor" });
      for (let i = 1; i <= tamanho; i += 1) {
        await registrar(casa, usuario.id, "teste.cadeia", { depois: { i } });
      }
      return casa;
    }

    const verificar = (casa: string) =>
      comContexto(app, { casaId: casa }, (c) => verificarCadeiaDeAuditoria(c));

    it("uma cadeia íntegra não tem problemas", async () => {
      expect(await verificar(await novaCadeia(5))).toBeNull();
    });

    it("alterar o conteúdo de uma linha é detectado nela", async () => {
      const casa = await novaCadeia(5);
      await adulterar(
        "UPDATE auditoria SET depois = '{\"i\": 999}'::jsonb WHERE casa_id = $1 AND seq = 3",
        [casa],
      );
      expect(await verificar(casa)).toEqual({ seq: 3, problema: "conteudo_adulterado" });
    });

    it("apagar uma linha do meio é detectado como lacuna", async () => {
      const casa = await novaCadeia(5);
      await adulterar("DELETE FROM auditoria WHERE casa_id = $1 AND seq = 3", [casa]);
      expect(await verificar(casa)).toEqual({ seq: 4, problema: "lacuna" });
    });

    it("apagar a primeira linha é detectado", async () => {
      const casa = await novaCadeia(4);
      await adulterar("DELETE FROM auditoria WHERE casa_id = $1 AND seq = 1", [casa]);
      expect(await verificar(casa)).toEqual({ seq: 2, problema: "inicio_ausente" });
    });

    it("reescrever a linha e o próprio hash sem refazer a cadeia seguinte é detectado", async () => {
      const casa = await novaCadeia(4);
      // Quem conhece o algoritmo refaz o hash da linha 2 para ela ficar coerente consigo mesma.
      await adulterar(
        `UPDATE auditoria
            SET depois = '{"i": 999}'::jsonb,
                hash = auditoria_calcular_hash(hash_anterior, casa_id, seq, usuario_id, acao,
                         entidade, entidade_id, antes, '{"i": 999}'::jsonb, dispositivo_id, ip,
                         ocorrido_em)
          WHERE casa_id = $1 AND seq = 2`,
        [casa],
      );
      // A linha 2 está coerente, mas a linha 3 ainda aponta para o hash antigo da linha 2.
      expect(await verificar(casa)).toEqual({ seq: 3, problema: "encadeamento_quebrado" });
    });
  });
});
