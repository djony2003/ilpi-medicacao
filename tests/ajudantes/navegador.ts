import { gerarCodigo, passoDe } from "@/modules/identidade";
import { SENHA_PADRAO } from "./dados";

export const ORIGEM = "http://localhost";

export type Resp = {
  status: number;
  corpo: Record<string, unknown>;
  /** Corpo bruto, para respostas que não são JSON (PDF). */
  texto: string;
  cabecalhos: Headers;
  setCookie: string[];
};

/** Guarda cookies como um navegador faria: envia os que tem, atualiza com os Set-Cookie. */
export class Navegador {
  readonly cookies = new Map<string, string>();
  constructor(private readonly api: (r: Request) => Promise<Response>) {}

  async chamar(
    metodo: "GET" | "POST",
    caminho: string,
    opcoes: {
      corpo?: unknown;
      brutoCorpo?: string;
      origem?: string | null;
      cabecalhos?: Record<string, string>;
      tipo?: string | null;
    } = {},
  ): Promise<Resp> {
    const cabecalhos = new Headers(opcoes.cabecalhos);
    if (opcoes.origem !== null) cabecalhos.set("origin", opcoes.origem ?? ORIGEM);
    if (this.cookies.size > 0) {
      cabecalhos.set("cookie", [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; "));
    }
    let body: string | undefined;
    if (opcoes.brutoCorpo !== undefined) body = opcoes.brutoCorpo;
    else if (opcoes.corpo !== undefined) body = JSON.stringify(opcoes.corpo);
    if (body !== undefined && opcoes.tipo !== null) {
      cabecalhos.set("content-type", opcoes.tipo ?? "application/json");
    }
    const r = await this.api(
      new Request(`${ORIGEM}/api${caminho}`, { method: metodo, headers: cabecalhos, body }),
    );
    const setCookie = r.headers.getSetCookie();
    for (const c of setCookie) {
      const [par = "", ...atributos] = c.split(";");
      const i = par.indexOf("=");
      const nome = par.slice(0, i);
      const valor = par.slice(i + 1);
      const apagar = atributos.some((a) => a.trim().toLowerCase() === "max-age=0");
      if (apagar || valor === "") this.cookies.delete(nome);
      else this.cookies.set(nome, valor);
    }
    const texto = await r.text();
    return {
      status: r.status,
      texto,
      corpo:
        texto && (r.headers.get("content-type") ?? "").includes("json")
          ? (JSON.parse(texto) as Record<string, unknown>)
          : {},
      cabecalhos: r.headers,
      setCookie,
    };
  }

  post(caminho: string, corpo?: unknown, extra: Parameters<Navegador["chamar"]>[2] = {}) {
    return this.chamar("POST", caminho, { corpo, ...extra });
  }
  get(caminho: string) {
    return this.chamar("GET", caminho);
  }
}

/** Faz o login completo (senha + código do autenticador) pela API, como a tela de login faria. */
export async function entrarNaApi(
  navegador: Navegador,
  email: string,
  segredoTotp: string,
  opcoes: { confirmarSenha?: boolean } = {},
): Promise<void> {
  const etapa1 = await navegador.post("/auth/entrar", { email, senha: SENHA_PADRAO });
  if (etapa1.status !== 200) throw new Error(`login falhou (${etapa1.status})`);
  const codigo = gerarCodigo(segredoTotp, passoDe(Date.now()));
  const etapa2 = await navegador.post("/auth/segundo-fator", { codigo });
  if (etapa2.status !== 200) throw new Error(`segundo fator falhou (${etapa2.status})`);
  if (opcoes.confirmarSenha) {
    const r = await navegador.post("/auth/reautenticar", { segredo: SENHA_PADRAO });
    if (r.status !== 200) throw new Error(`reautenticação falhou (${r.status})`);
  }
}
