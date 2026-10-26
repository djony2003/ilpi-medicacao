import { describe, expect, it } from "vitest";
import { ErroDeAmbiente, lerAmbiente } from "@/compartilhado/ambiente";

const base = { DATABASE_URL: "postgres://ilpi_app:senha@localhost:5432/ilpi_dev" };

describe("validação do ambiente", () => {
  it("aceita uma configuração válida e aplica os padrões", () => {
    expect(lerAmbiente(base)).toEqual({
      NODE_ENV: "development",
      DATABASE_URL: base.DATABASE_URL,
      LOG_NIVEL: "info",
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
    expect(() => lerAmbiente({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("em produção, recusa conectar como superusuário", () => {
    const producao = {
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
