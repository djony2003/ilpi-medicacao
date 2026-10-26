import { describe, expect, it } from "vitest";
import { cifrar, decifrar } from "@/compartilhado/criptografia";
import {
  gerarCodigoDeAtivacao,
  gerarToken,
  hashDeToken,
  normalizarCodigoDeAtivacao,
} from "@/compartilhado/tokens";

const CHAVE = Buffer.alloc(32, 3).toString("base64");
const OUTRA_CHAVE = Buffer.alloc(32, 4).toString("base64");

describe("criptografia de campos (AES-256-GCM)", () => {
  it("cifra e decifra o mesmo texto", () => {
    const guardado = cifrar("JBSWY3DPEHPK3PXP", CHAVE);
    expect(guardado.startsWith("v1:")).toBe(true);
    expect(guardado).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decifrar(guardado, CHAVE)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("gera texto cifrado diferente a cada vez (IV aleatório)", () => {
    expect(cifrar("x", CHAVE)).not.toBe(cifrar("x", CHAVE));
  });

  it("falha com a chave errada", () => {
    expect(() => decifrar(cifrar("segredo", CHAVE), OUTRA_CHAVE)).toThrow();
  });

  it("detecta adulteração do conteúdo", () => {
    const [v, iv, tag, conteudo] = cifrar("segredo", CHAVE).split(":");
    const adulterado = [v, iv, tag, `${conteudo?.slice(0, -2)}AA`].join(":");
    expect(() => decifrar(adulterado, CHAVE)).toThrow();
  });

  it("rejeita formato desconhecido e chave de tamanho errado", () => {
    expect(() => decifrar("v2:a:b:c", CHAVE)).toThrow(/inválido/);
    expect(() => decifrar("lixo", CHAVE)).toThrow(/inválido/);
    expect(() => cifrar("x", Buffer.alloc(8).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("tokens", () => {
  it("gera tokens longos e únicos", () => {
    const a = gerarToken();
    const b = gerarToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("o hash é estável, hexadecimal e diferente do token", () => {
    const token = gerarToken();
    expect(hashDeToken(token)).toBe(hashDeToken(token));
    expect(hashDeToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeToken(token)).not.toContain(token);
    expect(hashDeToken(token)).not.toBe(hashDeToken(`${token}x`));
  });

  it("o código de ativação evita caracteres ambíguos", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(gerarCodigoDeAtivacao()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{10}$/);
    }
  });

  it("normaliza o código digitado", () => {
    expect(normalizarCodigoDeAtivacao(" ab3k-9xy2 pq ")).toBe("AB3K9XY2PQ");
  });
});
