import { describe, expect, it } from "vitest";
import {
  PERIODO_SEGUNDOS,
  codificarBase32,
  decodificarBase32,
  gerarCodigo,
  gerarSegredoTotp,
  montarUriTotp,
  passoDe,
  verificarCodigo,
} from "@/modules/identidade";

// Vetores oficiais do Apêndice B da RFC 6238 (SHA-1, segredo ASCII "12345678901234567890").
const SEGREDO_RFC = Buffer.from("12345678901234567890", "ascii");
const VETORES_RFC: Array<[segundos: number, codigo8: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP — vetores da RFC 6238", () => {
  it.each(VETORES_RFC)("em t=%i segundos gera %s (8 dígitos)", (segundos, esperado) => {
    expect(gerarCodigo(SEGREDO_RFC, passoDe(segundos * 1000), 8)).toBe(esperado);
  });

  it.each(VETORES_RFC)(
    "em t=%i segundos os 6 dígitos são o final do código de 8",
    (segundos, oito) => {
      expect(gerarCodigo(SEGREDO_RFC, passoDe(segundos * 1000))).toBe(oito.slice(-6));
    },
  );
});

describe("base32", () => {
  it("bate com os vetores da RFC 4648", () => {
    const casos: Array<[string, string]> = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [texto, base32] of casos) {
      expect(codificarBase32(Buffer.from(texto, "ascii"))).toBe(base32);
      expect(decodificarBase32(base32).toString("ascii")).toBe(texto);
    }
  });

  it("aceita minúsculas, espaços e preenchimento '='", () => {
    expect(decodificarBase32("mzxw 6ytb oi==").toString("ascii")).toBe("foobar");
  });

  it("recusa caracteres fora do alfabeto", () => {
    expect(() => decodificarBase32("MZXW1")).toThrow(/base32/);
  });

  it("segredos gerados têm 160 bits, são únicos e fazem ida e volta", () => {
    const a = gerarSegredoTotp();
    const b = gerarSegredoTotp();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(codificarBase32(decodificarBase32(a))).toBe(a);
    expect(decodificarBase32(a)).toHaveLength(20);
  });
});

describe("verificarCodigo", () => {
  const segredo = codificarBase32(SEGREDO_RFC);
  const agora = 1_700_000_000_000;
  const passo = passoDe(agora);

  it("aceita o código do passo atual e devolve o passo que bateu", () => {
    expect(verificarCodigo(segredo, gerarCodigo(segredo, passo), agora)).toBe(passo);
  });

  it("tolera um passo para cada lado, mas não dois", () => {
    expect(verificarCodigo(segredo, gerarCodigo(segredo, passo - 1), agora)).toBe(passo - 1);
    expect(verificarCodigo(segredo, gerarCodigo(segredo, passo + 1), agora)).toBe(passo + 1);
    expect(verificarCodigo(segredo, gerarCodigo(segredo, passo - 2), agora)).toBeNull();
    expect(verificarCodigo(segredo, gerarCodigo(segredo, passo + 2), agora)).toBeNull();
  });

  it("recusa código errado", () => {
    const certo = gerarCodigo(segredo, passo);
    const errado = certo === "000000" ? "000001" : "000000";
    expect(verificarCodigo(segredo, errado, agora)).toBeNull();
  });

  it("recusa formato inválido sem tentar calcular", () => {
    for (const ruim of ["", "12345", "1234567", "abcdef", "12 345", " 123456"]) {
      expect(verificarCodigo(segredo, ruim, agora)).toBeNull();
    }
  });

  it("impede reutilizar o mesmo código (proteção contra repetição)", () => {
    const codigo = gerarCodigo(segredo, passo);
    const primeiro = verificarCodigo(segredo, codigo, agora);
    expect(primeiro).toBe(passo);
    expect(verificarCodigo(segredo, codigo, agora, { ultimoPasso: primeiro })).toBeNull();
  });

  it("depois de aceitar um passo, não aceita códigos de passos anteriores", () => {
    const anterior = gerarCodigo(segredo, passo - 1);
    expect(verificarCodigo(segredo, anterior, agora, { ultimoPasso: passo })).toBeNull();
  });

  it("ainda aceita um passo posterior ao último usado", () => {
    const proximo = gerarCodigo(segredo, passo + 1);
    expect(verificarCodigo(segredo, proximo, agora, { ultimoPasso: passo })).toBe(passo + 1);
  });

  it("janela 0 aceita só o passo atual", () => {
    expect(
      verificarCodigo(segredo, gerarCodigo(segredo, passo - 1), agora, { janela: 0 }),
    ).toBeNull();
    expect(verificarCodigo(segredo, gerarCodigo(segredo, passo), agora, { janela: 0 })).toBe(passo);
  });

  it("o passo muda a cada 30 segundos", () => {
    expect(PERIODO_SEGUNDOS).toBe(30);
    expect(passoDe(29_999)).toBe(0);
    expect(passoDe(30_000)).toBe(1);
  });
});

describe("montarUriTotp", () => {
  it("gera uma URI otpauth que os aplicativos autenticadores entendem", () => {
    const uri = montarUriTotp({
      segredoBase32: "JBSWY3DPEHPK3PXP",
      emissor: "ILPI Medicação",
      conta: "maria@casa.exemplo",
    });
    expect(uri).toBe(
      "otpauth://totp/ILPI%20Medica%C3%A7%C3%A3o:maria%40casa.exemplo?secret=JBSWY3DPEHPK3PXP" +
        "&issuer=ILPI%20Medica%C3%A7%C3%A3o&algorithm=SHA1&digits=6&period=30",
    );
  });
});
