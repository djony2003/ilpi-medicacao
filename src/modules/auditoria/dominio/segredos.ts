// A auditoria guarda "antes" e "depois" das alterações, que podem conter dados de saúde (isso é
// esperado). O que NUNCA pode entrar são segredos: senhas, PINs, tokens e seus hashes.
//
// A regra olha as palavras da chave (senha_hash, pinHash, token...). Um valor booleano ou nulo é
// aceito, porque descreve um estado ("pin_trocar": true) e não um segredo.

const PALAVRAS_DE_SEGREDO = new Set([
  "senha",
  "pin",
  "hash",
  "token",
  "segredo",
  "totp",
  "cookie",
  "authorization",
  "secret",
  "password",
]);

function palavras(chave: string): string[] {
  return chave
    .replace(/(\p{Ll}|\d)(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((p) => p.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase());
}

function ehChaveDeSegredo(chave: string): boolean {
  return palavras(chave).some((p) => PALAVRAS_DE_SEGREDO.has(p));
}

/** Devolve o caminho da primeira chave de segredo com valor sensível, ou null se estiver limpo. */
export function acharSegredo(valor: unknown, caminho = ""): string | null {
  if (valor === null || typeof valor !== "object") return null;
  if (Array.isArray(valor)) {
    for (const [i, item] of valor.entries()) {
      const achado = acharSegredo(item, `${caminho}[${i}]`);
      if (achado) return achado;
    }
    return null;
  }
  for (const [chave, item] of Object.entries(valor)) {
    const destino = caminho ? `${caminho}.${chave}` : chave;
    const ehEstado = item === null || typeof item === "boolean";
    if (ehChaveDeSegredo(chave) && !ehEstado) return destino;
    const achado = acharSegredo(item, destino);
    if (achado) return achado;
  }
  return null;
}
