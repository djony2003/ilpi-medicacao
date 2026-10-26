import { describe, expect, it } from "vitest";
import { criarLogger } from "@/compartilhado/log";

function novoLogger(opcoes: {
  modoEstrito?: boolean;
  nivel?: "debug" | "info" | "warn" | "error";
}) {
  const linhas: string[] = [];
  const logger = criarLogger({
    saida: (linha) => linhas.push(linha),
    agora: () => new Date("2026-10-25T21:00:00.000Z"),
    ...opcoes,
  });
  const ultima = () => JSON.parse(linhas.at(-1) ?? "{}") as Record<string, unknown>;
  return { logger, linhas, ultima };
}

describe("logger sem dados de saúde", () => {
  it("registra uma linha JSON com hora, nível, mensagem e identificadores opacos", () => {
    const { logger, ultima } = novoLogger({ modoEstrito: true });
    logger.info("dose registrada", {
      casaId: "11111111-1111-4111-8111-111111111111",
      doseId: "d-1",
    });
    expect(ultima()).toEqual({
      ts: "2026-10-25T21:00:00.000Z",
      nivel: "info",
      msg: "dose registrada",
      casaId: "11111111-1111-4111-8111-111111111111",
      doseId: "d-1",
    });
  });

  it("em modo estrito, lança erro ao receber uma chave proibida", () => {
    const { logger, linhas } = novoLogger({ modoEstrito: true });
    expect(() => logger.info("x", { medicamento: "Losartana" })).toThrow(/chave "medicamento"/);
    expect(linhas).toHaveLength(0);
  });

  it("em produção (modo não estrito), remove o valor e segue registrando", () => {
    const { logger, ultima } = novoLogger({ modoEstrito: false });
    logger.warn("aviso", { medicamento: "Losartana", doseId: "d-1" });
    expect(ultima()).toMatchObject({ medicamento: "[removido]", doseId: "d-1" });
    expect(JSON.stringify(ultima())).not.toContain("Losartana");
  });

  it.each([
    "nome",
    "Nome_Idoso",
    "data-nascimento",
    "dataNascimento",
    "PrincípioAtivo",
    "TELEFONE",
    "senha",
    "pin",
    "alergia",
    "observação",
    "nomeIdoso",
    "nome_paciente",
    "medicamentoEmUso",
    "telefone-contato",
  ])(
    "remove a chave proibida %s apesar de caixa, acento, símbolos e palavras compostas",
    (chave) => {
      const { logger, ultima } = novoLogger({ modoEstrito: false });
      logger.info("x", { [chave]: "segredo-de-teste" });
      expect(ultima()[chave]).toBe("[removido]");
      expect(JSON.stringify(ultima())).not.toContain("segredo-de-teste");
    },
  );

  it.each([
    "casaId",
    "usuarioId",
    "doseId",
    "medicamentoId",
    "idosoId",
    "id",
    "total",
    "duracaoMs",
  ])("permite a chave %s, que é identificador opaco ou métrica", (chave) => {
    const { logger, ultima } = novoLogger({ modoEstrito: true });
    logger.info("x", { [chave]: "valor-opaco" });
    expect(ultima()[chave]).toBe("valor-opaco");
  });

  it("limpa objetos e listas aninhados", () => {
    const { logger, ultima } = novoLogger({ modoEstrito: false });
    logger.info("x", { detalhe: { itens: [{ dose: "5 mg", id: 1 }] } });
    expect(ultima()).toMatchObject({ detalhe: { itens: [{ dose: "[removido]", id: 1 }] } });
  });

  it("mascara e-mail e CPF em valores e na mensagem", () => {
    const { logger, ultima } = novoLogger({ modoEstrito: false });
    logger.info("contato maria@exemplo.com", { origem: "cpf 123.456.789-09 informado" });
    const saida = JSON.stringify(ultima());
    expect(saida).not.toContain("maria@exemplo.com");
    expect(saida).not.toContain("123.456.789-09");
    expect(saida).toContain("[removido]");
  });

  it("em modo estrito, lança erro quando um valor parece e-mail ou CPF", () => {
    const { logger } = novoLogger({ modoEstrito: true });
    expect(() => logger.info("x", { origem: "maria@exemplo.com" })).toThrow(/parece e-mail ou CPF/);
    expect(() => logger.info("contato 123.456.789-09")).toThrow(/mensagem parece conter/);
  });

  it("registra erros só com tipo e mensagem, sem pilha", () => {
    const { logger, ultima } = novoLogger({ modoEstrito: true });
    logger.error("falha", { erro: new TypeError("algo deu errado") });
    expect(ultima().erro).toEqual({ tipo: "TypeError", mensagem: "algo deu errado" });
    expect(JSON.stringify(ultima())).not.toContain("at ");
  });

  it("respeita o nível mínimo", () => {
    const { logger, linhas } = novoLogger({ modoEstrito: true, nivel: "warn" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(linhas.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["c", "d"]);
  });
});
