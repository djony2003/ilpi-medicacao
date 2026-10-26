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

// ---------------------------------------------------------------------------------------------
// Arquivos (receitas, fotos). Formato binário: [0x01][iv 12][tag 16][conteúdo cifrado].
// O "contexto" (a chave do objeto no armazenamento) entra como dado autenticado: um arquivo
// cifrado copiado para outra chave não decifra, então ninguém troca a receita de um paciente
// pela de outro mexendo só no armazenamento.

const VERSAO_BINARIA = 1;

export function cifrarBytes(bytes: Uint8Array, chaveBase64: string, contexto: string): Buffer {
  const iv = randomBytes(12);
  const cifra = createCipheriv("aes-256-gcm", chaveDe(chaveBase64), iv);
  cifra.setAAD(Buffer.from(contexto, "utf8"));
  const conteudo = Buffer.concat([cifra.update(bytes), cifra.final()]);
  return Buffer.concat([Buffer.from([VERSAO_BINARIA]), iv, cifra.getAuthTag(), conteudo]);
}

export function decifrarBytes(guardado: Uint8Array, chaveBase64: string, contexto: string): Buffer {
  const b = Buffer.from(guardado);
  if (b.length < 29 || b[0] !== VERSAO_BINARIA)
    throw new Error("Formato de arquivo cifrado inválido.");
  const decifra = createDecipheriv("aes-256-gcm", chaveDe(chaveBase64), b.subarray(1, 13));
  decifra.setAAD(Buffer.from(contexto, "utf8"));
  decifra.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([decifra.update(b.subarray(29)), decifra.final()]);
}
