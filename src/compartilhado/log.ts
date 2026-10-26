// Log estruturado que não deixa dados de saúde ou dados pessoais passarem.
//
// Regras:
//  - O contexto de cada log só deve levar identificadores opacos (casaId, usuarioId, doseId...).
//  - Chaves proibidas (nome, medicamento, alergia, telefone, senha...) e valores com cara de e-mail
//    ou CPF são removidos da saída.
//  - Em desenvolvimento e teste, uma violação lança erro, para o problema aparecer na hora.
//    Em produção, o log nunca derruba a aplicação: o valor vira "[removido]" e o log segue.
//  - Erros são registrados só com tipo e mensagem, sem pilha nem detalhes do banco.

export type NivelLog = "debug" | "info" | "warn" | "error";

const ORDEM: Record<NivelLog, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Comparadas depois de normalizar a chave: minúsculas e sem acentos, espaços ou símbolos.
const CHAVES_PROIBIDAS = new Set([
  "nome",
  "nomecompleto",
  "sobrenome",
  "email",
  "telefone",
  "celular",
  "cpf",
  "rg",
  "documento",
  "nascimento",
  "datanascimento",
  "endereco",
  "foto",
  "receita",
  "medicamento",
  "principioativo",
  "substancia",
  "alergia",
  "dose",
  "diagnostico",
  "observacao",
  "justificativa",
  "motivo",
  "senha",
  "pin",
  "token",
  "segredo",
  "authorization",
  "cookie",
]);

const PADRAO_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PADRAO_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

const REMOVIDO = "[removido]";
const PROFUNDIDADE_MAXIMA = 5;

export type SaidaLog = (linha: string) => void;

export type OpcoesLogger = {
  saida?: SaidaLog;
  /** Nível mínimo registrado. Padrão: info. */
  nivel?: NivelLog;
  /** Lança erro ao detectar dado proibido. Padrão: ligado fora de produção. */
  modoEstrito?: boolean;
  agora?: () => Date;
};

export type Logger = Record<
  NivelLog,
  (mensagem: string, contexto?: Record<string, unknown>) => void
>;

function normalizarChave(chave: string): string {
  return chave
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Separa "nomeIdoso", "Nome_Idoso" e "data-nascimento" em palavras normalizadas.
function palavrasDaChave(chave: string): string[] {
  return chave
    .replace(/(\p{Ll}|\d)(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(normalizarChave);
}

// Proibida se a chave inteira ou qualquer uma das suas palavras estiver na lista.
// Exceção: chaves compostas terminadas em "id" (doseId, medicamentoId) são identificadores
// opacos e podem ser registradas.
function ehChaveProibida(chave: string): boolean {
  const palavras = palavrasDaChave(chave);
  const ultima = palavras.at(-1);
  if (palavras.length > 1 && (ultima === "id" || ultima === "ids")) return false;
  return (
    CHAVES_PROIBIDAS.has(normalizarChave(chave)) || palavras.some((p) => CHAVES_PROIBIDAS.has(p))
  );
}

function mascararTexto(texto: string): { texto: string; alterado: boolean } {
  const mascarado = texto.replace(PADRAO_EMAIL, REMOVIDO).replace(PADRAO_CPF, REMOVIDO);
  return { texto: mascarado, alterado: mascarado !== texto };
}

export function criarLogger(opcoes: OpcoesLogger = {}): Logger {
  const producao = process.env.NODE_ENV === "production";
  const saida: SaidaLog = opcoes.saida ?? ((linha) => process.stdout.write(`${linha}\n`));
  const minimo = ORDEM[opcoes.nivel ?? "info"];
  const estrito = opcoes.modoEstrito ?? !producao;
  const agora = opcoes.agora ?? (() => new Date());

  function violacao(descricao: string): void {
    if (estrito) throw new Error(`Log com dado proibido: ${descricao}.`);
  }

  function limpar(valor: unknown, caminho: string, profundidade: number): unknown {
    if (typeof valor === "string") {
      const { texto, alterado } = mascararTexto(valor);
      if (alterado) violacao(`valor de "${caminho}" parece e-mail ou CPF`);
      return texto;
    }
    if (valor instanceof Error) {
      return {
        tipo: valor.name,
        mensagem: limpar(valor.message, `${caminho}.mensagem`, profundidade),
      };
    }
    if (valor === null || typeof valor !== "object") return valor;
    if (profundidade >= PROFUNDIDADE_MAXIMA) return "[profundidade excedida]";
    if (Array.isArray(valor)) {
      return valor.map((item, i) => limpar(item, `${caminho}[${i}]`, profundidade + 1));
    }
    const resultado: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor)) {
      const destino = caminho ? `${caminho}.${chave}` : chave;
      if (ehChaveProibida(chave)) {
        violacao(`chave "${destino}"`);
        resultado[chave] = REMOVIDO;
      } else {
        resultado[chave] = limpar(item, destino, profundidade + 1);
      }
    }
    return resultado;
  }

  function registrar(nivel: NivelLog, mensagem: string, contexto: Record<string, unknown> = {}) {
    if (ORDEM[nivel] < minimo) return;
    const { texto: msg, alterado } = mascararTexto(mensagem);
    if (alterado) violacao("a mensagem parece conter e-mail ou CPF");
    const limpo = limpar(contexto, "", 0) as Record<string, unknown>;
    saida(JSON.stringify({ ts: agora().toISOString(), nivel, msg, ...limpo }));
  }

  return {
    debug: (m, c) => registrar("debug", m, c),
    info: (m, c) => registrar("info", m, c),
    warn: (m, c) => registrar("warn", m, c),
    error: (m, c) => registrar("error", m, c),
  };
}

export const log: Logger = criarLogger();
