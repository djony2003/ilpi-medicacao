import { describe, expect, it } from "vitest";
import { TAMANHO_MINIMO_SENHA, validarPin, validarSenha } from "@/modules/identidade";

describe("validarSenha", () => {
  it("aceita uma frase longa e comum de se lembrar", () => {
    expect(validarSenha("cafe com bolo no domingo")).toEqual([]);
  });

  it("não exige maiúscula, número ou símbolo (só tamanho)", () => {
    expect(validarSenha("todasminusculasmasgrande")).toEqual([]);
  });

  it(`recusa senha com menos de ${TAMANHO_MINIMO_SENHA} caracteres`, () => {
    expect(validarSenha("curta123")).toHaveLength(1);
    expect(validarSenha("a".repeat(TAMANHO_MINIMO_SENHA - 1))[0]).toMatch(/pelo menos 12/);
  });

  it("aceita exatamente o tamanho mínimo", () => {
    expect(validarSenha("abcdefghijk1")).toEqual([]);
  });

  it("recusa senha acima do tamanho máximo", () => {
    expect(validarSenha("ab".repeat(70)).join(" ")).toMatch(/no máximo 128/);
  });

  it("recusa senhas comuns, mesmo com maiúsculas ou acentos", () => {
    expect(validarSenha("123456789012").join(" ")).toMatch(/comum/);
    expect(validarSenha("Administrador").join(" ")).toMatch(/comum/);
    expect(validarSenha("PASSWORDPASSWORD").join(" ")).toMatch(/comum/);
  });

  it("recusa senha feita de poucos caracteres repetidos", () => {
    expect(validarSenha("abababababab").join(" ")).toMatch(/repetidos/);
    expect(validarSenha("aaaaaaaaaaaa").join(" ")).toMatch(/repetidos/);
  });

  it("recusa senha que contém o nome ou o início do e-mail", () => {
    const contexto = { email: "mariana.souza@casa.exemplo", nome: "Mariana de Souza" };
    expect(validarSenha("minha-mariana-2024", contexto).join(" ")).toMatch(/nome/);
    expect(validarSenha("mariana.souza!!!!", contexto).join(" ")).toMatch(/nome/);
    expect(validarSenha("SOUZA para sempre", contexto).join(" ")).toMatch(/nome/);
  });

  it("ignora acentos ao comparar com o nome", () => {
    expect(validarSenha("josefa-conceicao-99", { nome: "Josefa Conceição" }).join(" ")).toMatch(
      /nome/,
    );
  });

  it("não implica com partes curtas do nome (como 'de')", () => {
    expect(validarSenha("ceu azul e flores!", { nome: "Ana de Lima" })).toEqual([]);
  });

  it("junta mais de um problema quando houver", () => {
    expect(validarSenha("aaa").length).toBeGreaterThanOrEqual(2);
  });
});

describe("validarPin", () => {
  it("aceita PINs que não seguem padrão óbvio", () => {
    for (const pin of ["482916", "730915", "264801", "915372"]) {
      expect(validarPin(pin)).toEqual([]);
    }
  });

  it("exige exatamente 6 dígitos numéricos", () => {
    for (const ruim of ["", "12345", "1234567", "12345a", "12 456", "٣٤٥٦٧٨"]) {
      expect(validarPin(ruim)[0]).toMatch(/6 dígitos/);
    }
  });

  it("recusa todos iguais, sequências e espelhados", () => {
    for (const pin of [
      "000000",
      "777777",
      "123456",
      "654321",
      "345678",
      "987654",
      "123321",
      "489984",
    ]) {
      expect(validarPin(pin).join(" "), pin).toMatch(/fácil demais/);
    }
  });

  it("recusa blocos repetidos e pares em sequência", () => {
    for (const pin of ["121212", "123123", "456456", "112233", "557799"]) {
      expect(validarPin(pin).join(" "), pin).toMatch(/fácil demais/);
    }
  });

  it("recusa os PINs mais usados da lista", () => {
    for (const pin of ["159753", "147258", "010203", "102030", "142536"]) {
      expect(validarPin(pin).join(" "), pin).toMatch(/fácil demais/);
    }
  });
});
