import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ajustarTexto, desenharQr } from "@/compartilhado/pdf";
import { codigoLegivel, montarPayloadQr } from "@/compartilhado/qr";

// PDF de impressão da identificação do idoso: uma tira para a pulseira e um cartão. Os dois
// levam o mesmo QR (só um código opaco), o nome e a data de nascimento para conferência visual,
// e o código agrupado para digitar quando o QR estiver sujo ou gasto.

const MM = 72 / 25.4;

export type DadosParaPulseira = {
  nome: string;
  dataNascimento: string;
  quarto: string | null;
  codigo: string;
};

function dataBr(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export async function gerarPdfDaPulseira(dados: DadosParaPulseira): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Identificação do residente");
  pdf.setCreator("ILPI Medicação");
  const pagina = pdf.addPage([210 * MM, 297 * MM]);
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const cinza = rgb(0.4, 0.4, 0.4);
  const payload = montarPayloadQr("idoso", dados.codigo);
  const nascimento = `Nasc. ${dataBr(dados.dataNascimento)}`;
  const detalhe = dados.quarto ? `${nascimento}  |  Quarto ${dados.quarto}` : nascimento;
  const margem = 10 * MM;
  const topo = 297 * MM - margem;

  pagina.drawText("Identificação do residente - recorte nas linhas tracejadas", {
    x: margem,
    y: topo - 8,
    size: 9,
    font: normal,
    color: cinza,
  });

  // ---- Tira da pulseira: 190 x 25 mm
  const tiraL = 190 * MM;
  const tiraA = 25 * MM;
  const tiraY = topo - 20 - tiraA;
  pagina.drawRectangle({
    x: margem,
    y: tiraY,
    width: tiraL,
    height: tiraA,
    borderColor: cinza,
    borderWidth: 0.6,
    borderDashArray: [4, 3],
  });
  const qrTira = tiraA - 2 * MM;
  desenharQr(pagina, payload, margem + 1 * MM, tiraY + 1 * MM, qrTira);
  const textoX = margem + 1 * MM + qrTira + 3 * MM;
  const larguraTexto = tiraL - (textoX - margem) - 3 * MM;
  const nome = ajustarTexto(dados.nome, negrito, larguraTexto, 16, 8);
  pagina.drawText(nome.texto, {
    x: textoX,
    y: tiraY + tiraA - 9 * MM,
    size: nome.tamanho,
    font: negrito,
  });
  const linha = ajustarTexto(detalhe, normal, larguraTexto, 11, 7);
  pagina.drawText(linha.texto, { x: textoX, y: tiraY + 9 * MM, size: linha.tamanho, font: normal });
  pagina.drawText(codigoLegivel(dados.codigo), {
    x: textoX,
    y: tiraY + 3.5 * MM,
    size: 8,
    font: normal,
    color: cinza,
  });

  // ---- Cartão: 85,6 x 54 mm (tamanho de cartão de banco)
  const cartL = 85.6 * MM;
  const cartA = 54 * MM;
  const cartX = margem;
  const cartY = tiraY - 15 * MM - cartA;
  pagina.drawRectangle({
    x: cartX,
    y: cartY,
    width: cartL,
    height: cartA,
    borderColor: cinza,
    borderWidth: 0.6,
    borderDashArray: [4, 3],
  });
  const qrCartao = 34 * MM;
  desenharQr(pagina, payload, cartX + 3 * MM, cartY + (cartA - qrCartao) / 2 - 3 * MM, qrCartao);
  const cartTextoX = cartX + 3 * MM + qrCartao + 2 * MM;
  const cartLargura = cartL - (cartTextoX - cartX) - 3 * MM;
  const nomeCartao = ajustarTexto(dados.nome, negrito, cartLargura, 12, 7);
  pagina.drawText(nomeCartao.texto, {
    x: cartTextoX,
    y: cartY + cartA - 12 * MM,
    size: nomeCartao.tamanho,
    font: negrito,
  });
  pagina.drawText(nascimento, { x: cartTextoX, y: cartY + cartA - 18 * MM, size: 8, font: normal });
  if (dados.quarto) {
    const q = ajustarTexto(`Quarto ${dados.quarto}`, normal, cartLargura, 8, 6);
    pagina.drawText(q.texto, {
      x: cartTextoX,
      y: cartY + cartA - 23 * MM,
      size: q.tamanho,
      font: normal,
    });
  }
  pagina.drawText("Aproxime o tablet do QR", {
    x: cartTextoX,
    y: cartY + 14 * MM,
    size: 7,
    font: normal,
    color: cinza,
  });
  pagina.drawText("ou digite o código:", {
    x: cartTextoX,
    y: cartY + 10.5 * MM,
    size: 7,
    font: normal,
    color: cinza,
  });
  const codigo = codigoLegivel(dados.codigo);
  const grupos = codigo.split("-");
  pagina.drawText(grupos.slice(0, 2).join("-"), {
    x: cartTextoX,
    y: cartY + 6.5 * MM,
    size: 8,
    font: negrito,
  });
  pagina.drawText(grupos.slice(2).join("-"), {
    x: cartTextoX,
    y: cartY + 3 * MM,
    size: 8,
    font: negrito,
  });

  return pdf.save();
}
