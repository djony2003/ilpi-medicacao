import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ajustarTexto, textoSeguro } from "@/compartilhado/pdf";
import type { ListaDeReposicao } from "../dados/situacao";

// Lista de reposição para levar à farmácia ou passar à família: o que está acabando, para quem,
// e quanto comprar. A4 em retrato, uma linha por medicamento, os mais urgentes primeiro.

const MM = 72 / 25.4;
const LARGURA = 210 * MM;
const ALTURA = 297 * MM;
const MARGEM = 10 * MM;
const ALTURA_DA_LINHA = 11 * MM;
const ALTURA_DO_CABECALHO = 31 * MM;
const ALTURA_DO_RODAPE = 12 * MM;

const COLUNAS = [
  { titulo: "Medicamento", largura: 58 },
  { titulo: "Para", largura: 40 },
  { titulo: "Saldo", largura: 26 },
  { titulo: "Dura até", largura: 34 },
  { titulo: "Comprar", largura: 32 },
] as const;

/** Quebra em até duas linhas por palavras; o que não couber na segunda vira reticências. */
function emDuasLinhas(texto: string, fonte: PDFFont, largura: number, tamanho: number): string[] {
  const limpo = textoSeguro(texto, fonte);
  if (fonte.widthOfTextAtSize(limpo, tamanho) <= largura) return [limpo];
  const palavras = limpo.split(/\s+/);
  let primeira = "";
  let i = 0;
  while (i < palavras.length) {
    const tentativa = primeira ? `${primeira} ${palavras[i]}` : (palavras[i] ?? "");
    if (fonte.widthOfTextAtSize(tentativa, tamanho) > largura && primeira) break;
    primeira = tentativa;
    i += 1;
  }
  const resto = palavras.slice(i).join(" ");
  if (!resto) return [primeira];
  return [primeira, ajustarTexto(resto, fonte, largura, tamanho, tamanho).texto];
}

const ROTULO_DA_UNIDADE: Record<string, string> = {
  comprimido: "comprimido(s)",
  capsula: "cápsula(s)",
  aplicacao: "aplicação(ões)",
  jato: "jato(s)",
  adesivo: "adesivo(s)",
};

const numero = (n: number) =>
  new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n);
const unidade = (u: string) => ROTULO_DA_UNIDADE[u] ?? u;

function dataBr(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export type DadosParaReposicao = ListaDeReposicao;

export async function gerarPdfDaReposicao(dados: DadosParaReposicao): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Lista de reposição de medicamentos");
  pdf.setCreator("ILPI Medicação");
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);

  const porPagina = Math.max(
    1,
    Math.floor((ALTURA - 2 * MARGEM - ALTURA_DO_CABECALHO - ALTURA_DO_RODAPE) / ALTURA_DA_LINHA),
  );
  const paginas = Math.max(1, Math.ceil(dados.itens.length / porPagina));
  const emitida = new Intl.DateTimeFormat("pt-BR", {
    timeZone: dados.fuso,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(dados.geradaEm));

  for (let p = 0; p < paginas; p += 1) {
    const pagina = pdf.addPage([LARGURA, ALTURA]);
    cabecalho(pagina, negrito, normal, dados);
    let y = ALTURA - MARGEM - ALTURA_DO_CABECALHO;
    if (dados.itens.length === 0) {
      pagina.drawText("Nenhum medicamento precisa de reposição agora.", {
        x: MARGEM,
        y: y - 8 * MM,
        size: 12,
        font: normal,
      });
    }
    for (const item of dados.itens.slice(p * porPagina, (p + 1) * porPagina)) {
      linha(pagina, normal, negrito, item, y);
      y -= ALTURA_DA_LINHA;
    }
    pagina.drawText(`Emitida em ${emitida}  |  Página ${p + 1} de ${paginas}`, {
      x: MARGEM,
      y: MARGEM,
      size: 8,
      font: normal,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
  return pdf.save();
}

function cabecalho(pagina: PDFPage, negrito: PDFFont, normal: PDFFont, d: DadosParaReposicao) {
  const topo = ALTURA - MARGEM;
  const casa = ajustarTexto(d.casaNome, negrito, LARGURA - 2 * MARGEM, 15, 9);
  pagina.drawText(casa.texto, { x: MARGEM, y: topo - 6 * MM, size: casa.tamanho, font: negrito });
  pagina.drawText("Lista de reposição de medicamentos", {
    x: MARGEM,
    y: topo - 12 * MM,
    size: 11,
    font: normal,
  });
  pagina.drawText(
    `Cobertura de ${d.coberturaDias} dias, para o que acaba em até ${d.diasParaRepor} dias.`,
    { x: MARGEM, y: topo - 17 * MM, size: 8.5, font: normal, color: rgb(0.35, 0.35, 0.35) },
  );
  let x = MARGEM;
  const y = topo - ALTURA_DO_CABECALHO + 3 * MM;
  pagina.drawRectangle({
    x: MARGEM,
    y: y - 2 * MM,
    width: COLUNAS.reduce((s, c) => s + c.largura, 0) * MM,
    height: 8 * MM,
    color: rgb(0.9, 0.9, 0.9),
  });
  for (const c of COLUNAS) {
    pagina.drawText(c.titulo, { x: x + 1.5 * MM, y, size: 9, font: negrito });
    x += c.largura * MM;
  }
}

function linha(
  pagina: PDFPage,
  normal: PDFFont,
  negrito: PDFFont,
  item: ListaDeReposicao["itens"][number],
  yTopo: number,
) {
  const base = yTopo - ALTURA_DA_LINHA + 3 * MM;
  const nome = item.medicamento.concentracao
    ? `${item.medicamento.nome} ${item.medicamento.concentracao}`
    : item.medicamento.nome;
  const para =
    item.idosoNome ??
    (item.idososAtendidos.length > 0 ? item.idososAtendidos.join(", ") : "Estoque comum");
  const dias = item.diasRestantes === 0 ? "Acabou" : `${item.diasRestantes} dia(s)`;
  const celulas: Array<{ texto: string; fonte: PDFFont; quebra: boolean }> = [
    { texto: nome, fonte: negrito, quebra: true },
    { texto: para, fonte: normal, quebra: true },
    {
      texto: `${numero(item.saldoDisponivel)} ${unidade(item.unidade)}`,
      fonte: normal,
      quebra: false,
    },
    {
      texto: `${dias} (${dataBr(item.esgotaEm)})`,
      fonte: item.situacao === "urgente" ? negrito : normal,
      quebra: false,
    },
    {
      texto: `${numero(item.quantidadeSugerida)} ${unidade(item.unidade)}`,
      fonte: negrito,
      quebra: false,
    },
  ];
  let x = MARGEM;
  COLUNAS.forEach((c, i) => {
    const cel = celulas[i];
    if (!cel) return;
    const largura = c.largura * MM - 3 * MM;
    if (cel.quebra) {
      const linhas = emDuasLinhas(cel.texto, cel.fonte, largura, 9);
      linhas.forEach((l, k) => {
        const y = linhas.length === 1 ? base + 1 * MM : base + 2.6 * MM - k * 3.6 * MM;
        pagina.drawText(l, { x: x + 1.5 * MM, y, size: 9, font: cel.fonte });
      });
    } else {
      const t = ajustarTexto(cel.texto, cel.fonte, largura, 9.5, 6);
      pagina.drawText(t.texto, {
        x: x + 1.5 * MM,
        y: base + 1 * MM,
        size: t.tamanho,
        font: cel.fonte,
      });
    }
    x += c.largura * MM;
  });
  pagina.drawLine({
    start: { x: MARGEM, y: yTopo - ALTURA_DA_LINHA },
    end: { x: LARGURA - MARGEM, y: yTopo - ALTURA_DA_LINHA },
    thickness: 0.4,
    color: rgb(0.7, 0.7, 0.7),
  });
}
