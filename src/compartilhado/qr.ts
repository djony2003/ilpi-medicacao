// Conteúdo dos QR codes do sistema. Todo QR carrega só um código opaco e aleatório, nunca dados
// da pessoa ou do medicamento: quem fotografa uma pulseira não descobre nada sem uma sessão.
// O prefixo diz o que o código identifica, para o tablet recusar uma etiqueta de lote lida onde
// se esperava uma pulseira (e vice-versa).

export type TipoDeQr = "idoso" | "lote";

const PREFIXO: Record<TipoDeQr, string> = { idoso: "I", lote: "L" };
const FORMATO = /^ILPI:([IL]):([A-HJKMNP-Z2-9]{20})$/;

export function montarPayloadQr(tipo: TipoDeQr, codigo: string): string {
  return `ILPI:${PREFIXO[tipo]}:${codigo}`;
}

export function lerPayloadQr(texto: string): { tipo: TipoDeQr; codigo: string } | null {
  const m = FORMATO.exec(texto.trim().toUpperCase());
  if (!m) return null;
  return { tipo: m[1] === "I" ? "idoso" : "lote", codigo: m[2] ?? "" };
}

/** Código agrupado de 5 em 5 para ler em voz alta ou digitar quando o QR não lê. */
export function codigoLegivel(codigo: string): string {
  return codigo.match(/.{1,5}/g)?.join("-") ?? codigo;
}

/** Aceita o payload completo, o código puro ou o código agrupado digitado à mão. */
export function extrairCodigo(texto: string, tipoEsperado: TipoDeQr): string | null {
  const lido = lerPayloadQr(texto);
  if (lido) return lido.tipo === tipoEsperado ? lido.codigo : null;
  const limpo = texto.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJKMNP-Z2-9]{20}$/.test(limpo) ? limpo : null;
}
