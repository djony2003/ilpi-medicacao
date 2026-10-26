import { describe, expect, it } from "vitest";
import {
  LIMITES_DE_ESTOQUE_PADRAO,
  LIMITES_DE_VALIDADE_PADRAO,
  arredondarParaCima,
  deMilesimos,
  diasParaVencer,
  emMilesimos,
  loteVencido,
  passoDaUnidade,
  problemaDeMotivo,
  problemaDeQuantidade,
  situacaoDeEstoque,
  situacaoDeValidade,
  somar,
  subtrair,
  validarEntradaDeLote,
  type EntradaDeLote,
} from "@/modules/estoque";

describe("quantidades em milésimos", () => {
  it("somar e subtrair não têm erro de ponto flutuante", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // o problema que a função evita
    expect(somar(0.1, 0.2)).toBe(0.3);
    expect(somar(0.1, 0.2, 0.7)).toBe(1);
    expect(subtrair(1, 0.9)).toBe(0.1);
    expect(subtrair(0.3, 0.1)).toBe(0.2);
    expect(somar()).toBe(0);
    expect(deMilesimos(emMilesimos(12.345))).toBe(12.345);
  });

  it("o passo é um quarto para o que se conta e um milésimo para o que se mede", () => {
    for (const u of ["comprimido", "capsula", "gotas", "aplicacao", "jato", "adesivo"] as const) {
      expect(passoDaUnidade(u), u).toBe(0.25);
    }
    for (const u of ["ml", "mg", "g", "mcg", "ui"] as const) {
      expect(passoDaUnidade(u), u).toBe(0.001);
    }
  });

  it("aceita inteiro, meio e quarto de comprimido, e recusa fração sem sentido", () => {
    expect(problemaDeQuantidade(30, "comprimido")).toBeNull();
    expect(problemaDeQuantidade(0.5, "comprimido")).toBeNull();
    expect(problemaDeQuantidade(0.25, "comprimido")).toBeNull();
    expect(problemaDeQuantidade(12.75, "capsula")).toBeNull();
    expect(problemaDeQuantidade(0.33, "comprimido")).toMatch(/0,25/);
    expect(problemaDeQuantidade(1.1, "comprimido")).toMatch(/0,25/);
    expect(problemaDeQuantidade(100.5, "ml")).toBeNull();
    expect(problemaDeQuantidade(0.001, "ml")).toBeNull();
  });

  it("recusa zero, negativo, infinito, mais de 3 casas e excesso", () => {
    expect(problemaDeQuantidade(0, "comprimido")).toMatch(/zero/);
    expect(problemaDeQuantidade(-1, "comprimido")).toMatch(/negativa/);
    expect(problemaDeQuantidade(Number.NaN, "ml")).toMatch(/números/);
    expect(problemaDeQuantidade(Number.POSITIVE_INFINITY, "ml")).toMatch(/números/);
    expect(problemaDeQuantidade(1.0005, "ml")).toMatch(/3 casas/);
    expect(problemaDeQuantidade(1_000_000, "ml")).toMatch(/999999/);
    expect(problemaDeQuantidade(999_999, "ml")).toBeNull();
  });

  it("zero vale na contagem de inventário e negativo vale no ajuste, só quando permitido", () => {
    expect(problemaDeQuantidade(0, "comprimido", { permitirZero: true })).toBeNull();
    expect(problemaDeQuantidade(-2, "comprimido", { permitirNegativa: true })).toBeNull();
    expect(problemaDeQuantidade(-0.33, "comprimido", { permitirNegativa: true })).toMatch(/0,25/);
    expect(problemaDeQuantidade(0, "comprimido", { permitirNegativa: true })).toMatch(/zero/);
  });

  it("arredonda sugestões de compra para cima, no passo da unidade", () => {
    expect(arredondarParaCima(10.1, "comprimido")).toBe(10.25);
    expect(arredondarParaCima(10, "comprimido")).toBe(10);
    expect(arredondarParaCima(0.01, "comprimido")).toBe(0.25);
    expect(arredondarParaCima(10.0001, "ml")).toBe(10.001);
    expect(arredondarParaCima(10, "ml")).toBe(10);
  });
});

describe("validade do lote", () => {
  const hoje = "2026-03-10";

  it("o último dia ainda vale; o dia seguinte já está vencido", () => {
    expect(loteVencido("2026-03-10", hoje)).toBe(false);
    expect(loteVencido("2026-03-09", hoje)).toBe(true);
    expect(loteVencido("2026-03-11", hoje)).toBe(false);
    expect(diasParaVencer("2026-03-10", hoje)).toBe(0);
    expect(diasParaVencer("2026-03-09", hoje)).toBe(-1);
    expect(diasParaVencer("2026-04-09", hoje)).toBe(30);
  });

  it("classifica com os limites da spec: 30 dias aviso, 7 urgente, vencido", () => {
    expect(LIMITES_DE_VALIDADE_PADRAO).toEqual({ avisoDias: 30, urgenteDias: 7 });
    const sit = (v: string) => situacaoDeValidade(v, hoje);
    expect(sit("2026-03-09")).toBe("vencido");
    expect(sit("2026-03-10")).toBe("urgente");
    expect(sit("2026-03-17")).toBe("urgente"); // 7 dias
    expect(sit("2026-03-18")).toBe("aviso"); // 8 dias
    expect(sit("2026-04-09")).toBe("aviso"); // 30 dias
    expect(sit("2026-04-10")).toBe("ok"); // 31 dias
  });

  it("aceita limites da casa", () => {
    expect(situacaoDeValidade("2026-03-30", hoje, { avisoDias: 60, urgenteDias: 25 })).toBe(
      "urgente",
    );
  });

  it("estoque acabando: 7 dias ou menos é aviso, 3 ou menos é urgente; null é ok", () => {
    expect(LIMITES_DE_ESTOQUE_PADRAO).toEqual({ avisoDias: 7, urgenteDias: 3 });
    expect(situacaoDeEstoque(null)).toBe("ok");
    expect(situacaoDeEstoque(0)).toBe("urgente");
    expect(situacaoDeEstoque(3)).toBe("urgente");
    expect(situacaoDeEstoque(4)).toBe("aviso");
    expect(situacaoDeEstoque(7)).toBe("aviso");
    expect(situacaoDeEstoque(8)).toBe("ok");
  });
});

describe("validação da entrada de lote", () => {
  const hoje = "2026-03-10";
  const base: EntradaDeLote = {
    medicamentoId: "m",
    numeroLote: "L2345",
    validade: "2027-01-31",
    unidade: "comprimido",
    quantidade: 30,
  };

  it("uma entrada correta não tem problemas", () => {
    expect(validarEntradaDeLote(base, hoje)).toEqual([]);
    expect(validarEntradaDeLote({ ...base, validade: hoje }, hoje)).toEqual([]);
  });

  it("recusa lote vencido, data impossível e validade absurda", () => {
    expect(validarEntradaDeLote({ ...base, validade: "2026-03-09" }, hoje)[0]).toMatch(/vencido/);
    expect(validarEntradaDeLote({ ...base, validade: "2027-02-30" }, hoje)[0]).toMatch(/data real/);
    expect(validarEntradaDeLote({ ...base, validade: "31/01/2027" }, hoje)[0]).toMatch(/data real/);
    expect(validarEntradaDeLote({ ...base, validade: "2062-01-01" }, hoje)[0]).toMatch(/10 anos/);
  });

  it("recusa número de lote vazio ou longo, quantidade e observação inválidas", () => {
    expect(validarEntradaDeLote({ ...base, numeroLote: "   " }, hoje)[0]).toMatch(/número do lote/);
    expect(validarEntradaDeLote({ ...base, numeroLote: "x".repeat(61) }, hoje)[0]).toMatch(
      /número do lote/,
    );
    expect(validarEntradaDeLote({ ...base, quantidade: 0 }, hoje)[0]).toMatch(/zero/);
    expect(validarEntradaDeLote({ ...base, quantidade: 0.3 }, hoje)[0]).toMatch(/0,25/);
    expect(validarEntradaDeLote({ ...base, observacao: "x".repeat(301) }, hoje)[0]).toMatch(
      /observação/,
    );
  });

  it("junta todos os problemas de uma vez", () => {
    const p = validarEntradaDeLote(
      { ...base, numeroLote: "", validade: "2020-01-01", quantidade: -1 },
      hoje,
    );
    expect(p).toHaveLength(3);
  });

  it("o motivo precisa ter de 3 a 500 caracteres úteis", () => {
    expect(problemaDeMotivo("  ")).not.toBeNull();
    expect(problemaDeMotivo("ab")).not.toBeNull();
    expect(problemaDeMotivo("frasco caiu")).toBeNull();
    expect(problemaDeMotivo("x".repeat(501))).not.toBeNull();
    expect(problemaDeMotivo("x".repeat(500))).toBeNull();
  });
});
