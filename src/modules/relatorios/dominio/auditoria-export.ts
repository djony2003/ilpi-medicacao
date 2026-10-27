import { montarCsv } from "@/compartilhado/csv";
import type { ExportacaoDeAuditoria } from "../dados/auditoria";
import { dataBr, dataHoraBr } from "./periodo";
import { gerarPdfDeTabela } from "./tabela-pdf";

// Formatos de saída da auditoria: planilha (completa, com antes e depois em JSON) e PDF (resumo
// para leitura e arquivo).

function resumo(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  return JSON.stringify(valor);
}

export function csvDaAuditoria(e: ExportacaoDeAuditoria): string {
  return montarCsv(
    ["Nº", "Data e hora", "Pessoa", "Ação", "Objeto", "Identificador", "Antes", "Depois", "IP"],
    e.registros.map((r) => [
      r.seq,
      dataHoraBr(r.ocorridoEm, e.fuso),
      r.usuarioNome ?? "(sistema)",
      r.acao,
      r.entidade,
      r.entidadeId,
      resumo(r.antes),
      resumo(r.depois),
      r.ip,
    ]),
  );
}

export function descricaoDoFiltro(f: ExportacaoDeAuditoria["filtro"]): string {
  const partes: string[] = [];
  if (f.de && f.ate) partes.push(`período ${dataBr(f.de)} a ${dataBr(f.ate)}`);
  if (f.acao) partes.push(`ação "${f.acao}"`);
  if (f.entidade) partes.push(`objeto "${f.entidade}"`);
  if (f.entidadeId) partes.push(`identificador ${f.entidadeId}`);
  if (f.usuarioId) partes.push("uma pessoa");
  return partes.length > 0 ? `Filtros: ${partes.join("; ")}` : "Sem filtros: toda a trilha";
}

export async function pdfDaAuditoria(e: ExportacaoDeAuditoria): Promise<Uint8Array> {
  return gerarPdfDeTabela({
    titulo: `Trilha de auditoria - ${e.casaNome}`,
    subtitulos: [descricaoDoFiltro(e.filtro), `${e.registros.length} registro(s)`],
    colunas: [
      { titulo: "Nº", largura: 9 },
      { titulo: "Data e hora", largura: 22 },
      { titulo: "Pessoa", largura: 30 },
      { titulo: "Ação", largura: 36 },
      { titulo: "Objeto", largura: 18 },
      { titulo: "Detalhe", largura: 70 },
    ],
    linhas: e.registros.map((r) => [
      String(r.seq),
      dataHoraBr(r.ocorridoEm, e.fuso),
      r.usuarioNome ?? "(sistema)",
      r.acao,
      r.entidade,
      resumo(r.depois ?? r.antes),
    ]),
    emitidoEm: dataHoraBr(e.emitidoEm, e.fuso),
    truncada: e.truncada,
  });
}
