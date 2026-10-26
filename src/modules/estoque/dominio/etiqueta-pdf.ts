import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ajustarTexto, desenharQr } from "@/compartilhado/pdf";
import { codigoLegivel, montarPayloadQr } from "@/compartilhado/qr";

// Etiqueta do lote: 70 x 30 mm, uma por página (impressora de etiquetas); `copias` repete a
// página para quem cola uma etiqueta em cada caixa. O QR carrega só o código opaco do lote; o texto ao lado serve para a
// conferência visual e para digitar o código quando a etiqueta estiver gasta.

const MM = 72 / 25.4;

export type DadosParaEtiqueta = {
  medicamento: string;
  concentracao: string | null;
  numeroLote: string;
  /** AAAA-MM-DD. */
  validade: string;
  quantidade: number;
  unidade: string;
  codigo: string;
  /** Nome do idoso quando o estoque é individual; null = estoque comum da casa. */
  destino: string | null;
  reimpressao: boolean;
};

function dataBr(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function numeroBr(valor: number): string {
  return valor.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

export async function gerarPdfDaEtiqueta(
  dados: DadosParaEtiqueta,
  copias = 1,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Etiqueta de lote");
  pdf.setCreator("ILPI Medicação");
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const cinza = rgb(0.35, 0.35, 0.35);
  const largura = 70 * MM;
  const altura = 30 * MM;
  const payload = montarPayloadQr("lote", dados.codigo);
  const nomeCompleto = dados.concentracao
    ? `${dados.medicamento} ${dados.concentracao}`
    : dados.medicamento;

  for (let i = 0; i < Math.max(1, copias); i += 1) {
    const pagina = pdf.addPage([largura, altura]);
    const qr = altura - 2 * MM;
    desenharQr(pagina, payload, 1 * MM, 1 * MM, qr);
    const x = 1 * MM + qr + 1.5 * MM;
    const maxL = largura - x - 2 * MM;

    const nome = ajustarTexto(nomeCompleto, negrito, maxL, 10, 6);
    pagina.drawText(nome.texto, { x, y: altura - 6 * MM, size: nome.tamanho, font: negrito });

    const lote = ajustarTexto(`Lote ${dados.numeroLote}`, normal, maxL, 8, 5.5);
    pagina.drawText(lote.texto, { x, y: altura - 10.5 * MM, size: lote.tamanho, font: normal });

    const val = ajustarTexto(`Val. ${dataBr(dados.validade)}`, negrito, maxL, 9, 6);
    pagina.drawText(val.texto, { x, y: altura - 15 * MM, size: val.tamanho, font: negrito });

    const qtd = ajustarTexto(
      `Qtd. ${numeroBr(dados.quantidade)} ${dados.unidade}`,
      normal,
      maxL,
      8,
      5.5,
    );
    pagina.drawText(qtd.texto, { x, y: altura - 19 * MM, size: qtd.tamanho, font: normal });

    const destino = ajustarTexto(
      dados.destino ? `Para: ${dados.destino}` : "Estoque comum",
      normal,
      maxL,
      7,
      5,
    );
    pagina.drawText(destino.texto, {
      x,
      y: altura - 22.8 * MM,
      size: destino.tamanho,
      font: normal,
    });

    const rodape = `${codigoLegivel(dados.codigo)}${dados.reimpressao ? "  (reimpressão)" : ""}`;
    const cod = ajustarTexto(rodape, normal, maxL, 5.5, 4);
    pagina.drawText(cod.texto, {
      x,
      y: 2 * MM,
      size: cod.tamanho,
      font: normal,
      color: cinza,
    });
  }

  return pdf.save();
}
