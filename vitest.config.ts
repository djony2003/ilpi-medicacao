import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    globalSetup: ["tests/configuracao/global-setup.ts"],
    // Os testes de integração compartilham um único banco; rodar um arquivo por vez
    // evita que um teste interfira nas tabelas temporárias de outro.
    fileParallelism: false,
  },
});
