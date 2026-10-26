// Regra local: um módulo só pode ser importado pelo seu index.
//
// - Arquivos dentro de src/modules/<A> podem importar qualquer coisa do próprio módulo A.
// - Qualquer outro arquivo (outro módulo, src/app, src/worker, tests) só pode importar
//   de src/modules/<B> ou src/modules/<B>/index, nunca de subpastas ou arquivos internos.
//
// Funciona para imports com alias "@/..." (mapeado para src/) e para imports relativos.

import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "..");
const SRC = path.join(RAIZ, "src");
const MODULOS = path.join(SRC, "modules");

function resolverImport(origem, arquivo) {
  if (origem.startsWith("@/")) return path.join(SRC, origem.slice(2));
  if (origem.startsWith(".")) return path.resolve(path.dirname(arquivo), origem);
  return null; // pacote externo
}

// Devolve { modulo, resto } se o caminho estiver dentro de src/modules/<modulo>.
function localizarModulo(caminho) {
  const relativo = path.relative(MODULOS, caminho);
  if (relativo === "" || relativo.startsWith("..") || path.isAbsolute(relativo)) return null;
  const [modulo, ...partes] = relativo.split(path.sep);
  return { modulo, resto: partes.join("/") };
}

const regra = {
  meta: {
    type: "problem",
    docs: {
      description: "Módulos só podem ser importados pelo index público",
    },
    messages: {
      internoDeOutroModulo:
        "Importe de '@/modules/{{modulo}}' (index público), não de arquivos internos do módulo.",
    },
    schema: [],
  },
  create(contexto) {
    const arquivo = contexto.filename;
    const doArquivo = localizarModulo(path.resolve(arquivo));

    function verificar(no, origem) {
      if (typeof origem !== "string") return;
      const destino = resolverImport(origem, arquivo);
      if (!destino) return;
      const doDestino = localizarModulo(destino);
      if (!doDestino) return;
      if (doArquivo && doArquivo.modulo === doDestino.modulo) return;
      const ehIndex =
        doDestino.resto === "" || doDestino.resto === "index" || doDestino.resto === "index.ts";
      if (ehIndex) return;
      contexto.report({
        node: no,
        messageId: "internoDeOutroModulo",
        data: { modulo: doDestino.modulo },
      });
    }

    return {
      ImportDeclaration: (no) => verificar(no, no.source.value),
      ExportNamedDeclaration: (no) => no.source && verificar(no, no.source.value),
      ExportAllDeclaration: (no) => verificar(no, no.source.value),
      ImportExpression: (no) => no.source.type === "Literal" && verificar(no, no.source.value),
    };
  },
};

const plugin = {
  rules: { "fronteiras-de-modulo": regra },
};

export default plugin;
