// Teste de ponta a ponta do painel de alertas: `npm run e2e:painel` com o servidor no ar.
// Cria uma casa de demonstração (`npm run demo`), entra no computador como a enfermeira (configura o
// autenticador a partir da chave mostrada na tela e troca a senha provisória), confere os alertas,
// marca como lido, encerra um com justificativa e confere os alertas também no tablet.
// Capturas em ./demo/telas-painel.
//
// Variáveis: E2E_URL (padrão http://localhost:3000).

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.E2E_URL ?? "http://localhost:3000";
const SAIDA = "demo/telas-painel";
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });

const semente = execFileSync("npm", ["run", "--silent", "demo"], { encoding: "utf8" });
const EMAIL = /\(\/entrar\): (\S+),/.exec(semente)?.[1];
const SENHA = /senha provisória (\S+)/.exec(semente)?.[1];
const CODIGO_TABLET = /ativação do tablet: (\S+)/.exec(semente)?.[1];
if (!EMAIL || !SENHA || !CODIGO_TABLET) throw new Error("A demonstração não devolveu os acessos.");

/** Código TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) a partir da chave em base32. */
function totp(base32, deslocamento = 0) {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/\s/g, "").toUpperCase())
    bits += alfabeto.indexOf(ch).toString(2).padStart(5, "0");
  const chave = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + deslocamento));
  const h = createHmac("sha1", chave).update(contador).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const navegador = await chromium.launch();
const erros = [];
let n = 0;
let ultima = null;
const comPagina = async (largura, altura) => {
  const contexto = await navegador.newContext({ viewport: { width: largura, height: altura } });
  const pagina = await contexto.newPage();
  ultima = pagina;
  pagina.on("pageerror", (e) => erros.push(String(e)));
  pagina.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource"))
      erros.push(m.text());
  });
  return pagina;
};

try {
  // ------------------------------------------------------------------ computador
  const p = await comPagina(1280, 860);
  const foto = (nome) =>
    p.screenshot({ path: `${SAIDA}/${String(++n).padStart(2, "0")}-${nome}.png`, fullPage: true });
  await p.goto(`${BASE}/entrar`);
  await p.getByLabel("E-mail").fill(EMAIL);
  await p.getByLabel("Senha").fill(SENHA);
  await foto("entrar");
  await p.getByRole("button", { name: "Continuar" }).click();
  await p.getByText("Configure o autenticador").waitFor();
  await foto("configurar-autenticador");
  const chave = await p.locator(".entrada__segredo code").innerText();
  await p.getByLabel("Código").fill(totp(chave));
  await p.getByRole("button", { name: "Entrar" }).click();
  await p.getByText("Crie a sua senha").waitFor();
  await p.getByLabel("Nova senha").fill("girassol na janela do posto 2026");
  await foto("trocar-senha");
  await p.getByRole("button", { name: "Salvar e entrar" }).click();
  await p.getByRole("heading", { name: "Alertas" }).waitFor();
  await p.locator(".alerta").first().waitFor();
  await foto("painel");
  const cartoes = await p.locator(".alerta").count();
  const primeiro = await p.locator(".alerta").first().innerText();
  if (cartoes !== 2 || !primeiro.includes("Urgente") || !primeiro.includes("Varfarina")) {
    throw new Error(
      `Esperava 2 alertas, o urgente da Varfarina primeiro. Veio ${cartoes}: ${primeiro}`,
    );
  }
  await p.locator(".alerta").first().getByRole("button", { name: "Marcar como lido" }).click();
  await p.getByText(/Lido por Carla/).waitFor();
  const dipirona = p.locator(".alerta", { hasText: "Dipirona" });
  await dipirona.getByRole("button", { name: "Encerrar" }).click();
  await dipirona.getByLabel("Como foi tratado").fill("Lote separado para usar primeiro");
  await foto("encerrar");
  await dipirona.getByRole("button", { name: "Encerrar alerta" }).click();
  await p.locator(".alerta", { hasText: "Dipirona" }).waitFor({ state: "detached" });
  await p.getByRole("tab", { name: "Resolvidos" }).click();
  await p.getByText("“Lote separado para usar primeiro”", { exact: false }).waitFor();
  await foto("resolvidos");

  // ------------------------------------------------------------------ tablet (enfermeira)
  const t = await comPagina(1280, 800);
  const fotoT = (nome) =>
    t.screenshot({ path: `${SAIDA}/${String(++n).padStart(2, "0")}-${nome}.png`, fullPage: true });
  await t.goto(`${BASE}/tablet`);
  await t.getByLabel("Código de ativação").fill(CODIGO_TABLET);
  await t.getByRole("button", { name: "Ativar" }).click();
  await t.getByRole("button", { name: "Carla (enfermeira)" }).click();
  for (const d of "264839")
    await t.locator(".pin__tecla", { hasText: new RegExp(`^${d}$`) }).click();
  await t.locator(".pin .botao--principal").click();
  await t.getByText("Escala do plantão").waitFor();
  await t.getByRole("button", { name: /Alertas/ }).waitFor();
  await fotoT("tablet-escala-enfermeira");
  await t.getByRole("button", { name: /Alertas/ }).click();
  await t.locator(".alerta").first().waitFor();
  await fotoT("tablet-alertas");
} catch (e) {
  await ultima?.screenshot({ path: `${SAIDA}/FALHA.png`, fullPage: true });
  console.error("FALHA:", String(e).split("\n")[0]);
  process.exitCode = 1;
}
await navegador.close();
console.log(JSON.stringify({ telas: n, erros }, null, 2));
if (erros.length > 0) process.exitCode = 1;
