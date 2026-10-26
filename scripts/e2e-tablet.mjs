// Teste de ponta a ponta do tablet: `npm run e2e:tablet` com o servidor no ar (`npm run build`
// e `npm start`, ou `npm run dev`). Cria uma casa de demonstração (`npm run demo`), ativa o
// tablet, entra com PIN e percorre os fluxos num Chromium de verdade. A câmera é simulada por um
// canvas que mostra o QR da pulseira ou da etiqueta: o leitor do app decodifica a imagem como faria
// com a câmera do aparelho. As capturas de tela ficam em ./demo/telas.
//
// Variáveis: E2E_URL (padrão http://localhost:3000); ADMIN_DATABASE_URL e DATABASE_URL (para ler os
// códigos da casa criada; só leitura, com o superusuário local de desenvolvimento).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const QRCode = require("qrcode");
const pg = require("pg");

const BASE = process.env.E2E_URL ?? "http://localhost:3000";
const SAIDA = "demo/telas";
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });
const semente = execFileSync("npm", ["run", "--silent", "demo"], { encoding: "utf8" });
const CODIGO = /ativação do tablet: (\S+)/.exec(semente)?.[1];
if (!CODIGO) throw new Error("A demonstração não devolveu o código de ativação.");
const admin = new URL(process.env.ADMIN_DATABASE_URL ?? "");
admin.pathname = new URL(process.env.DATABASE_URL ?? "").pathname;
const URL_DB = admin.toString();

// Códigos da casa de demonstração mais recente.
const db = new pg.Client({ connectionString: URL_DB });
await db.connect();
const casa = (
  await db.query(
    "SELECT id FROM casa WHERE nome LIKE 'Casa de Demonstração%' ORDER BY criada_em DESC NULLS LAST, id LIMIT 1",
  )
).rows[0]?.id;
await db.query("SELECT set_config('app.casa_id', $1, false)", [casa]);
const idosos = Object.fromEntries(
  (await db.query("SELECT nome, codigo_pulseira FROM idoso")).rows.map((r) => [
    r.nome.split(" ")[0],
    `ILPI:I:${r.codigo_pulseira}`,
  ]),
);
const lotes = Object.fromEntries(
  (
    await db.query(
      "SELECT m.nome_comercial, l.codigo_qr FROM lote_estoque l JOIN medicamento m ON m.id = l.medicamento_id",
    )
  ).rows.map((r) => [r.nome_comercial, `ILPI:L:${r.codigo_qr}`]),
);
await db.end();

const qr = async (t) => QRCode.toDataURL(t, { margin: 2, width: 260 });

const navegador = await chromium.launch();
const contexto = await navegador.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
await contexto.addInitScript(() => {
  const tela = document.createElement("canvas");
  tela.width = 640;
  tela.height = 480;
  const ctx = tela.getContext("2d");
  const img = new Image();
  let temImagem = false;
  window.__mostrarQr = (src) => {
    temImagem = false;
    img.onload = () => (temImagem = true);
    img.src = src;
  };
  window.__esconderQr = () => (temImagem = false);
  const desenhar = () => {
    ctx.fillStyle = "#6b7a73";
    ctx.fillRect(0, 0, 640, 480);
    if (temImagem) ctx.drawImage(img, 190, 110, 260, 260);
    requestAnimationFrame(desenhar);
  };
  desenhar();
  navigator.mediaDevices.getUserMedia = async () => tela.captureStream(15);
  navigator.vibrate = () => true;
});
const pagina = await contexto.newPage();
const erros = [];
pagina.on("pageerror", (e) => erros.push(String(e)));
// Respostas 4xx esperadas (PIN errado, aparelho ainda não ativado) aparecem no console como
// "Failed to load resource": não são defeito. Erro de JavaScript, sim.
pagina.on("console", (m) => {
  if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) erros.push(m.text());
});
let conferencias = 0;
pagina.on("request", (r) => r.url().includes("/conferir") && (conferencias += 1));
let n = 0;
const foto = async (nome) =>
  pagina.screenshot({
    path: `${SAIDA}/${String(++n).padStart(2, "0")}-${nome}.png`,
    fullPage: true,
  });
const mostrar = async (texto) => pagina.evaluate((src) => window.__mostrarQr(src), await qr(texto));
const esconder = () => pagina.evaluate(() => window.__esconderQr());
const pin = async (digitos) => {
  for (const d of digitos)
    await pagina.locator(".pin__tecla", { hasText: new RegExp(`^${d}$`) }).click();
  await pagina.locator(".pin .botao--principal").click();
};

try {
  await pagina.goto(`${BASE}/tablet`);
  await pagina.getByText("Ativar este tablet").waitFor();
  await foto("ativar");
  await pagina.getByLabel("Código de ativação").fill(CODIGO);
  await pagina.getByRole("button", { name: "Ativar" }).click();
  await pagina.getByText("Quem vai usar o tablet?").waitFor();
  await foto("quem");
  await pagina.getByRole("button", { name: "Ana (cuidadora)" }).click();
  await foto("pin");
  await pin("731946");
  await pagina.getByText("Escala do plantão").waitFor();
  await pagina.waitForTimeout(500);
  await foto("escala");

  // 1. Aparecida: pulseira errada, depois a certa, etiqueta, registro.
  await pagina.locator(".dose", { hasText: "Aparecida" }).first().click();
  await pagina.getByText("Leia a pulseira do paciente").waitFor();
  await mostrar(idosos.Benedito);
  await pagina.getByText("Esta pulseira é de outro paciente").waitFor({ timeout: 15000 });
  await esconder();
  await foto("pulseira-errada");
  await mostrar(idosos.Aparecida);
  await pagina.getByText("Paciente confere").waitFor({ timeout: 15000 });
  await esconder();
  await foto("paciente-confere");
  await mostrar(lotes.Losartana);
  await pagina.getByText("Remédio confere").waitFor({ timeout: 15000 });
  await esconder();
  await foto("remedio-confere");
  await pagina.getByRole("button", { name: /Dei o remédio/ }).click();
  await pagina.getByText("Registrado").waitFor();
  await foto("registrado");
  await pagina.getByRole("button", { name: "Voltar para a escala" }).click();

  // 2. Benedito, Varfarina (alto risco): segunda validação pelo Bruno.
  await pagina.locator(".dose", { hasText: "Varfarina" }).first().click();
  await mostrar(idosos.Benedito);
  await pagina.getByText("Paciente confere").waitFor({ timeout: 15000 });
  await esconder();
  await mostrar(lotes.Metformina);
  await pagina
    .getByText("Este medicamento não está prescrito para este horário")
    .waitFor({ timeout: 15000 });
  await esconder();
  await foto("remedio-errado");
  await mostrar(lotes.Varfarina);
  await pagina.getByText("Remédio confere").waitFor({ timeout: 15000 });
  await esconder();
  await pagina.getByRole("button", { name: /Dei o remédio/ }).click();
  await pagina.getByText("Segunda validação").waitFor();
  await foto("segunda-validacao");
  await pagina.getByRole("button", { name: /Bruno/ }).click();
  await pin("111111");
  await pagina.getByText("PIN não confere").waitFor();
  await foto("pin-errado-colega");
  await pin("582417");
  await pagina.getByText("Registrado").waitFor();
  await pagina.getByRole("button", { name: "Voltar para a escala" }).click();

  // 3. Celina: alergia cadastrada depois da prescrição bloqueia, já na leitura da pulseira.
  await pagina.locator(".dose", { hasText: "Celina" }).first().click();
  await mostrar(idosos.Celina);
  await pagina.getByText("Alerta: alergia registrada").waitFor({ timeout: 15000 });
  await esconder();
  await foto("alergia");
  await pagina.getByRole("button", { name: "Paciente recusou" }).first().click();
  await pagina.getByRole("button", { name: "← Escala" }).click();

  // 4. SOS para Aparecida.
  await pagina.getByRole("button", { name: "Dose se necessário" }).click();
  await mostrar(idosos.Aparecida);
  await pagina.getByText("Qual remédio?").waitFor({ timeout: 15000 });
  await esconder();
  await foto("sos-escolher");
  await pagina.locator(".sos__opcao").first().click();
  await mostrar(lotes.Paracetamol);
  await pagina.getByText("Por que o paciente precisa agora?").waitFor({ timeout: 15000 });
  await esconder();
  await pagina.getByRole("button", { name: /confirmar/ }).click();
  await pagina.getByText("Registrado").waitFor();
  await foto("sos-registrado");
  await pagina.getByRole("button", { name: "Voltar para a escala" }).click();
  await pagina.waitForTimeout(500);
  await foto("escala-depois");

  // 5. Sem conexão: o aviso aparece e os cartões ficam bloqueados.
  await contexto.setOffline(true);
  await pagina.evaluate(() => window.dispatchEvent(new Event("offline")));
  await pagina.getByText("Novos registros estão bloqueados").waitFor();
  await foto("sem-conexao");
  await contexto.setOffline(false);
} catch (e) {
  await foto("FALHA");
  console.error("FALHA:", String(e).split("\n")[0]);
  process.exitCode = 1;
}
await navegador.close();
console.log(JSON.stringify({ telas: n, conferencias, erros }, null, 2));
// Cada leitura gera uma conferência: dezenas aqui seriam o leitor relendo o mesmo QR sem parar.
if (conferencias > 20) {
  console.error(`Conferências demais (${conferencias}): o leitor está relendo o mesmo código.`);
  process.exitCode = 1;
}
if (erros.length > 0) process.exitCode = 1;
