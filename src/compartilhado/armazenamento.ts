import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

// Armazenamento de objetos PRIVADO (nada é servido direto ao navegador). A aplicação cifra o
// conteúdo antes de gravar, então quem tem acesso só ao armazenamento não lê as receitas.
// Em produção entra um provedor de nuvem atrás da mesma interface (decisão pendente, marco M8).

export interface Armazenamento {
  gravar(chave: string, bytes: Uint8Array): Promise<void>;
  /** Null se o objeto não existe. */
  ler(chave: string): Promise<Uint8Array | null>;
  apagar(chave: string): Promise<void>;
}

const CHAVE_VALIDA = /^[a-z0-9][a-z0-9/_-]{18,198}[a-z0-9]$/;

export function chaveValida(chave: string): boolean {
  return CHAVE_VALIDA.test(chave) && !chave.includes("//") && !chave.includes("..");
}

function exigirChave(chave: string): void {
  if (!chaveValida(chave)) throw new Error("Chave de armazenamento inválida.");
}

/** Para desenvolvimento e testes: grava em uma pasta local fora do repositório público. */
export class ArmazenamentoEmDisco implements Armazenamento {
  private readonly raiz: string;
  constructor(raiz: string) {
    this.raiz = resolve(raiz);
  }

  private caminho(chave: string): string {
    exigirChave(chave);
    const alvo = resolve(this.raiz, chave);
    // Defesa em profundidade contra travessia de diretório, além da validação da chave.
    if (!alvo.startsWith(this.raiz + sep)) throw new Error("Chave de armazenamento inválida.");
    return alvo;
  }

  async gravar(chave: string, bytes: Uint8Array): Promise<void> {
    const alvo = this.caminho(chave);
    await mkdir(dirname(alvo), { recursive: true });
    await writeFile(alvo, bytes, { flag: "wx", mode: 0o600 });
  }

  async ler(chave: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.caminho(chave));
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw erro;
    }
  }

  async apagar(chave: string): Promise<void> {
    await rm(this.caminho(chave), { force: true });
  }
}

export class ArmazenamentoEmMemoria implements Armazenamento {
  readonly objetos = new Map<string, Uint8Array>();
  falharNaGravacao = false;

  async gravar(chave: string, bytes: Uint8Array): Promise<void> {
    exigirChave(chave);
    if (this.falharNaGravacao) throw new Error("falha simulada de armazenamento");
    if (this.objetos.has(chave)) throw new Error("objeto já existe");
    this.objetos.set(chave, Uint8Array.from(bytes));
  }
  async ler(chave: string): Promise<Uint8Array | null> {
    exigirChave(chave);
    return this.objetos.get(chave) ?? null;
  }
  async apagar(chave: string): Promise<void> {
    this.objetos.delete(chave);
  }
}
