import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238) com HMAC-SHA1, 6 dígitos e passo de 30 segundos: o formato aceito por
// Google Authenticator, Microsoft Authenticator, Authy e 1Password.

const ALFABETO_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PERIODO_SEGUNDOS = 30;
export const DIGITOS = 6;

const byte = (buffer: Buffer, indice: number): number => buffer[indice] ?? 0;

export function codificarBase32(dados: Buffer): string {
  let bits = 0;
  let acumulado = 0;
  let saida = "";
  for (const b of dados) {
    acumulado = (acumulado << 8) | b;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO_BASE32[(acumulado >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO_BASE32[(acumulado << (5 - bits)) & 31];
  return saida;
}

export function decodificarBase32(texto: string): Buffer {
  const limpo = texto.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let acumulado = 0;
  const bytes: number[] = [];
  for (const caractere of limpo) {
    const valor = ALFABETO_BASE32.indexOf(caractere);
    if (valor === -1) throw new Error("Segredo TOTP em base32 inválido.");
    acumulado = (acumulado << 5) | valor;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acumulado >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo de 160 bits (o tamanho recomendado), em base32. */
export function gerarSegredoTotp(): string {
  return codificarBase32(randomBytes(20));
}

export function passoDe(agoraMs: number): number {
  return Math.floor(agoraMs / 1000 / PERIODO_SEGUNDOS);
}

export function gerarCodigo(
  segredoBase32: string | Buffer,
  passo: number,
  digitos = DIGITOS,
): string {
  const chave =
    typeof segredoBase32 === "string" ? decodificarBase32(segredoBase32) : segredoBase32;
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const hmac = createHmac("sha1", chave).update(contador).digest();
  const deslocamento = byte(hmac, hmac.length - 1) & 0x0f;
  const numero =
    ((byte(hmac, deslocamento) & 0x7f) << 24) |
    (byte(hmac, deslocamento + 1) << 16) |
    (byte(hmac, deslocamento + 2) << 8) |
    byte(hmac, deslocamento + 3);
  return String(numero % 10 ** digitos).padStart(digitos, "0");
}

export type OpcoesDeVerificacao = {
  /** Quantos passos para cada lado aceitar, para tolerar relógios levemente fora de hora. */
  janela?: number;
  /** Último passo já aceito para este usuário. Códigos desse passo ou anteriores são recusados. */
  ultimoPasso?: number | null;
};

/**
 * Confere o código digitado. Devolve o passo que bateu (para o chamador guardar e impedir
 * reutilização do mesmo código) ou null se o código está errado, expirado ou já foi usado.
 */
export function verificarCodigo(
  segredoBase32: string,
  codigo: string,
  agoraMs: number,
  opcoes: OpcoesDeVerificacao = {},
): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const janela = opcoes.janela ?? 1;
  const atual = passoDe(agoraMs);
  const informado = Buffer.from(codigo, "utf8");

  let aceito: number | null = null;
  // Percorre todos os passos sem parar no primeiro acerto, para o tempo não revelar qual bateu.
  for (let delta = -janela; delta <= janela; delta += 1) {
    const passo = atual + delta;
    const jaUsado =
      opcoes.ultimoPasso !== undefined &&
      opcoes.ultimoPasso !== null &&
      passo <= opcoes.ultimoPasso;
    const esperado = Buffer.from(gerarCodigo(segredoBase32, passo), "utf8");
    if (timingSafeEqual(esperado, informado) && !jaUsado && aceito === null) aceito = passo;
  }
  return aceito;
}

export function montarUriTotp(opcoes: {
  segredoBase32: string;
  emissor: string;
  conta: string;
}): string {
  const emissor = encodeURIComponent(opcoes.emissor);
  const conta = encodeURIComponent(opcoes.conta);
  return (
    `otpauth://totp/${emissor}:${conta}?secret=${opcoes.segredoBase32}` +
    `&issuer=${emissor}&algorithm=SHA1&digits=${DIGITOS}&period=${PERIODO_SEGUNDOS}`
  );
}
