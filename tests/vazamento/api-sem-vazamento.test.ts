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
import { criarAtorWeb } from "../ajudantes/sessoes";

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
let idsDeB: { usuarios: string[]; dispositivo: string };
let gestorBToken: string;

const rotas = listarRotas();
const chave = (r: DescricaoDeRota) => `${r.metodo} ${r.caminho}`;
const concreta = (r: DescricaoDeRota, id = UUID_QUALQUER) => r.caminho.replace(":id", id);

const CORPOS_VALIDOS: Record<string, unknown> = {
  "/admin/usuarios/:id/redefinir-senha": { novaSenha: "uma frase nova e comprida 2026" },
  "/admin/usuarios/:id/redefinir-pin": { novoPin: "273915" },
};

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
  servico = () => ({ pool: app, chaveCampos: CHAVE });
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
  idsDeB = {
    usuarios: [enfB.id, cuidB.id, gestorB.usuarioId],
    dispositivo: dispositivoB.dispositivoId,
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
      const ids = r.caminho.startsWith("/admin/dispositivos")
        ? [idsDeB.dispositivo]
        : idsDeB.usuarios;
      for (const id of ids) {
        const resp = await gestorA.nav.chamar(r.metodo, concreta(r, id), {
          corpo: r.metodo === "POST" ? (CORPOS_VALIDOS[r.caminho] ?? {}) : undefined,
        });
        // Para a casa A, o objeto da casa B simplesmente não existe.
        expect(resp.status, `${chave(r)} com id da casa B`).toBe(404);
        const texto = JSON.stringify(resp.corpo);
        for (const c of canarios) expect(texto).not.toContain(c);
      }
    }

    // Nada mudou na casa B: nem dados, nem a trilha de auditoria dela.
    expect(await auditoriaDe(casaB)).toBe(antesDeB);
    await comContexto(app, { casaId: casaB }, async (c) => {
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
    for (const r of rotas.filter((x) => x.metodo === "GET" && x.acesso !== "dispositivo")) {
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
