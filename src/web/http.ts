import type { z } from "zod";

// Utilitários HTTP sem dependência de framework: recebem e devolvem Request/Response padrão da web.
// Isso permite testar a API inteira chamando as funções diretamente, sem subir o servidor.

export const LIMITE_CORPO_BYTES = 16 * 1024;

export class ErroHttp extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    public readonly detalhes?: unknown,
  ) {
    super(codigo);
    this.name = "ErroHttp";
  }
}

export function json(corpo: unknown, status = 200, cabecalhos: Headers = new Headers()): Response {
  cabecalhos.set("Content-Type", "application/json; charset=utf-8");
  // Respostas da API têm dados pessoais e de saúde: nada disso pode ficar em cache.
  cabecalhos.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(corpo), { status, headers: cabecalhos });
}

async function lerComLimite(request: Request): Promise<string> {
  const declarado = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > LIMITE_CORPO_BYTES) {
    throw new ErroHttp(413, "corpo_grande_demais");
  }
  const leitor = request.body?.getReader();
  if (!leitor) return "";
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITE_CORPO_BYTES) {
      await leitor.cancel();
      throw new ErroHttp(413, "corpo_grande_demais");
    }
    partes.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(partes));
}

/**
 * Lê um corpo binário (upload de arquivo) com limite rígido, sem carregar além dele na memória.
 * Quem chama confere o conteúdo de verdade (o tipo declarado pelo cliente não vale como prova).
 */
export async function lerCorpoBinario(request: Request, limiteBytes: number): Promise<Uint8Array> {
  const declarado = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > limiteBytes) {
    throw new ErroHttp(413, "arquivo_grande_demais");
  }
  const leitor = request.body?.getReader();
  if (!leitor) throw new ErroHttp(400, "requisicao_invalida");
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limiteBytes) {
      await leitor.cancel();
      throw new ErroHttp(413, "arquivo_grande_demais");
    }
    partes.push(value);
  }
  if (total === 0) throw new ErroHttp(400, "requisicao_invalida");
  return Buffer.concat(partes);
}

/** Lê e valida o corpo JSON. Qualquer desvio vira 400, sem ecoar o que foi enviado. */
export async function lerCorpo<T>(request: Request, esquema: z.ZodType<T>): Promise<T> {
  const tipo = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(tipo)) throw new ErroHttp(415, "tipo_de_conteudo_invalido");
  const texto = await lerComLimite(request);
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new ErroHttp(400, "requisicao_invalida");
  }
  const r = esquema.safeParse(bruto);
  if (!r.success) throw new ErroHttp(400, "requisicao_invalida");
  return r.data;
}

/**
 * Defesa contra CSRF para requisições que alteram dados: o navegador envia Origin (ou
 * Sec-Fetch-Site) e a página de outro site não consegue falsificá-los. Sem nenhum dos dois, recusa.
 */
export function mesmaOrigem(request: Request, origemEsperada?: string): boolean {
  const esperada = origemEsperada ?? new URL(request.url).origin;
  const origem = request.headers.get("origin");
  if (origem) return origem === esperada;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

const IP_PLAUSIVEL = /^[0-9a-fA-F:.]{3,45}$/;

/** IP do cliente para a auditoria. Vem do proxy da plataforma; serve de rastro, não de segurança. */
export function ipDe(request: Request): string | null {
  const primeiro = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return primeiro && IP_PLAUSIVEL.test(primeiro) ? primeiro : null;
}

export function lerCookie(request: Request, nome: string): string | null {
  const cabecalho = request.headers.get("cookie");
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(";")) {
    const i = parte.indexOf("=");
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim() || null;
  }
  return null;
}

/**
 * Cookie sempre HttpOnly (o JavaScript da página nunca enxerga o token). Em produção usa o
 * prefixo __Host-, que o navegador só aceita com Secure, Path=/ e sem Domain.
 */
export function montarCookie(
  nome: string,
  valor: string,
  opcoes: { producao: boolean; maxAgeSegundos: number },
): string {
  const partes = [
    `${nome}=${valor}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opcoes.maxAgeSegundos))}`,
  ];
  if (opcoes.producao) partes.push("Secure");
  return partes.join("; ");
}

export function nomeDoCookie(base: string, producao: boolean): string {
  return producao ? `__Host-${base}` : base;
}
