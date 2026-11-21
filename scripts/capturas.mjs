// Capturas de tela da casa fictícia grande (celular e tablet): `node scripts/capturas.mjs` com o
// servidor no ar. Saída em ./demo/capturas. Só para olhar o visual; não testa nada.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.E2E_URL ?? "http://localhost:3000";
const SAIDA = "demo/capturas";
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });

const texto = execFileSync("npm", ["run", "--silent", "demo:grande"], { encoding: "utf8" });
const tablet = /Tablet Ala A\s+(\S+)/.exec(texto)[1];
const gestora =
  /gestora \S+\s+comercial\s+e-mail (\S+)/.exec(texto)?.[1] ??
  /e-mail (gestora-\S+)/.exec(texto)[1];
const SENHA = "provisoria-da-demonstracao";
const NOVA = "girassol na janela do posto 2026";

function totp(base32) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/\s/g, "").toUpperCase())
    bits += a.indexOf(ch).toString(2).padStart(5, "0");
  const chave = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", chave).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const nav = await chromium.launch();
let n = 0;
const foto = (p, nome) =>
  p.screenshot({ path: `${SAIDA}/${String(++n).padStart(2, "0")}-${nome}.png`, fullPage: false });

// ---- celular: painel da gestora
const cel = await nav.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const p = await cel.newPage();
await p.goto(`${BASE}/entrar`);
await p.getByLabel("E-mail").fill(gestora);
await p.getByLabel("Senha").fill(SENHA);
await p.getByRole("button", { name: "Continuar" }).click();
await p.getByText("Configure o autenticador").waitFor();
const chave = await p.locator(".entrada__segredo code").innerText();
await p.getByLabel("Código").fill(totp(chave));
await p.getByRole("button", { name: "Entrar" }).click();
await p.getByText("Crie a sua senha").waitFor();
await p.getByLabel("Nova senha").fill(NOVA);
await p.getByRole("button", { name: "Salvar e entrar" }).click();
await p.waitForURL(/painel/);
await p.waitForTimeout(1200);
await foto(p, "celular-alertas");
for (const [rota, nome] of [
  ["residentes", "residentes"],
  ["remedios", "remedios"],
  ["estoque", "estoque"],
  ["equipe", "equipe"],
]) {
  await p.goto(`${BASE}/painel/${rota}`);
  await p.waitForTimeout(1500);
  await foto(p, `celular-${nome}`);
}
await p.goto(`${BASE}/painel/residentes`);
await p.waitForTimeout(1200);
await p.locator("a[href*='/painel/residentes/']").first().click();
await p.waitForTimeout(1800);
await foto(p, "celular-ficha");
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(300);
await foto(p, "celular-ficha-prescricoes");

// ---- tablet: escala do plantão
const tab = await nav.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1.5,
  hasTouch: true,
});
const t = await tab.newPage();
await t.goto(`${BASE}/tablet`);
await t.getByText("Ativar este tablet").waitFor();
await t.getByLabel("Código de ativação").fill(tablet);
await t.getByRole("button", { name: "Ativar" }).click();
await t.getByText("Quem vai usar o tablet?").waitFor();
await foto(t, "tablet-quem");
await t.getByRole("button", { name: /Ana Lima/ }).click();
for (const d of "915372") await t.locator(".pin__tecla", { hasText: new RegExp(`^${d}$`) }).click();
await t.locator(".pin .botao--principal").click();
await t.getByText("Escala do plantão").waitFor();
await t.waitForTimeout(1500);
await foto(t, "tablet-escala");
await nav.close();
console.log(`Capturas em ${SAIDA}`);
