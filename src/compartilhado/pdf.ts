import QRCode from "qrcode";
import { rgb, type PDFFont, type PDFPage } from "pdf-lib";

// Ajudantes de PDF compartilhados (pulseira de idoso agora; etiqueta de lote de medicamento depois).

/**
 * Desenha o QR como quadrados vetoriais, sem imagem: fica nítido em qualquer impressora e não
 * depende de reamostragem. `tamanho` é o lado total, incluindo a margem branca obrigatória.
 */
export function desenharQr(
  pagina: PDFPage,
  conteudo: string,
  x: number,
  y: number,
  tamanho: number,
): void {
  const qr = QRCode.create(conteudo, { errorCorrectionLevel: "M" });
  const lado = qr.modules.size;
  const margem = 4; // "quiet zone" de 4 módulos, exigida pela norma do QR
  const modulo = tamanho / (lado + 2 * margem);
  pagina.drawRectangle({ x, y, width: tamanho, height: tamanho, color: rgb(1, 1, 1) });
  for (let linha = 0; linha < lado; linha += 1) {
    for (let coluna = 0; coluna < lado; coluna += 1) {
      if (!qr.modules.get(linha, coluna)) continue;
      pagina.drawRectangle({
        x: x + (margem + coluna) * modulo,
        // O PDF cresce para cima; o QR é lido de cima para baixo.
        y: y + (margem + (lado - 1 - linha)) * modulo,
        width: modulo + 0.02, // sobreposição mínima evita frestas brancas entre módulos
        height: modulo + 0.02,
        color: rgb(0, 0, 0),
      });
    }
  }
}

/** A fonte padrão do PDF só cobre Latin-1: o que ela não representa vira "?" em vez de quebrar. */
export function textoSeguro(texto: string, fonte: PDFFont): string {
  const aceitos = new Set(fonte.getCharacterSet());
  return [...texto.normalize("NFC")]
    .map((c) => (aceitos.has(c.codePointAt(0) ?? 0) ? c : "?"))
    .join("");
}

/** Reduz o corpo da letra até caber; se nem no mínimo couber, corta com reticências. */
export function ajustarTexto(
  texto: string,
  fonte: PDFFont,
  larguraMaxima: number,
  tamanhoMaximo: number,
  tamanhoMinimo: number,
): { texto: string; tamanho: number } {
  const limpo = textoSeguro(texto, fonte);
  for (let t = tamanhoMaximo; t >= tamanhoMinimo; t -= 0.5) {
    if (fonte.widthOfTextAtSize(limpo, t) <= larguraMaxima) return { texto: limpo, tamanho: t };
  }
  let corte = limpo;
  while (
    corte.length > 1 &&
    fonte.widthOfTextAtSize(`${corte}...`, tamanhoMinimo) > larguraMaxima
  ) {
    corte = corte.slice(0, -1);
  }
  return { texto: `${corte.trimEnd()}...`, tamanho: tamanhoMinimo };
}
