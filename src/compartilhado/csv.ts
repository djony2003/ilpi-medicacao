// Planilha em CSV para abrir direto no Excel em português: separador ";", vírgula decimal fica a
// cargo de quem formata o valor, e BOM no início para os acentos saírem certos.

const PERIGOSOS = /^[=+\-@\t\r]/;

/**
 * Uma célula. Texto que começa com = + - @ vira fórmula no Excel, então ganha um apóstrofo na
 * frente (proteção contra injeção de fórmula: o texto vem de gente digitando nas telas).
 */
export function celulaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  let texto = typeof valor === "string" ? valor : String(valor);
  if (typeof valor === "string" && PERIGOSOS.test(texto)) texto = `'${texto}`;
  return /[";\n\r]/.test(texto) ? `"${texto.replaceAll('"', '""')}"` : texto;
}

export function montarCsv(
  colunas: string[],
  linhas: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  const corpo = [colunas, ...linhas].map((l) => l.map(celulaCsv).join(";")).join("\r\n");
  return `\uFEFF${corpo}\r\n`;
}
