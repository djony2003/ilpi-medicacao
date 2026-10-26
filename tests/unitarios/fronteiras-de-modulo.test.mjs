import path from "node:path";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import plugin from "../../eslint-rules/fronteiras-de-modulo.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const raiz = path.resolve(import.meta.dirname, "../..");
const arq = (caminho) => path.join(raiz, caminho);

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

const erro = (modulo) => ({
  messageId: "internoDeOutroModulo",
  data: { modulo },
});

tester.run("fronteiras-de-modulo", plugin.rules["fronteiras-de-modulo"], {
  valid: [
    // pelo index público, com alias
    {
      code: 'import { x } from "@/modules/estoque";',
      filename: arq("src/modules/administracao/dominio/a.js"),
    },
    { code: 'import { x } from "@/modules/estoque/index";', filename: arq("src/app/pagina.js") },
    // dentro do mesmo módulo, qualquer caminho
    {
      code: 'import { x } from "../dados/consulta";',
      filename: arq("src/modules/estoque/dominio/a.js"),
    },
    {
      code: 'import { x } from "@/modules/estoque/dados/consulta";',
      filename: arq("src/modules/estoque/api/a.js"),
    },
    // pacotes externos e código compartilhado
    { code: 'import pg from "pg";', filename: arq("src/modules/estoque/dados/a.js") },
    {
      code: 'import { x } from "@/compartilhado/banco/transacao";',
      filename: arq("src/modules/estoque/dados/a.js"),
    },
    // relativo para o index de outro módulo
    {
      code: 'import { x } from "../../estoque";',
      filename: arq("src/modules/administracao/dominio/a.js"),
    },
  ],
  invalid: [
    {
      code: 'import { x } from "@/modules/estoque/dados/consulta";',
      filename: arq("src/modules/administracao/dominio/a.js"),
      errors: [erro("estoque")],
    },
    {
      code: 'import { x } from "../../estoque/dominio/saldo";',
      filename: arq("src/modules/administracao/dominio/a.js"),
      errors: [erro("estoque")],
    },
    {
      code: 'import { x } from "@/modules/prescricoes/dominio/regras";',
      filename: arq("src/app/pagina.js"),
      errors: [erro("prescricoes")],
    },
    {
      code: 'export { x } from "@/modules/auditoria/dados/escrita";',
      filename: arq("src/worker/job.js"),
      errors: [erro("auditoria")],
    },
    {
      code: 'const m = await import("@/modules/estoque/dados/consulta");',
      filename: arq("src/modules/administracao/api/a.js"),
      errors: [erro("estoque")],
    },
    {
      code: 'import { x } from "@/modules/estoque/dominio/saldo";',
      filename: arq("tests/integracao/a.js"),
      errors: [erro("estoque")],
    },
  ],
});
