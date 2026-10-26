import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { lerPayloadQr } from "@/compartilhado/qr";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import {
  gerarPdfDaEtiqueta,
  gerarPdfDaReposicao,
  type DadosParaEtiqueta,
  type DadosParaReposicao,
} from "@/modules/estoque";

const temPoppler =
  spawnSync("pdftoppm", ["-v"]).error === undefined &&
  spawnSync("pdftotext", ["-v"]).error === undefined;

function comPdf<T>(pdf: Uint8Array, fn: (arquivo: string, pasta: string) => T): T {
  const pasta = mkdtempSync(join(tmpdir(), "estoque-pdf-"));
  try {
    const arquivo = join(pasta, "p.pdf");
    writeFileSync(arquivo, pdf);
    return fn(arquivo, pasta);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

const texto = (pdf: Uint8Array) =>
  comPdf(pdf, (arq) => execFileSync("pdftotext", ["-layout", arq, "-"], { encoding: "utf8" }));

function qrDaPagina(pdf: Uint8Array, pagina: number): string | null {
  return comPdf(pdf, (arq, pasta) => {
    execFileSync("pdftoppm", [
      "-r",
      "300",
      "-png",
      "-f",
      String(pagina),
      "-l",
      String(pagina),
      "-singlefile",
      arq,
      join(pasta, "q"),
    ]);
    const png = PNG.sync.read(readFileSync(join(pasta, "q.png")));
    return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
  });
}

const etiqueta: DadosParaEtiqueta = {
  medicamento: "Losartana Potássica",
  concentracao: "50 mg",
  numeroLote: "L2345-B",
  validade: "2027-01-31",
  quantidade: 30,
  unidade: "comprimido",
  codigo: "ABCDEFGHJKMNPQRSTUVW",
  destino: null,
  reimpressao: false,
};

describe("PDF da etiqueta do lote", () => {
  it("gera uma página de 70 x 30 mm por cópia", async () => {
    const pdf = await gerarPdfDaEtiqueta(etiqueta, 3);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(3);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo((70 * 72) / 25.4, 1);
    expect(height).toBeCloseTo((30 * 72) / 25.4, 1);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(await gerarPdfDaEtiqueta(etiqueta))).getPageCount()).toBe(1);
    expect((await PDFDocument.load(await gerarPdfDaEtiqueta(etiqueta, 0))).getPageCount()).toBe(1);
  });

  it.runIf(temPoppler)(
    "o QR impresso lê de volta o código do lote, em todas as cópias",
    async () => {
      const codigo = gerarCodigoOpaco();
      const pdf = await gerarPdfDaEtiqueta({ ...etiqueta, codigo }, 2);
      for (const pagina of [1, 2]) {
        const lido = qrDaPagina(pdf, pagina);
        expect(lido, `página ${pagina}`).not.toBeNull();
        expect(lerPayloadQr(lido ?? "")).toEqual({ tipo: "lote", codigo });
      }
    },
  );

  it.runIf(temPoppler)("mostra medicamento, lote, validade, quantidade e destino", async () => {
    const t = texto(await gerarPdfDaEtiqueta({ ...etiqueta, destino: "Maria da Silva" }));
    expect(t).toContain("Losartana Potássica 50 mg");
    expect(t).toContain("Lote L2345-B");
    expect(t).toContain("Val. 31/01/2027");
    expect(t).toContain("Qtd. 30 comprimido");
    expect(t).toContain("Para: Maria da Silva");
    expect(t).toContain("ABCDE-FGHJK-MNPQR-STUVW");
    expect(t).not.toContain("reimpressão");
  });

  it.runIf(temPoppler)("estoque comum e reimpressão ficam escritos na etiqueta", async () => {
    const t = texto(await gerarPdfDaEtiqueta({ ...etiqueta, reimpressao: true, quantidade: 7.5 }));
    expect(t).toContain("Estoque comum");
    expect(t).toContain("(reimpressão)");
    expect(t).toContain("Qtd. 7,5 comprimido");
  });

  it("nome enorme não quebra a geração (a letra encolhe ou o texto é cortado)", async () => {
    const pdf = await gerarPdfDaEtiqueta({
      ...etiqueta,
      medicamento: "Medicamento com um nome absurdamente comprido ".repeat(5),
      numeroLote: "L".repeat(60),
      destino: "Nome Muito Comprido De Pessoa ".repeat(4),
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});

const item = (n: number, extra: Partial<DadosParaReposicao["itens"][number]> = {}) => ({
  medicamento: {
    id: `m${n}`,
    nome: `Remédio ${n}`,
    principioAtivo: `Ativo ${n}`,
    concentracao: "10 mg",
  },
  unidade: "comprimido" as const,
  idosoNome: null,
  idososAtendidos: ["Ana Souza", "Bia Lima"],
  saldoDisponivel: 4,
  diasRestantes: 2,
  esgotaEm: "2026-03-13",
  situacao: "urgente" as const,
  quantidadeSugerida: 86,
  ...extra,
});

const lista = (itens: DadosParaReposicao["itens"]): DadosParaReposicao => ({
  casaNome: "Casa Bem Viver",
  fuso: "America/Sao_Paulo",
  geradaEm: "2026-03-11T15:00:00.000Z",
  hoje: "2026-03-11",
  coberturaDias: 30,
  diasParaRepor: 7,
  itens,
});

describe("PDF da lista de reposição", () => {
  it.runIf(temPoppler)("traz a casa, os itens, as datas e as quantidades a comprar", async () => {
    const t = texto(
      await gerarPdfDaReposicao(
        lista([
          item(1),
          item(2, {
            idosoNome: "Carlos Dias",
            idososAtendidos: ["Carlos Dias"],
            diasRestantes: 0,
            esgotaEm: "2026-03-11",
            quantidadeSugerida: 12.5,
          }),
        ]),
      ),
    );
    expect(t).toContain("Casa Bem Viver");
    expect(t).toContain("Lista de reposição de medicamentos");
    expect(t).toContain("Cobertura de 30 dias");
    expect(t).toContain("Remédio 1 10 mg");
    expect(t).toContain("Ana Souza, Bia Lima");
    expect(t).toContain("2 dia(s) (13/03/2026)");
    expect(t).toContain("86 comprimido(s)");
    expect(t).toContain("Carlos Dias");
    expect(t).toContain("Acabou (11/03/2026)");
    expect(t).toContain("12,5 comprimido(s)");
    expect(t).toContain("Página 1 de 1");
  });

  it.runIf(temPoppler)("lista vazia diz que não há o que repor", async () => {
    const t = texto(await gerarPdfDaReposicao(lista([])));
    expect(t).toContain("Nenhum medicamento precisa de reposição agora.");
  });

  it("muitos itens ocupam várias páginas, sem perder nenhum", async () => {
    const itens = Array.from({ length: 50 }, (_, i) => item(i + 1));
    const pdf = await gerarPdfDaReposicao(lista(itens));
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(3);
    if (temPoppler) {
      const t = texto(pdf);
      for (let i = 1; i <= 50; i += 1) expect(t, `item ${i}`).toContain(`Remédio ${i} 10 mg`);
      expect(t).toContain("Página 3 de 3");
    }
  });
});
