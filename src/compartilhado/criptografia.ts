import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Criptografia de campos sensíveis na aplicação (AES-256-GCM), além da criptografia do banco.
// Formato guardado: "v1:<iv>:<tag>:<texto cifrado>", tudo em base64url.
// O prefixo de versão permite trocar de algoritmo ou de chave no futuro.

const VERSAO = "v1";

function chaveDe(base64: string): Buffer {
  const chave = Buffer.from(base64, "base64");
  if (chave.length !== 32) {
    throw new Error("CHAVE_CAMPOS deve ter 32 bytes em base64.");
  }
  return chave;
}

export function cifrar(texto: string, chaveBase64: string): string {
  const chave = chaveDe(chaveBase64);
  const iv = randomBytes(12);
  const cifra = createCipheriv("aes-256-gcm", chave, iv);
  const conteudo = Buffer.concat([cifra.update(texto, "utf8"), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [
    VERSAO,
    iv.toString("base64url"),
    tag.toString("base64url"),
    conteudo.toString("base64url"),
  ].join(":");
}

export function decifrar(guardado: string, chaveBase64: string): string {
  const partes = guardado.split(":");
  const [versao, iv, tag, conteudo] = partes;
  if (partes.length !== 4 || versao !== VERSAO || !iv || !tag || !conteudo) {
    throw new Error("Formato de campo cifrado inválido.");
  }
  const decifra = createDecipheriv(
    "aes-256-gcm",
    chaveDe(chaveBase64),
    Buffer.from(iv, "base64url"),
  );
  decifra.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decifra.update(Buffer.from(conteudo, "base64url")),
    decifra.final(),
  ]).toString("utf8");
}
