import { montarCsv } from "@/compartilhado/csv";
import { ROTULOS_DE_EXCECAO, type RelatorioDeExcecoes } from "../dados/excecoes";
import { dataBr, dataHoraBr } from "./periodo";
import { gerarPdfDeTabela } from "./tabela-pdf";

const RESULTADOS: Record<string, string> = {
  administrada: "Administrada",
  recusada: "Recusada",
  nao_administrada: "Não administrada",
  adiada: "Adiada",
};

export function csvDeExcecoes(r: RelatorioDeExcecoes): string {
  return montarCsv(
    [
      "Data e hora",
      "Residente",
      "Medicamento",
      "Resultado",
      "Motivo",
      "Justificativa",
      "Registrou",
      "Liberou",
    ],
    r.itens.map((i) => [
      dataHoraBr(i.ocorridaEm, r.fuso),
      i.idosoNome,
      i.medicamento,
      RESULTADOS[i.resultado] ?? i.resultado,
      ROTULOS_DE_EXCECAO[i.motivo],
      i.justificativa,
      i.registradoPor,
      i.liberadoPor,
    ]),
  );
}

export async function pdfDeExcecoes(r: RelatorioDeExcecoes): Promise<Uint8Array> {
  const proporcao =
    r.totalDeRegistros > 0
      ? ` de ${r.totalDeRegistros} registro(s) de dose (${((r.total / r.totalDeRegistros) * 100).toFixed(1).replace(".", ",")}%)`
      : "";
  return gerarPdfDeTabela({
    titulo: `Exceções de conferência - ${r.casaNome}`,
    subtitulos: [
      `Período ${dataBr(r.de)} a ${dataBr(r.ate)}`,
      `${r.total} exceção(ões)${proporcao}`,
    ],
    colunas: [
      { titulo: "Data e hora", largura: 22 },
      { titulo: "Residente", largura: 30 },
      { titulo: "Medicamento", largura: 26 },
      { titulo: "Motivo", largura: 20 },
      { titulo: "Justificativa", largura: 56 },
      { titulo: "Registrou", largura: 20 },
      { titulo: "Liberou", largura: 20 },
    ],
    linhas: r.itens.map((i) => [
      dataHoraBr(i.ocorridaEm, r.fuso),
      i.idosoNome,
      i.medicamento,
      ROTULOS_DE_EXCECAO[i.motivo],
      i.justificativa,
      i.registradoPor,
      i.liberadoPor,
    ]),
    emitidoEm: dataHoraBr(r.emitidoEm, r.fuso),
  });
}
