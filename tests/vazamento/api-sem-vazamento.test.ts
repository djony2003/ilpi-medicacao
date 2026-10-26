import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar } from "@/compartilhado/criptografia";
import {
  ACOES,
  PERFIS,
  ativarDispositivo,
  autenticarSessao,
  criarDispositivo,
  gerarSegredoTotp,
  podeExecutar,
  type Servico,
} from "@/modules/identidade";
import { criarApi, listarRotas, type DescricaoDeRota } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";
import { criarAtorWeb, type AtorWeb } from "../ajudantes/sessoes";
import { escalaDoPlantao, gerarDosesDaCasa } from "@/modules/administracao";
import { adicionarAlergia, adicionarContato, cadastrarIdoso, obterIdoso } from "@/modules/idosos";
import { anexarReceita, cadastrarMedicamento, prescrever } from "@/modules/prescricoes";
import { ArmazenamentoEmMemoria } from "@/compartilhado/armazenamento";

// Malha de vazamento entre casas. Percorre TODAS as rotas da API (o inventário vem do próprio
// código), então uma rota nova passa a ser testada sem ninguém precisar lembrar de incluí-la.
//
// A casa B recebe "canários": nomes e identificadores únicos que jamais podem aparecer numa
// resposta, num log de auditoria ou num efeito colateral de quem está logado na casa A.

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const UUID_QUALQUER = "00000000-0000-4000-8000-0000000000aa";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let servico: () => Servico;
let api: (r: Request) => Promise<Response>;

type Ator = { nav: Navegador; usuarioId: string; email: string };
let gestorA: Ator;
let enfermeiroA: Ator;
let cuidadorTabletA: Ator;
let canarios: string[] = [];
let idsDeB: {
  usuarios: string[];
  dispositivo: string;
  idoso: string;
  alergia: string;
  contato: string;
  pulseira: string;
  medicamento: string;
  prescricao: string;
  receita: string;
};
let idosoDeA: string;
let gestorBToken: string;
let gestorBAtor: AtorWeb;

const rotas = listarRotas();
const chave = (r: DescricaoDeRota) => `${r.metodo} ${r.caminho}`;
/** Preenche os parâmetros da rota. `ids` troca por nome; o que faltar vira um UUID que não existe. */
const concreta = (r: DescricaoDeRota, ids: Record<string, string> | string = {}) => {
  const porNome = typeof ids === "string" ? { id: ids } : ids;
  return r.caminho.replace(/:(\w+)/g, (_, nome: string) => porNome[nome] ?? UUID_QUALQUER);
};
const temParametro = (r: DescricaoDeRota) => r.caminho.includes(":");

const CORPOS_VALIDOS: Record<string, unknown> = {
  "/admin/usuarios/:id/redefinir-senha": { novaSenha: "uma frase nova e comprida 2026" },
  "/admin/usuarios/:id/redefinir-pin": { novoPin: "273915" },
  // Corpos válidos: o 404 tem que vir do isolamento, não de uma validação que falhou antes.
  "/idosos/:id/editar": { quarto: "invadido" },
  "/idosos/:id/status": { status: "desligado" },
  "/idosos/:id/alergias": { substancia: "Veneno", gravidade: "grave" },
  "/idosos/:id/contatos": { nome: "Intruso", parentesco: "Ninguém", telefone: "11999990000" },
  "/idosos/:id/pulseira/regenerar": { motivo: "tentativa de invasão" },
  "/medicamentos/:id/alto-risco": { altoRisco: true },
  "/idosos/:id/prescricoes": {
    medicamentoId: UUID_QUALQUER,
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: "2026-03-10",
    altoRisco: false,
    horarios: [{ hora: "08:00" }],
  },
  "/prescricoes/:id/nova-versao": {
    justificativa: "tentativa de invasão",
    conteudo: {
      medicamentoId: UUID_QUALQUER,
      tipo: "regular",
      dose: 9,
      unidade: "comprimido",
      via: "oral",
      inicio: "2026-03-10",
      altoRisco: false,
      horarios: [{ hora: "09:00" }],
    },
  },
  "/prescricoes/:id/encerrar": { motivo: "tentativa de invasão" },
};

/** Rotas cujo corpo é um arquivo, não JSON. */
const PDF_VALIDO = Buffer.from("%PDF-1.7\nconteudo qualquer");
const BINARIAS = new Set(["/prescricoes/:id/receitas"]);
const opcoesDeCorpo = (r: DescricaoDeRota) =>
  r.metodo !== "POST"
    ? {}
    : BINARIAS.has(r.caminho)
      ? { binario: PDF_VALIDO, tipo: "application/pdf" }
      : { corpo: CORPOS_VALIDOS[r.caminho] ?? {} };

async function logadoNaApi(casaId: string, perfil: "gestor" | "enfermeiro"): Promise<Ator> {
  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casaId, {
    perfil,
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  const nav = new Navegador(api);
  await entrarNaApi(nav, u.email ?? "", segredo, { confirmarSenha: true });
  return { nav, usuarioId: u.id, email: u.email ?? "" };
}

async function auditoriaDe(casaId: string): Promise<number> {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM auditoria");
    return Number(r.rows[0]?.n);
  });
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  const armazenamento = new ArmazenamentoEmMemoria();
  servico = () => ({ pool: app, chaveCampos: CHAVE, armazenamento });
  api = criarApi({ servico, producao: false });
  casaA = await criarCasa(migrador, "Casa A (quem testa)");
  casaB = await criarCasa(migrador, "Casa B (canários)");

  // --- casa B: dados reconhecíveis que nunca podem aparecer para a casa A
  const gestorB = await criarAtorWeb(servico, migrador, casaB, "gestor", { reautenticado: true });
  const enfB = await criarUsuario(migrador, casaB, {
    perfil: "enfermeiro",
    nome: "CANARIO-B-NOME-ENFERMEIRO",
  });
  const cuidB = await criarUsuario(migrador, casaB, {
    perfil: "cuidador",
    nome: "CANARIO-B-NOME-CUIDADOR",
    pin: "846201",
  });
  const dispositivoB = await criarDispositivo(servico(), gestorB, { nome: "CANARIO-B-TABLET" });
  const ativacaoB = await ativarDispositivo(servico(), { codigo: dispositivoB.codigo });
  if (!ativacaoB.ok) throw new Error("ativação da casa B deveria funcionar");
  gestorBToken = gestorB.token;
  gestorBAtor = gestorB;

  const idosoB = await cadastrarIdoso(servico(), gestorB, {
    nome: "CANARIO-B-NOME-IDOSO",
    dataNascimento: "1931-01-01",
    cpf: "529.982.247-25",
    quarto: "CANARIO-B-QUARTO",
  });
  if (!idosoB.ok) throw new Error("cadastro do idoso da casa B deveria funcionar");
  const alergiaB = await adicionarAlergia(servico(), gestorB, {
    idosoId: idosoB.idosoId,
    substancia: "CANARIO-B-ALERGIA",
    gravidade: "grave",
  });
  const contatoB = await adicionarContato(servico(), gestorB, {
    idosoId: idosoB.idosoId,
    nome: "CANARIO-B-CONTATO",
    parentesco: "Filho",
    telefone: "11955554444",
  });
  if (!alergiaB.ok || !contatoB.ok) throw new Error("alergia e contato da casa B deveriam entrar");
  const medB = await cadastrarMedicamento(servico(), gestorB, {
    nomeComercial: "REMEDIO-B-QUIMICO",
    principioAtivo: "SUBSTANCIA-B-QUIMICA",
    forma: "comprimido",
    altoRisco: false,
  });
  if (!medB.ok) throw new Error("medicamento da casa B deveria entrar");
  const prescB = await prescrever(servico(), gestorB, {
    idosoId: idosoB.idosoId,
    medicamentoId: medB.medicamentoId,
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: "2026-03-10",
    fim: null,
    altoRisco: false,
    horarios: [{ hora: "08:00" }],
    instrucoes: "CANARIO-B-INSTRUCOES",
  });
  if (!prescB.ok)
    throw new Error(
      `prescrição da casa B deveria entrar: ${prescB.motivo} ${JSON.stringify("problemas" in prescB ? prescB.problemas : "")}`,
    );
  // A escala da casa B precisa ter doses de verdade, senão "A não vê B" seria uma verdade vazia.
  await gerarDosesDaCasa(servico(), casaB);
  const recB = await anexarReceita(servico(), gestorB, {
    prescricaoId: prescB.prescricaoId,
    bytes: Buffer.from("%PDF-1.7\nCANARIO-B-RECEITA"),
  });
  if (!recB.ok) throw new Error("receita da casa B deveria entrar");
  idsDeB = {
    medicamento: medB.medicamentoId,
    prescricao: prescB.prescricaoId,
    receita: recB.receitaId,
    usuarios: [enfB.id, cuidB.id, gestorB.usuarioId],
    dispositivo: dispositivoB.dispositivoId,
    idoso: idosoB.idosoId,
    alergia: alergiaB.alergiaId,
    contato: contatoB.contatoId,
    pulseira: idosoB.codigoPulseira,
  };
  canarios = [
    "CANARIO-B-NOME-ENFERMEIRO",
    "CANARIO-B-NOME-CUIDADOR",
    "CANARIO-B-TABLET",
    casaB,
    enfB.id,
    cuidB.id,
    gestorB.usuarioId,
    dispositivoB.dispositivoId,
    "CANARIO-B-NOME-IDOSO",
    "CANARIO-B-QUARTO",
    "CANARIO-B-ALERGIA",
    "CANARIO-B-CONTATO",
    "REMEDIO-B-QUIMICO",
    "SUBSTANCIA-B-QUIMICA",
    "CANARIO-B-INSTRUCOES",
    "CANARIO-B-RECEITA",
    medB.medicamentoId,
    prescB.prescricaoId,
    recB.receitaId,
    "52998224725",
    "11955554444",
    idosoB.idosoId,
    alergiaB.alergiaId,
    contatoB.contatoId,
    idosoB.codigoPulseira,
    ...[enfB.email, gestorB.usuario.email].filter((x): x is string => Boolean(x)),
  ];

  // --- casa A: um gestor, um enfermeiro e um tablet com cuidador logado
  gestorA = await logadoNaApi(casaA, "gestor");
  enfermeiroA = await logadoNaApi(casaA, "enfermeiro");
  const cuidA = await criarUsuario(migrador, casaA, {
    perfil: "cuidador",
    nome: "Cuidador da Casa A",
    pin: "846201",
  });
  const criado = await gestorA.nav.post("/admin/dispositivos", { nome: "Tablet da Casa A" });
  const tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(criado.corpo.codigo) });
  const entrou = await tablet.post("/tablet/entrar", { usuarioId: cuidA.id, pin: "846201" });
  if (entrou.status !== 200) throw new Error("PIN do cuidador A deveria entrar");
  cuidadorTabletA = { nav: tablet, usuarioId: cuidA.id, email: "" };

  const idosoA = await gestorA.nav.post("/idosos", {
    nome: "Idosa da Casa A",
    dataNascimento: "1940-03-03",
    alergias: [{ substancia: "Dipirona", gravidade: "grave" }],
  });
  if (idosoA.status !== 201) throw new Error("cadastro do idoso da casa A deveria funcionar");
  idosoDeA = String(idosoA.corpo.idosoId);
  const medA = await gestorA.nav.post("/medicamentos", {
    nomeComercial: "Remedio da Casa A",
    principioAtivo: "SubstanciaDaCasaA",
    forma: "comprimido",
  });
  if (medA.status !== 201) throw new Error("medicamento da casa A deveria entrar");
  const hoje = new Date().toISOString().slice(0, 10);
  const prescA = await gestorA.nav.post(`/idosos/${idosoDeA}/prescricoes`, {
    medicamentoId: String(medA.corpo.medicamentoId),
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: hoje,
    altoRisco: false,
    horarios: [{ hora: "06:00" }, { hora: "12:00" }, { hora: "18:00" }, { hora: "23:30" }],
  });
  if (prescA.status !== 201) throw new Error("prescrição da casa A deveria entrar");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("inventário de rotas", () => {
  it("as rotas públicas são exatamente as conhecidas (uma nova exige decisão consciente)", () => {
    const publicas = rotas
      .filter((r) => r.acesso === "publico")
      .map(chave)
      .sort();
    expect(publicas).toEqual(["POST /auth/entrar", "POST /auth/sair", "POST /tablet/ativar"]);
  });

  it("toda rota /admin declara a permissão que exige, e ela existe na matriz", () => {
    const admin = rotas.filter((r) => r.caminho.startsWith("/admin"));
    expect(admin.length).toBeGreaterThan(0);
    for (const r of admin) {
      expect(r.permissao, chave(r)).not.toBeNull();
      expect(ACOES, chave(r)).toContain(r.permissao);
    }
  });

  it("toda rota com sessão declara a permissão que exige, salvo as da própria conta", () => {
    // Rota nova sem permissão declarada passaria despercebida pela malha de 403: por isso a lista
    // de exceções é fechada, e crescer exige decisão consciente.
    const semPermissao = rotas
      .filter((r) => r.acesso === "sessao" && r.permissao === null)
      .map(chave)
      .sort();
    expect(semPermissao).toEqual([
      "GET /auth/eu",
      "POST /auth/reautenticar",
      "POST /auth/trocar-pin",
      "POST /auth/trocar-senha",
    ]);
    for (const r of rotas.filter((x) => x.permissao !== null)) {
      expect(ACOES, chave(r)).toContain(r.permissao);
    }
  });

  it("há rotas suficientes para a malha não ser vazia", () => {
    expect(rotas.length).toBeGreaterThanOrEqual(20);
    expect(rotas.filter((r) => r.caminho.includes(":id")).length).toBeGreaterThanOrEqual(7);
  });
});

describe("acesso por rota (todas as rotas)", () => {
  it("sem credenciais, toda rota que não é pública responde 401", async () => {
    for (const r of rotas.filter((x) => x.acesso !== "publico")) {
      const resp = await new Navegador(api).chamar(r.metodo, concreta(r), {
        corpo: r.metodo === "POST" ? {} : undefined,
      });
      expect(resp.status, chave(r)).toBe(401);
    }
  });

  it("toda rota que altera dados recusa origem de outro site, inclusive as públicas", async () => {
    for (const r of rotas.filter((x) => x.metodo === "POST")) {
      const resp = await gestorA.nav.chamar("POST", concreta(r), {
        corpo: {},
        origem: "https://site-malvado.test",
      });
      expect(resp.status, chave(r)).toBe(403);
      expect(resp.corpo, chave(r)).toEqual({ erro: "origem_invalida" });
    }
  });

  it("perfil sem a permissão da rota recebe 403 antes de qualquer outra coisa", async () => {
    const atores: Array<[string, Ator, "cuidador" | "enfermeiro"]> = [
      ["enfermeiro (web)", enfermeiroA, "enfermeiro"],
      ["cuidador (tablet)", cuidadorTabletA, "cuidador"],
    ];
    let verificadas = 0;
    for (const [nome, ator, perfil] of atores) {
      for (const r of rotas.filter((x) => x.permissao !== null)) {
        const permissao = r.permissao;
        if (permissao === null || podeExecutar(perfil, permissao)) continue;
        // Corpo inválido de propósito: a permissão tem que vir antes da validação do corpo.
        const resp = await ator.nav.chamar(r.metodo, concreta(r), {
          corpo: r.metodo === "POST" ? { lixo: true } : undefined,
        });
        expect(resp.status, `${nome} em ${chave(r)}`).toBe(403);
        expect(resp.corpo, `${nome} em ${chave(r)}`).toEqual({ erro: "sem_permissao" });
        verificadas += 1;
      }
    }
    expect(verificadas).toBeGreaterThan(10);
  });

  it("a matriz de permissões cobre todos os perfis das rotas (nenhuma ação sem dono)", () => {
    for (const r of rotas.filter((x) => x.permissao !== null)) {
      const quem = PERFIS.filter((p) => r.permissao !== null && podeExecutar(p, r.permissao));
      expect(quem, chave(r)).toContain("gestor");
    }
  });
});

describe("isolamento entre casas (todas as rotas com identificador)", () => {
  it("o gestor da casa A não alcança nenhum objeto da casa B", async () => {
    const antesDeB = await auditoriaDe(casaB);
    const comId = rotas.filter((r) => r.caminho.includes(":id"));

    for (const r of comId) {
      const complementos = {
        alergiaId: idsDeB.alergia,
        contatoId: idsDeB.contato,
        receitaId: idsDeB.receita,
      };
      const ids = r.caminho.startsWith("/admin/dispositivos")
        ? [idsDeB.dispositivo]
        : r.caminho.startsWith("/idosos")
          ? [idsDeB.idoso]
          : r.caminho.startsWith("/medicamentos")
            ? [idsDeB.medicamento]
            : r.caminho.startsWith("/prescricoes")
              ? [idsDeB.prescricao]
              : idsDeB.usuarios;
      for (const id of ids) {
        const url = concreta(r, { id, ...complementos });
        const resp = await gestorA.nav.chamar(r.metodo, url, opcoesDeCorpo(r));
        // Para a casa A, o objeto da casa B simplesmente não existe.
        expect(resp.status, `${chave(r)} com id da casa B`).toBe(404);
        const texto = JSON.stringify(resp.corpo);
        for (const c of canarios) expect(texto).not.toContain(c);
      }
    }

    // Nada mudou na casa B: nem dados, nem a trilha de auditoria dela.
    expect(await auditoriaDe(casaB)).toBe(antesDeB);
    await comContexto(app, { casaId: casaB }, async (c) => {
      const i = await c.query(
        `SELECT 1 FROM idoso WHERE id = $1 AND quarto = 'CANARIO-B-QUARTO' AND status = 'ativo'`,
        [idsDeB.idoso],
      );
      expect(i.rowCount).toBe(1);
      const filhos = await c.query(
        `SELECT (SELECT count(*) FROM alergia WHERE idoso_id = $1 AND ativa)::int AS alergias,
                (SELECT count(*) FROM contato_emergencia WHERE idoso_id = $1 AND ativo)::int AS contatos,
                (SELECT count(*) FROM pulseira_revogada)::int AS revogadas`,
        [idsDeB.idoso],
      );
      expect(filhos.rows[0]).toEqual({ alergias: 1, contatos: 1, revogadas: 0 });
      const clinico = await c.query(
        `SELECT (SELECT count(*) FROM prescricao WHERE id = $1 AND status = 'ativa' AND dose = 1 AND versao = 1)::int AS prescricao,
                (SELECT count(*) FROM medicamento WHERE id = $2 AND ativo AND NOT alto_risco_padrao)::int AS medicamento,
                (SELECT count(*) FROM receita_prescricao WHERE prescricao_id = $1)::int AS receitas`,
        [idsDeB.prescricao, idsDeB.medicamento],
      );
      expect(clinico.rows[0]).toEqual({ prescricao: 1, medicamento: 1, receitas: 1 });
      const u = await c.query(
        "SELECT id FROM usuario WHERE id = ANY($1) AND ativo AND bloqueado_ate IS NULL",
        [idsDeB.usuarios],
      );
      expect(u.rowCount).toBe(idsDeB.usuarios.length);
      const d = await c.query("SELECT 1 FROM dispositivo WHERE id = $1 AND revogado_em IS NULL", [
        idsDeB.dispositivo,
      ]);
      expect(d.rowCount).toBe(1);
    });
    // O gestor da casa B continua com a sessão dele.
    expect(await autenticarSessao(servico(), gestorBToken)).not.toBeNull();
  });

  it("toda resposta de listagem da casa A é só da casa A (e não está vazia)", async () => {
    const listagens = rotas.filter(
      (x) => x.metodo === "GET" && x.acesso !== "dispositivo" && !temParametro(x),
    );
    expect(listagens.map(chave)).toContain("GET /idosos");
    for (const r of listagens) {
      const resp = await gestorA.nav.chamar("GET", concreta(r));
      expect(resp.status, chave(r)).toBe(200);
      const texto = JSON.stringify(resp.corpo);
      for (const c of canarios) expect(texto, `${chave(r)} vazou ${c}`).not.toContain(c);
    }
    const usuarios = JSON.stringify((await gestorA.nav.get("/admin/usuarios")).corpo);
    expect(usuarios).toContain(gestorA.usuarioId);
    expect(usuarios).toContain(enfermeiroA.usuarioId);
    const aparelhos = JSON.stringify((await gestorA.nav.get("/admin/dispositivos")).corpo);
    expect(aparelhos).toContain("Tablet da Casa A");
    expect(JSON.stringify((await gestorA.nav.get("/idosos")).corpo)).toContain(idosoDeA);
  });

  it("escala e folha de contingência da casa A só trazem doses da casa A (e a da B não está vazia)", async () => {
    const agora = Date.now();
    const de = new Date(agora - 3_600_000).toISOString();
    const ate = new Date(agora + 47 * 3_600_000).toISOString();

    // A casa B tem doses no período: o que a torna "invisível" para A é o isolamento, não o vazio.
    const daB = await escalaDoPlantao(servico(), gestorBAtor, {
      de: new Date(de),
      ate: new Date(ate),
    });
    if (!daB.ok) throw new Error("escala da casa B");
    expect(JSON.stringify(daB.escala.doses)).toContain("CANARIO-B-NOME-IDOSO");

    for (const ator of [gestorA, enfermeiroA, cuidadorTabletA]) {
      const resp = await ator.nav.get(
        `/escala?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`,
      );
      expect(resp.status).toBe(200);
      const texto = JSON.stringify(resp.corpo);
      expect(texto).toContain("Idosa da Casa A");
      for (const c of canarios) expect(texto, `escala vazou ${c}`).not.toContain(c);
    }

    const folha = await gestorA.nav.post("/escala/folha-de-contingencia", { de, ate });
    expect(folha.status).toBe(200);
    const pasta = mkdtempSync(join(tmpdir(), "vazamento-"));
    const arquivo = join(pasta, "folha.pdf");
    writeFileSync(arquivo, folha.bytes);
    const textoDoPdf = execFileSync("pdftotext", ["-layout", arquivo, "-"], { encoding: "utf8" });
    expect(textoDoPdf).toContain("Idosa da Casa A");
    for (const c of canarios) expect(textoDoPdf, `folha vazou ${c}`).not.toContain(c);
  });

  it("a leitura de pulseira da casa A não encontra a pulseira da casa B (nem pelo QR)", async () => {
    const antes = await auditoriaDe(casaB);
    for (const leitura of [
      idsDeB.pulseira,
      `ILPI:I:${idsDeB.pulseira}`,
      idsDeB.pulseira.toLowerCase(),
    ]) {
      for (const ator of [cuidadorTabletA, gestorA]) {
        const resp = await ator.nav.post("/pulseira/localizar", { leitura });
        expect(resp.status).toBe(404);
        expect(resp.corpo).toEqual({ erro: "pulseira_desconhecida" });
      }
    }
    expect(await auditoriaDe(casaB)).toBe(antes);
  });

  it("o idoso da casa B nunca aparece em nenhuma listagem ou detalhe da casa A", async () => {
    const detalheA = JSON.stringify((await gestorA.nav.get(`/idosos/${idosoDeA}`)).corpo);
    expect(detalheA).toContain("Idosa da Casa A");
    for (const c of canarios) expect(detalheA).not.toContain(c);
    const lido = await obterIdoso(
      servico(),
      await criarAtorWeb(servico, migrador, casaA, "gestor"),
      idsDeB.idoso,
    );
    expect(lido).toEqual({ ok: false, motivo: "nao_encontrado" });
  });

  it("o tablet da casa A não lista nem aceita usuários da casa B", async () => {
    const lista = JSON.stringify((await cuidadorTabletA.nav.get("/tablet/usuarios")).corpo);
    expect(lista).toContain(cuidadorTabletA.usuarioId);
    for (const c of canarios) expect(lista).not.toContain(c);

    for (const id of idsDeB.usuarios) {
      const resp = await cuidadorTabletA.nav.post("/tablet/entrar", {
        usuarioId: id,
        pin: "846201",
      });
      expect(resp.status).toBe(401);
      expect(resp.corpo).toEqual({ erro: "credenciais_invalidas" });
    }
  });

  it("a casa B pode ser alcançada pelos próprios donos (a malha não está só recusando tudo)", async () => {
    const gestorB = await logadoNaApi(casaB, "gestor");
    const lista = JSON.stringify((await gestorB.nav.get("/admin/usuarios")).corpo);
    expect(lista).toContain("CANARIO-B-NOME-ENFERMEIRO");
    const ativo = await gestorB.nav.post(`/admin/usuarios/${idsDeB.usuarios[0] ?? ""}/desbloquear`);
    expect(ativo.status).toBe(200);
  });
});

describe("trilha de auditoria entre casas", () => {
  it("nada que o pessoal da casa A fez aparece na trilha da casa B, e vice-versa", async () => {
    const donosA = [gestorA.usuarioId, enfermeiroA.usuarioId, cuidadorTabletA.usuarioId];

    const naB = await comContexto(app, { casaId: casaB }, async (c) => {
      const r = await c.query("SELECT 1 FROM auditoria WHERE usuario_id = ANY($1::uuid[])", [
        donosA,
      ]);
      return r.rowCount;
    });
    expect(naB).toBe(0);

    const naA = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query("SELECT 1 FROM auditoria WHERE usuario_id = ANY($1::uuid[])", [
        idsDeB.usuarios,
      ]);
      return r.rowCount;
    });
    expect(naA).toBe(0);

    const textoA = await comContexto(app, { casaId: casaA }, async (c) => {
      const r = await c.query("SELECT to_jsonb(a) AS linha FROM auditoria a");
      return JSON.stringify(r.rows);
    });
    for (const c of canarios) expect(textoA).not.toContain(c);
  });
});
