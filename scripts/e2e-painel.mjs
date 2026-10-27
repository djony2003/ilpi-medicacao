// Teste de ponta a ponta do painel: `npm run e2e:painel` com o servidor no ar.
// Cria uma casa de demonstração (`npm run demo`), entra no computador como a enfermeira (configura o
// autenticador a partir da chave mostrada na tela e troca a senha provisória), confere os alertas,
// marca como lido, encerra um com justificativa, mexe na ficha de um residente e confere os alertas
// também no tablet. Depois entra como gestor: exceções, auditoria (filtro, planilha, integridade),
// configurações e a exportação dos dados de um residente (com a senha confirmada).
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
const EMAIL_GESTAO = /Gestão \(\/entrar\): (\S+),/.exec(semente)?.[1];
if (!EMAIL || !SENHA || !CODIGO_TABLET || !EMAIL_GESTAO)
  throw new Error("A demonstração não devolveu os acessos.");
const NOVA_SENHA = "girassol na janela do posto 2026";

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

/** Primeiro acesso: senha provisória, autenticador (lido da tela), troca de senha. */
async function entrarNoPainel(p, email, foto) {
  await p.goto(`${BASE}/entrar`);
  await p.getByLabel("E-mail").fill(email);
  await p.getByLabel("Senha").fill(SENHA);
  await foto("entrar");
  await p.getByRole("button", { name: "Continuar" }).click();
  await p.getByText("Configure o autenticador").waitFor();
  const chave = await p.locator(".entrada__segredo code").innerText();
  await p.getByLabel("Código").fill(totp(chave));
  await p.getByRole("button", { name: "Entrar" }).click();
  await p.getByText("Crie a sua senha").waitFor();
  await p.getByLabel("Nova senha").fill(NOVA_SENHA);
  await p.getByRole("button", { name: "Salvar e entrar" }).click();
}

/** Clica e espera o arquivo; se pedirem a senha, digita. Devolve o conteúdo do arquivo. */
async function baixarComSenha(p, clicar) {
  const download = p.waitForEvent("download", { timeout: 15_000 });
  await clicar();
  const dialogo = p.getByRole("dialog");
  if (
    await dialogo.waitFor({ state: "visible", timeout: 3000 }).then(
      () => true,
      () => false,
    )
  ) {
    await dialogo.getByLabel("Senha").fill(NOVA_SENHA);
    await dialogo.getByRole("button", { name: "Confirmar" }).click();
  }
  const arquivo = await download;
  const caminho = await arquivo.path();
  const { readFileSync } = await import("node:fs");
  return { nome: arquivo.suggestedFilename(), conteudo: readFileSync(caminho) };
}

function exigir(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
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
  await entrarNoPainel(p, EMAIL, foto);
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

  // A enfermagem vê Alertas e Residentes; Exceções, Auditoria e Configurações são da gestão.
  const menu = await p.getByRole("navigation", { name: "Seções do painel" }).innerText();
  exigir(menu.includes("Residentes") && !menu.includes("Auditoria"), `Menu da enfermeira: ${menu}`);
  await p.goto(`${BASE}/painel/auditoria`);
  await p.getByText("Esta tela é só da gestão da casa.").waitFor();

  // Ficha de um residente: nova alergia, contato e pulseira em PDF.
  await p.getByRole("link", { name: "Residentes" }).click();
  await p.getByRole("link", { name: "Aparecida Souza" }).click();
  await p.getByRole("heading", { name: "Aparecida Souza" }).waitFor();
  await p.getByLabel("Substância").fill("Penicilina");
  await p.getByLabel("Gravidade").selectOption("grave");
  await p.getByRole("button", { name: "Registrar alergia" }).click();
  await p.getByText("Alergia registrada.").waitFor();
  await p.locator(".lista-simples li", { hasText: "Penicilina" }).waitFor();
  await p.getByLabel("Nome", { exact: true }).fill("Marta Souza");
  await p.getByLabel("Parentesco").fill("filha");
  await p.getByLabel("Telefone").fill("(11) 98765-4321");
  await p.getByRole("button", { name: "Adicionar contato" }).click();
  await p.getByText("Contato adicionado.").waitFor();
  await foto("ficha-do-residente");
  const pulseira = await baixarComSenha(p, () =>
    p.getByRole("button", { name: "Gerar pulseira (PDF)" }).click(),
  );
  exigir(pulseira.conteudo.subarray(0, 5).toString() === "%PDF-", "A pulseira não veio em PDF.");
  exigir(
    (await p.getByRole("button", { name: /Exportar todos os dados/ }).count()) === 0,
    "A enfermeira não deveria ver a exportação LGPD.",
  );

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

  // ------------------------------------------------------------------ computador (gestor)
  const g = await comPagina(1280, 860);
  const fotoG = (nome) =>
    g.screenshot({ path: `${SAIDA}/${String(++n).padStart(2, "0")}-${nome}.png`, fullPage: true });
  await entrarNoPainel(g, EMAIL_GESTAO, fotoG);
  await g.getByRole("heading", { name: "Alertas" }).waitFor();
  const menuG = await g.getByRole("navigation", { name: "Seções do painel" }).innerText();
  for (const item of ["Exceções", "Auditoria", "Configurações"])
    exigir(menuG.includes(item), `Menu da gestão sem ${item}: ${menuG}`);

  // Exceções: nenhuma ainda; o relatório exporta com a senha.
  await g.getByRole("link", { name: "Exceções" }).click();
  await g.getByRole("heading", { name: "Exceções de conferência" }).waitFor();
  await g.getByText("Nenhuma exceção neste período.").waitFor();
  await fotoG("excecoes");
  const relatorio = await baixarComSenha(g, () =>
    g.getByRole("button", { name: "Exportar planilha" }).click(),
  );
  exigir(relatorio.nome === "excecoes-de-conferencia.csv", `Nome do arquivo: ${relatorio.nome}`);
  exigir(relatorio.conteudo.toString("utf8").includes("Data e hora;Residente"), "CSV de exceções");

  // Auditoria: filtro por assunto, planilha, PDF e integridade da cadeia.
  await g.getByRole("link", { name: "Auditoria" }).click();
  await g.getByRole("heading", { name: "Auditoria" }).waitFor();
  await g.locator("tbody tr").first().waitFor();
  await g.getByLabel("Assunto").selectOption({ label: "Entradas no sistema" });
  await g.getByRole("button", { name: "Consultar" }).click();
  await g.getByText("Entrou no sistema").first().waitFor();
  const linhasDeLogin = await g.locator("tbody tr").count();
  exigir(linhasDeLogin >= 1, "Auditoria sem a entrada do gestor.");
  const textoDaTabela = await g.locator("tbody").innerText();
  exigir(!textoDaTabela.includes("Dose registrada"), "O filtro de assunto não filtrou.");
  await fotoG("auditoria");
  const trilha = await baixarComSenha(g, () =>
    g.getByRole("button", { name: "Exportar planilha" }).click(),
  );
  exigir(trilha.conteudo.toString("utf8").includes("login.sucesso"), "CSV da trilha sem login.");
  const trilhaPdf = await baixarComSenha(g, () =>
    g.getByRole("button", { name: "Exportar PDF" }).click(),
  );
  exigir(trilhaPdf.conteudo.subarray(0, 5).toString() === "%PDF-", "A trilha não veio em PDF.");
  await g.getByRole("button", { name: "Verificar integridade" }).click();
  await g.getByText("A cadeia de registros está íntegra").waitFor();
  // As exportações ficaram na própria trilha.
  await g.getByLabel("Assunto").selectOption({ label: "Auditoria" });
  await g.getByRole("button", { name: "Consultar" }).click();
  await g.getByText("Auditoria exportada").first().waitFor();

  // Configurações: muda a janela de horário (com a senha) e confere que ficou.
  await g.getByRole("link", { name: "Configurações" }).click();
  await g.getByRole("heading", { name: "Configurações" }).waitFor();
  await g.getByLabel("Janela de tolerância (minutos)").waitFor();
  await g.getByLabel("Janela de tolerância (minutos)").fill("20");
  await g.getByLabel("Limite maior (minutos)").fill("45");
  await g.getByRole("button", { name: "Salvar a janela" }).click();
  const dialogoG = g.getByRole("dialog");
  if (
    await dialogoG.waitFor({ state: "visible", timeout: 3000 }).then(
      () => true,
      () => false,
    )
  ) {
    await dialogoG.getByLabel("Senha").fill(NOVA_SENHA);
    await dialogoG.getByRole("button", { name: "Confirmar" }).click();
  }
  await g.getByText("Salvo. A mudança ficou registrada na trilha.").first().waitFor();
  await g.getByLabel("Prazo da reposição (dias)").fill("10");
  await g.getByRole("button", { name: "Salvar os alertas" }).click();
  await g.getByText("Salvo. A mudança ficou registrada na trilha.").nth(0).waitFor();
  await fotoG("configuracoes");
  await g.reload();
  await g.getByLabel("Janela de tolerância (minutos)").waitFor();
  exigir(
    (await g.getByLabel("Janela de tolerância (minutos)").inputValue()) === "20",
    "A janela não ficou salva.",
  );
  exigir(
    (await g.getByLabel("Prazo da reposição (dias)").inputValue()) === "10",
    "O prazo de reposição não ficou salvo.",
  );
  // Janela maior que o limite é recusada pelo servidor, com a explicação.
  await g.getByLabel("Janela de tolerância (minutos)").fill("60"); // maior que o limite (45)
  await g.getByRole("button", { name: "Salvar a janela" }).click();
  await g.locator(".aviso--erro").first().waitFor();

  // Residente: a gestão exporta todos os dados (LGPD).
  await g.getByRole("link", { name: "Residentes" }).click();
  await g.getByRole("link", { name: "Aparecida Souza" }).click();
  await g.getByRole("heading", { name: "Aparecida Souza" }).waitFor();
  await g.getByText("Penicilina").first().waitFor();
  const exportacao = await baixarComSenha(g, () =>
    g.getByRole("button", { name: /Exportar todos os dados/ }).click(),
  );
  const dados = JSON.parse(exportacao.conteudo.toString("utf8"));
  exigir(dados.residente.nome === "Aparecida Souza", "Exportação sem o residente.");
  exigir(
    dados.alergias.some((a) => a.substancia === "Penicilina") &&
      dados.contatosDeEmergencia.some((c) => c.nome === "Marta Souza"),
    "Exportação sem a alergia e o contato novos.",
  );
  exigir(
    !/codigo_pulseira|codigoPulseira/.test(exportacao.conteudo.toString("utf8")),
    "Credencial vazou.",
  );
  await fotoG("residente-gestao");
} catch (e) {
  await ultima?.screenshot({ path: `${SAIDA}/FALHA.png`, fullPage: true });
  console.error("FALHA:", String(e).split("\n")[0]);
  process.exitCode = 1;
}
await navegador.close();
console.log(JSON.stringify({ telas: n, erros }, null, 2));
if (erros.length > 0) process.exitCode = 1;
