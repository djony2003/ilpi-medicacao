import { createHash, randomBytes, randomInt } from "node:crypto";

// Tokens de sessão e de aparelho são aleatórios e de alta entropia. O banco guarda apenas o
// hash SHA-256: quem lê o banco não consegue se passar por uma sessão.

export function gerarToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashDeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Sem 0/O, 1/I/L: o código de ativação é digitado à mão no tablet.
const ALFABETO_CODIGO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function gerarCodigoDeAtivacao(tamanho = 10): string {
  let codigo = "";
  for (let i = 0; i < tamanho; i += 1) {
    codigo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  }
  return codigo;
}

/** Normaliza o que a pessoa digitou: maiúsculas, sem espaços nem hífens. */
export function normalizarCodigoDeAtivacao(texto: string): string {
  return texto.toUpperCase().replace(/[\s-]/g, "");
}

/** Código opaco de 20 caracteres (~100 bits) para pulseiras e etiquetas. Sem 0/O/1/I/L. */
export function gerarCodigoOpaco(): string {
  return gerarCodigoDeAtivacao(20);
}
