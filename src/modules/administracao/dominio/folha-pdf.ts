import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ajustarTexto } from "@/compartilhado/pdf";
import type { DoseDaEscala } from "../dados/escala";

// Folha de contingência: o que a equipe imprime para continuar medicando no papel quando o
// sistema ou a rede cair. A4 em paisagem, uma linha por dose, em ordem de horário e de quarto,
// com espaço para a hora real, a rubrica e, nos medicamentos de alto risco, a segunda assinatura.

const MM = 72 / 25.4;
const LARGURA = 297 * MM;
const ALTURA = 210 * MM;
const MARGEM = 10 * MM;
const ALTURA_DA_LINHA = 14 * MM;
const ALTURA_DO_CABECALHO = 20 * MM;
const ALTURA_DO_RODAPE = 12 * MM;

const COLUNAS = [
  { chave: "hora", titulo: "Horário", largura: 18 },
  { chave: "residente", titulo: "Residente / quarto", largura: 55 },
  { chave: "medicamento", titulo: "Medicamento, dose e via", largura: 78 },
  { chave: "alergias", titulo: "Alergias", largura: 38 },
  { chave: "real", titulo: "Hora real", largura: 20 },
  { chave: "rubrica", titulo: "Rubrica", largura: 28 },
  { chave: "segunda", titulo: "2ª assinatura (alto risco)", largura: 40 },
] as const;

export type DadosParaFolha = {
  casaNome: string;
  emitidaEm: string;
  fuso: string;
  de: string;
  ate: string;
  truncada: boolean;
  doses: DoseDaEscala[];
};

const UNIDADES: Record<string, string> = {
  comprimido: "comprimido(s)",
  capsula: "cápsula(s)",
  gotas: "gotas",
  aplicacao: "aplicação(ões)",
  jato: "jato(s)",
  adesivo: "adesivo(s)",
};

const VIAS: Record<string, string> = {
  oral: "oral",
  sublingual: "sublingual",
  topica: "tópica",
  oftalmica: "oftálmica",
  otica: "otológica",
  nasal: "nasal",
  inalatoria: "inalatória",
  retal: "retal",
  subcutanea: "subcutânea",
  intramuscular: "intramuscular",
  intravenosa: "intravenosa",
  transdermica: "transdérmica",
};

function formatar(data: string, fuso: string, opcoes: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, ...opcoes }).format(new Date(data));
}

function numero(n: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n);
}

function larguraTotal(): number {
  return COLUNAS.reduce((s, c) => s + c.largura, 0) * MM;
}

export async function gerarPdfDaFolha(dados: DadosParaFolha): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Folha de contingência de medicação");
  pdf.setCreator("ILPI Medicação");
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);

  const linhasPorPagina = Math.max(
    1,
    Math.floor((ALTURA - 2 * MARGEM - ALTURA_DO_CABECALHO - ALTURA_DO_RODAPE) / ALTURA_DA_LINHA),
  );
  const paginasNecessarias = Math.max(1, Math.ceil(dados.doses.length / linhasPorPagina));
  const periodo =
    `${formatar(dados.de, dados.fuso, { dateStyle: "short", timeStyle: "short" })} a ` +
    formatar(dados.ate, dados.fuso, { dateStyle: "short", timeStyle: "short" });
  const emitida = formatar(dados.emitidaEm, dados.fuso, { dateStyle: "short", timeStyle: "short" });

  for (let p = 0; p < paginasNecessarias; p += 1) {
    const pagina = pdf.addPage([LARGURA, ALTURA]);
    cabecalho(pagina, negrito, normal, dados.casaNome, periodo);
    const grupo = dados.doses.slice(p * linhasPorPagina, (p + 1) * linhasPorPagina);
    if (dados.doses.length === 0) {
      pagina.drawText("Nenhuma dose prevista neste período.", {
        x: MARGEM,
        y: ALTURA - MARGEM - ALTURA_DO_CABECALHO - 20,
        size: 12,
        font: normal,
      });
    }
    let y = ALTURA - MARGEM - ALTURA_DO_CABECALHO;
    grupo.forEach((dose, i) => {
      const anterior = i === 0 ? undefined : grupo[i - 1];
      const mudouHorario = anterior ? anterior.previstaEm !== dose.previstaEm : false;
      linha(pagina, normal, negrito, dose, y, mudouHorario, dados.fuso);
      y -= ALTURA_DA_LINHA;
    });
    rodape(pagina, normal, emitida, p + 1, paginasNecessarias, dados.truncada);
  }
  return pdf.save();
}

function cabecalho(
  pagina: PDFPage,
  negrito: PDFFont,
  normal: PDFFont,
  casa: string,
  periodo: string,
): void {
  const topo = ALTURA - MARGEM;
  const titulo = ajustarTexto(`Folha de contingência - ${casa}`, negrito, 180 * MM, 14, 9);
  pagina.drawText(titulo.texto, { x: MARGEM, y: topo - 12, size: titulo.tamanho, font: negrito });
  pagina.drawText(`Período: ${periodo}`, {
    x: MARGEM,
    y: topo - 24,
    size: 9,
    font: normal,
    color: rgb(0.25, 0.25, 0.25),
  });
  let x = MARGEM;
  const yTitulo = topo - ALTURA_DO_CABECALHO + 4;
  pagina.drawRectangle({
    x: MARGEM,
    y: yTitulo - 3,
    width: larguraTotal(),
    height: 14,
    color: rgb(0.9, 0.9, 0.9),
  });
  for (const col of COLUNAS) {
    const t = ajustarTexto(col.titulo, negrito, col.largura * MM - 6, 8, 6);
    pagina.drawText(t.texto, { x: x + 3, y: yTitulo, size: t.tamanho, font: negrito });
    x += col.largura * MM;
  }
}

function linha(
  pagina: PDFPage,
  normal: PDFFont,
  negrito: PDFFont,
  d: DoseDaEscala,
  topo: number,
  mudouHorario: boolean,
  fuso: string,
): void {
  const base = topo - ALTURA_DA_LINHA;
  pagina.drawLine({
    start: { x: MARGEM, y: base },
    end: { x: MARGEM + larguraTotal(), y: base },
    thickness: 0.4,
    color: rgb(0.55, 0.55, 0.55),
  });
  if (mudouHorario) {
    pagina.drawLine({
      start: { x: MARGEM, y: topo },
      end: { x: MARGEM + larguraTotal(), y: topo },
      thickness: 1.2,
      color: rgb(0, 0, 0),
    });
  }

  // Colunas de texto
  const x: number[] = [];
  let acumulado = MARGEM;
  for (const col of COLUNAS) {
    x.push(acumulado);
    acumulado += col.largura * MM;
  }
  const larguraDe = (i: number) => (COLUNAS[i]?.largura ?? 0) * MM - 6;
  const xDe = (i: number) => (x[i] ?? MARGEM) + 3;
  const y1 = topo - 10;
  const y2 = topo - 22;
  const y3 = topo - 33;

  const dia = formatar(d.previstaEm, fuso, { day: "2-digit", month: "2-digit" });
  const hora = ajustarTexto(d.horaLocal, negrito, larguraDe(0), 13, 8);
  pagina.drawText(hora.texto, { x: xDe(0), y: y2, size: hora.tamanho, font: negrito });
  pagina.drawText(dia, {
    x: xDe(0),
    y: y1 + 1,
    size: 7,
    font: normal,
    color: rgb(0.35, 0.35, 0.35),
  });

  // Nome: numa linha se couber com letra legível (8 pt ou mais); senão, em duas linhas, para
  // que um nome longo nunca fique em letra miúda demais para conferir na ronda.
  const larguraNome = larguraDe(1);
  const numaLinha = ajustarTexto(d.idosoNome, negrito, larguraNome, 10, 8);
  const cabeNumaLinha = !numaLinha.texto.endsWith("...");
  const linhasDoNome = cabeNumaLinha
    ? [d.idosoNome]
    : quebrarEmDuas(d.idosoNome, negrito, larguraNome, 8);
  linhasDoNome.forEach((trecho, k) => {
    const t = ajustarTexto(trecho, negrito, larguraNome, 10, 7);
    pagina.drawText(t.texto, { x: xDe(1), y: y1 - k * 10, size: t.tamanho, font: negrito });
  });
  if (d.quarto) {
    const q = ajustarTexto(`Quarto ${d.quarto}`, normal, larguraNome, 9, 6);
    pagina.drawText(q.texto, {
      x: xDe(1),
      y: linhasDoNome.length > 1 ? y3 : y2,
      size: q.tamanho,
      font: normal,
    });
  }

  const remedio = [d.medicamento.nome, d.medicamento.concentracao].filter(Boolean).join(" ");
  const med = ajustarTexto(remedio, negrito, larguraDe(2), 10, 6);
  pagina.drawText(med.texto, { x: xDe(2), y: y1, size: med.tamanho, font: negrito });
  const unidade = UNIDADES[d.unidade] ?? d.unidade;
  const uso = ajustarTexto(
    `${numero(d.dose)} ${unidade} - via ${VIAS[d.via] ?? d.via}`,
    normal,
    larguraDe(2),
    9,
    6,
  );
  pagina.drawText(uso.texto, { x: xDe(2), y: y2, size: uso.tamanho, font: normal });
  if (d.instrucoes) {
    const ins = ajustarTexto(d.instrucoes, normal, larguraDe(2), 7.5, 5.5);
    pagina.drawText(ins.texto, {
      x: xDe(2),
      y: y3,
      size: ins.tamanho,
      font: normal,
      color: rgb(0.3, 0.3, 0.3),
    });
  }

  // Alergias: cada grave numa linha em negrito vermelho, depois as demais juntas. Cabem 3 linhas;
  // o que passar vira "+N" e remete ao cadastro (nunca some em silêncio).
  const graves = d.alergias.filter((a) => a.gravidade === "grave");
  const outras = d.alergias.filter((a) => a.gravidade !== "grave");
  type LinhaDeAlergia = { texto: string; grave: boolean; itens: number };
  const linhasDeAlergia: LinhaDeAlergia[] = graves.map((a) => ({
    texto: `GRAVE: ${a.substancia}`,
    grave: true,
    itens: 1,
  }));
  if (outras.length > 0) {
    linhasDeAlergia.push({
      texto: outras.map((a) => a.substancia).join(", "),
      grave: false,
      itens: outras.length,
    });
  }
  const posicoes = [y1, y2, y3];
  const caber = linhasDeAlergia.length > 3 ? 2 : linhasDeAlergia.length;
  linhasDeAlergia.slice(0, caber).forEach((l, k) => {
    const t = ajustarTexto(l.texto, l.grave ? negrito : normal, larguraDe(3), 8, 5.5);
    pagina.drawText(t.texto, {
      x: xDe(3),
      y: posicoes[k] ?? y3,
      size: t.tamanho,
      font: l.grave ? negrito : normal,
      color: l.grave ? rgb(0.7, 0, 0) : rgb(0, 0, 0),
    });
  });
  if (linhasDeAlergia.length > caber) {
    const escondidas = linhasDeAlergia.slice(caber).reduce((soma, l) => soma + l.itens, 0);
    pagina.drawText(`+${escondidas}: ver cadastro`, {
      x: xDe(3),
      y: posicoes[caber] ?? y3,
      size: 7,
      font: negrito,
    });
  }
  if (d.alergias.length === 0) {
    pagina.drawText("Nenhuma registrada", {
      x: xDe(3),
      y: y1,
      size: 7,
      font: normal,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  // Espaços de preenchimento à mão
  for (const i of [4, 5]) {
    pagina.drawLine({
      start: { x: xDe(i), y: base + 4 * MM },
      end: { x: xDe(i) + larguraDe(i), y: base + 4 * MM },
      thickness: 0.6,
      color: rgb(0.2, 0.2, 0.2),
    });
  }
  if (d.altoRisco) {
    pagina.drawText("ALTO RISCO", {
      x: xDe(6),
      y: y1,
      size: 7.5,
      font: negrito,
      color: rgb(0.7, 0, 0),
    });
    pagina.drawLine({
      start: { x: xDe(6), y: base + 4 * MM },
      end: { x: xDe(6) + larguraDe(6), y: base + 4 * MM },
      thickness: 0.6,
      color: rgb(0.2, 0.2, 0.2),
    });
  } else {
    pagina.drawText("-", { x: xDe(6), y: y2, size: 9, font: normal, color: rgb(0.6, 0.6, 0.6) });
  }
}

function rodape(
  pagina: PDFPage,
  normal: PDFFont,
  emitida: string,
  numeroDaPagina: number,
  total: number,
  truncada: boolean,
): void {
  const cinza = rgb(0.35, 0.35, 0.35);
  pagina.drawText(
    "Contém dados de saúde. Guarde com segurança e entregue ao enfermeiro responsável ao fim do plantão para lançar no sistema.",
    { x: MARGEM, y: MARGEM + 12, size: 7.5, font: normal, color: cinza },
  );
  pagina.drawText(`Emitida em ${emitida}  |  Página ${numeroDaPagina} de ${total}`, {
    x: MARGEM,
    y: MARGEM + 2,
    size: 7.5,
    font: normal,
    color: cinza,
  });
  if (truncada && numeroDaPagina === total) {
    pagina.drawText(
      "ATENÇÃO: havia mais doses do que cabe nesta folha. Reduza o período e imprima de novo.",
      {
        x: MARGEM + 130 * MM,
        y: MARGEM + 2,
        size: 8,
        font: normal,
        color: rgb(0.7, 0, 0),
      },
    );
  }
}

/** Divide o texto em duas linhas de largura parecida, quebrando entre palavras. */
function quebrarEmDuas(texto: string, fonte: PDFFont, largura: number, tamanho: number): string[] {
  const palavras = texto.split(/\s+/);
  let primeira = "";
  for (let k = 0; k < palavras.length; k += 1) {
    const tentativa = primeira ? `${primeira} ${palavras[k]}` : (palavras[k] ?? "");
    if (primeira && fonte.widthOfTextAtSize(tentativa, tamanho) > largura) {
      return [primeira, palavras.slice(k).join(" ")];
    }
    primeira = tentativa;
  }
  return [texto];
}
