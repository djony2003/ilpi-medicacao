import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ajustarTexto } from "@/compartilhado/pdf";

// PDF de tabela simples para relatórios de gestão (auditoria, exceções): A4 em paisagem, uma
// linha por registro, cabeçalho repetido em cada página, número de página e data de emissão.
// Texto longo é reduzido e, no limite, cortado com reticências: o PDF é para leitura e arquivo;
// o conteúdo completo está na planilha.

const MM = 72 / 25.4;
const LARGURA = 297 * MM;
const ALTURA = 210 * MM;
const MARGEM = 10 * MM;
const ALTURA_DA_LINHA = 6.5 * MM;
const ALTURA_DO_CABECALHO = 22 * MM;
const ALTURA_DO_RODAPE = 10 * MM;

export type ColunaDoPdf = { titulo: string; largura: number };

export type TabelaParaPdf = {
  titulo: string;
  /** Linhas de contexto abaixo do título: casa, período, filtros. */
  subtitulos: string[];
  colunas: ColunaDoPdf[];
  linhas: string[][];
  emitidoEm: string;
  /** Avisa no rodapé que há mais registros do que os impressos. */
  truncada?: boolean;
};

export async function gerarPdfDeTabela(t: TabelaParaPdf): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(t.titulo);
  pdf.setCreator("ILPI Medicação");
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);

  const soma = t.colunas.reduce((s, c) => s + c.largura, 0);
  const util = LARGURA - 2 * MARGEM;
  const larguras = t.colunas.map((c) => (c.largura / soma) * util);
  const porPagina = Math.max(
    1,
    Math.floor((ALTURA - 2 * MARGEM - ALTURA_DO_CABECALHO - ALTURA_DO_RODAPE) / ALTURA_DA_LINHA),
  );
  const paginas = Math.max(1, Math.ceil(t.linhas.length / porPagina));

  for (let p = 0; p < paginas; p += 1) {
    const pagina = pdf.addPage([LARGURA, ALTURA]);
    const topo = ALTURA - MARGEM;
    const titulo = ajustarTexto(t.titulo, negrito, util, 14, 9);
    pagina.drawText(titulo.texto, { x: MARGEM, y: topo - 12, size: titulo.tamanho, font: negrito });
    t.subtitulos.slice(0, 2).forEach((s, i) => {
      const x = ajustarTexto(s, normal, util, 8.5, 6);
      pagina.drawText(x.texto, {
        x: MARGEM,
        y: topo - 23 - i * 10,
        size: x.tamanho,
        font: normal,
        color: rgb(0.25, 0.25, 0.25),
      });
    });
    const yCab = topo - ALTURA_DO_CABECALHO;
    pagina.drawRectangle({
      x: MARGEM,
      y: yCab - 3,
      width: util,
      height: 12,
      color: rgb(0.9, 0.9, 0.9),
    });
    let x = MARGEM;
    t.colunas.forEach((c, i) => {
      const ct = ajustarTexto(c.titulo, negrito, (larguras[i] ?? 0) - 6, 8, 6);
      pagina.drawText(ct.texto, { x: x + 3, y: yCab, size: ct.tamanho, font: negrito });
      x += larguras[i] ?? 0;
    });

    let y = yCab - 3;
    for (const linha of t.linhas.slice(p * porPagina, (p + 1) * porPagina)) {
      y -= ALTURA_DA_LINHA;
      pagina.drawLine({
        start: { x: MARGEM, y: y - 1.5 },
        end: { x: MARGEM + util, y: y - 1.5 },
        thickness: 0.3,
        color: rgb(0.7, 0.7, 0.7),
      });
      let xc = MARGEM;
      linha.forEach((valor, i) => {
        const ct = ajustarTexto(valor, normal, (larguras[i] ?? 0) - 6, 8, 6);
        pagina.drawText(ct.texto, { x: xc + 3, y, size: ct.tamanho, font: normal });
        xc += larguras[i] ?? 0;
      });
    }
    if (t.linhas.length === 0) {
      pagina.drawText("Nenhum registro no período.", {
        x: MARGEM,
        y: yCab - 24,
        size: 11,
        font: normal,
      });
    }
    const rodape = `Emitido em ${t.emitidoEm}  |  página ${p + 1} de ${paginas}${
      t.truncada ? "  |  há mais registros do que os listados: use a planilha" : ""
    }`;
    pagina.drawText(textoRodape(rodape), {
      x: MARGEM,
      y: MARGEM,
      size: 7.5,
      font: normal,
      color: rgb(0.35, 0.35, 0.35),
    });
  }
  return pdf.save();
}

// O rodapé só tem texto nosso (sem acento problemático além do Latin-1), mas passa pelo mesmo
// filtro para nunca quebrar o PDF.
function textoRodape(texto: string): string {
  return texto.replace(/[^\x20-\x7E -ÿ]/g, "?");
}
