import { z } from "zod";

// Leitura validada das variáveis de ambiente. A aplicação falha na inicialização, com mensagem
// clara, se algo estiver errado, em vez de falhar no meio de uma requisição.
//
// As mensagens de erro citam apenas o NOME da variável, nunca o valor, porque o valor pode ser
// um segredo.

const urlPostgres = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "deve começar com postgres:// ou postgresql://");

const esquema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: urlPostgres,
    LOG_NIVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    // Origem pública do site (esquema + domínio, sem barra no fim), usada na defesa contra CSRF
    // quando a aplicação roda atrás de um proxy. Ex.: https://app.casa.exemplo
    APP_ORIGEM: z
      .string()
      .optional()
      .refine((v) => {
        if (!v) return true;
        try {
          return new URL(v).origin === v;
        } catch {
          return false;
        }
      }, "deve ser só a origem, como https://app.casa.exemplo (sem caminho nem barra no fim)"),
    // Pasta do armazenamento privado de arquivos (receitas) enquanto não há provedor de nuvem.
    ARMAZENAMENTO_DIR: z.string().min(1).default(".armazenamento"),
    // Chave de 32 bytes em base64 para criptografar campos sensíveis (ex.: segredo do TOTP).
    CHAVE_CAMPOS: z
      .string()
      .min(1)
      .refine((v) => Buffer.from(v, "base64").length === 32, "deve ter 32 bytes em base64"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    // Em produção a aplicação nunca deve conectar como superusuário.
    let usuario = "";
    try {
      usuario = decodeURIComponent(new URL(env.DATABASE_URL).username);
    } catch {
      return; // URL malformada já é apontada pela validação anterior
    }
    if (usuario === "postgres") {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "em produção deve usar o papel da aplicação, não o superusuário",
      });
    }
  });

export type Ambiente = z.infer<typeof esquema>;

export class ErroDeAmbiente extends Error {
  constructor(public readonly problemas: string[]) {
    super(`Configuração de ambiente inválida:\n- ${problemas.join("\n- ")}`);
    this.name = "ErroDeAmbiente";
  }
}

export function lerAmbiente(origem: Record<string, string | undefined> = process.env): Ambiente {
  const resultado = esquema.safeParse(origem);
  if (resultado.success) return resultado.data;
  const problemas = resultado.error.issues.map(
    (problema) => `${problema.path.join(".") || "(geral)"}: ${problema.message}`,
  );
  throw new ErroDeAmbiente(problemas);
}

let cache: Ambiente | undefined;

/** Ambiente da aplicação, lido e validado uma única vez. */
export function ambiente(): Ambiente {
  cache ??= lerAmbiente();
  return cache;
}
