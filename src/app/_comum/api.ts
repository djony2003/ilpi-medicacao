// Chamadas do tablet à API. Mesma origem: o cookie da sessão e o do aparelho vão sozinhos, e o
// navegador manda o cabeçalho Origin que a API confere nos POST.

export type Resposta<T = Record<string, unknown>> = {
  status: number;
  corpo: T & { erro?: string };
  /** A rede caiu antes de chegar ao servidor. */
  semRede: boolean;
};

export async function chamar<T = Record<string, unknown>>(
  metodo: "GET" | "POST",
  caminho: string,
  corpo?: unknown,
): Promise<Resposta<T>> {
  try {
    const r = await fetch(`/api${caminho}`, {
      method: metodo,
      credentials: "same-origin",
      cache: "no-store",
      headers: corpo !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const tipo = r.headers.get("content-type") ?? "";
    const dados = (tipo.includes("json") ? await r.json() : {}) as T & { erro?: string };
    return { status: r.status, corpo: dados, semRede: false };
  } catch {
    return { status: 0, corpo: {} as T & { erro?: string }, semRede: true };
  }
}

/** Identificador de cada tentativa de registro: reenviar a mesma não duplica nada no servidor. */
export function novaChave(): string {
  return crypto.randomUUID();
}
