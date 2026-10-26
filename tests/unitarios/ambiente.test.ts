import { describe, expect, it } from "vitest";
import { ErroDeAmbiente, lerAmbiente } from "@/compartilhado/ambiente";

const CHAVE = Buffer.alloc(32, 7).toString("base64");
const base = {
  DATABASE_URL: "postgres://ilpi_app:senha@localhost:5432/ilpi_dev",
  CHAVE_CAMPOS: CHAVE,
};

describe("validação do ambiente", () => {
  it("aceita uma configuração válida e aplica os padrões", () => {
    expect(lerAmbiente(base)).toEqual({
      NODE_ENV: "development",
      DATABASE_URL: base.DATABASE_URL,
      LOG_NIVEL: "info",
      CHAVE_CAMPOS: CHAVE,
    });
  });

  it("falha apontando a variável ausente", () => {
    expect(() => lerAmbiente({})).toThrow(ErroDeAmbiente);
    expect(() => lerAmbiente({})).toThrow(/DATABASE_URL/);
  });

  it("rejeita NODE_ENV e LOG_NIVEL desconhecidos", () => {
    expect(() => lerAmbiente({ ...base, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
    expect(() => lerAmbiente({ ...base, LOG_NIVEL: "verboso" })).toThrow(/LOG_NIVEL/);
  });

  it("rejeita uma URL que não seja de PostgreSQL", () => {
    expect(() => lerAmbiente({ ...base, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("exige a chave de campos com 32 bytes e não revela o valor informado", () => {
    expect(() => lerAmbiente({ DATABASE_URL: base.DATABASE_URL })).toThrow(/CHAVE_CAMPOS/);
    const curta = Buffer.alloc(8, 1).toString("base64");
    try {
      lerAmbiente({ ...base, CHAVE_CAMPOS: curta });
      expect.unreachable("deveria ter falhado");
    } catch (erro) {
      expect((erro as Error).message).toMatch(/CHAVE_CAMPOS/);
      expect((erro as Error).message).not.toContain(curta);
    }
  });

  it("em produção, recusa conectar como superusuário", () => {
    const producao = {
      ...base,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://postgres:senha@db:5432/ilpi",
    };
    expect(() => lerAmbiente(producao)).toThrow(/papel da aplicação/);
    expect(() =>
      lerAmbiente({ ...producao, DATABASE_URL: "postgres://ilpi_app:senha@db:5432/ilpi" }),
    ).not.toThrow();
  });

  it("nunca inclui o valor das variáveis na mensagem de erro", () => {
    const segredo = "SENHA-SUPER-SECRETA-123";
    try {
      lerAmbiente({ DATABASE_URL: `mysql://usuario:${segredo}@host/db` });
      expect.unreachable("deveria ter falhado");
    } catch (erro) {
      expect((erro as Error).message).not.toContain(segredo);
    }
  });
});
