import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import fronteiras from "./eslint-rules/fronteiras-de-modulo.mjs";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "node_modules/**",
    "next-env.d.ts",
  ]),
  {
    plugins: { ilpi: fronteiras },
    rules: {
      // Módulos só se conhecem pelo index público (ver .10x/decisions/staff-engineer).
      "ilpi/fronteiras-de-modulo": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    // Scripts de linha de comando escrevem na saída padrão por natureza.
    files: ["scripts/**"],
    rules: { "no-console": "off" },
  },
]);
