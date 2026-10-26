import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar } from "@/compartilhado/criptografia";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";

// O registro pela API, do jeito que o tablet faz: relógio real, dose marcada para daqui a 10
// minutos (dentro da janela), aparelho aprovado e cuidador com PIN.

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const PIN = "846201";

let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let api: (r: Request) => Promise<Response>;
let enf: Navegador;
let gestor: Navegador;
let tablet: Navegador;
let colegaId: string;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE });

async function logar(perfil: "enfermeiro" | "gestor") {
  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casa, {
    perfil,
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  const nav = new Navegador(api);
  await entrarNaApi(nav, u.email ?? "", segredo, { confirmarSenha: true });
  return nav;
}

/** HH:MM em São Paulo daqui a `min` minutos. */
function horaDaquiA(min: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(Date.now() + min * 60_000));
}
const hojeEmSp = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

type Cenario = {
  idosoId: string;
  pulseira: string;
  loteQr: string;
  loteId: string;
  doseId: string;
  prescricaoId: string;
};

async function cenario(
  extra: { altoRisco?: boolean; medicamentoId?: string } = {},
): Promise<Cenario> {
  const i = await enf.post("/idosos", {
    nome: `Residente API ${randomUUID().slice(0, 4)}`,
    dataNascimento: "1937-07-07",
    alergias: [],
  });
  const idosoId = String(i.corpo.idosoId);
  let medicamentoId = extra.medicamentoId;
  if (!medicamentoId) {
    const m = await enf.post("/medicamentos", {
      nomeComercial: `Remedio API ${randomUUID().slice(0, 6)}`,
      principioAtivo: `SubstanciaApi${randomUUID().slice(0, 6)}`,
      forma: "comprimido",
    });
    medicamentoId = String(m.corpo.medicamentoId);
  }
  const l = await enf.post("/estoque/lotes", {
    medicamentoId,
    numeroLote: "API-ADM",
    validade: "2030-01-31",
    unidade: "comprimido",
    quantidade: 10,
  });
  const loteId = String(l.corpo.loteId);
  const p = await enf.post(`/idosos/${idosoId}/prescricoes`, {
    medicamentoId,
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: hojeEmSp(),
    altoRisco: extra.altoRisco ?? false,
    horarios: [{ hora: horaDaquiA(10) }],
  });
  expect(p.status, JSON.stringify(p.corpo)).toBe(201);
  const prescricaoId = String(p.corpo.prescricaoId);
  const { pulseira, loteQr, doseId } = await comContexto(app, { casaId: casa }, async (c) => {
    const a = await c.query<{ codigo_pulseira: string }>(
      "SELECT codigo_pulseira FROM idoso WHERE id = $1",
      [idosoId],
    );
    const b = await c.query<{ codigo_qr: string }>(
      "SELECT codigo_qr FROM lote_estoque WHERE id = $1",
      [loteId],
    );
    const d = await c.query<{ id: string }>(
      "SELECT id FROM dose_agendada WHERE prescricao_id = $1 ORDER BY prevista_em LIMIT 1",
      [prescricaoId],
    );
    return {
      pulseira: `ILPI:I:${a.rows[0]?.codigo_pulseira ?? ""}`,
      loteQr: `ILPI:L:${b.rows[0]?.codigo_qr ?? ""}`,
      doseId: d.rows[0]?.id ?? "",
    };
  });
  expect(doseId).not.toBe("");
  return { idosoId, pulseira, loteQr, loteId, doseId, prescricaoId };
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  api = criarApi({ servico, producao: false });
  casa = await criarCasa(migrador, "Casa da API de administração");
  enf = await logar("enfermeiro");
  gestor = await logar("gestor");
  const aparelho = await gestor.post("/admin/dispositivos", { nome: "Tablet do posto" });
  tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(aparelho.corpo.codigo) });
  const c = await criarUsuario(migrador, casa, {
    perfil: "cuidador",
    pin: PIN,
    nome: "Cuidadora da API",
  });
  const entrou = await tablet.post("/tablet/entrar", { usuarioId: c.id, pin: PIN });
  expect(entrou.status).toBe(200);
  colegaId = (
    await criarUsuario(migrador, casa, { perfil: "cuidador", pin: PIN, nome: "Colega da API" })
  ).id;
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("API do registro", () => {
  it("passo a passo: detalhe, pulseira, etiqueta, registro; reenvio devolve o mesmo registro", async () => {
    const c = await cenario();
    const detalhe = await tablet.get(`/administracao/doses/${c.doseId}`);
    expect(detalhe.status).toBe(200);
    expect(detalhe.cabecalhos.get("cache-control")).toBe("no-store");
    expect(detalhe.corpo).toMatchObject({
      conferencia: { pulseiraConferida: null, bloqueios: [] },
    });

    const p = await tablet.post(`/administracao/doses/${c.doseId}/conferir`, {
      pulseira: c.pulseira,
    });
    expect(p.corpo).toMatchObject({ conferencia: { pulseiraConferida: true, bloqueios: [] } });
    const l = await tablet.post(`/administracao/doses/${c.doseId}/conferir`, {
      pulseira: c.pulseira,
      lote: c.loteQr,
    });
    expect(l.corpo).toMatchObject({ conferencia: { lote: { saldo: 10 }, bloqueios: [] } });

    const pedido = {
      chave: randomUUID(),
      resultado: "administrada",
      pulseira: c.pulseira,
      lote: c.loteQr,
    };
    const r = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, pedido);
    expect(r.status).toBe(201);
    expect(r.corpo).toMatchObject({ ok: true, repetido: false, saldoDoLote: 9 });
    const de_novo = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, pedido);
    expect(de_novo.status).toBe(200);
    expect(de_novo.corpo).toMatchObject({
      repetido: true,
      administracaoId: r.corpo.administracaoId,
    });

    const escala = await tablet.get("/escala");
    const dose = (
      escala.corpo as { escala: { doses: Array<{ id: string; estado: string }> } }
    ).escala.doses.find((d) => d.id === c.doseId);
    expect(dose?.estado).toBe("concluida");
  });

  it("bloqueio volta 409 com a mensagem para a tela; regra de motivo e de validação voltam com o que falta", async () => {
    const c = await cenario({ altoRisco: true });
    const outro = await cenario();
    const errado = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, {
      chave: randomUUID(),
      resultado: "administrada",
      pulseira: outro.pulseira,
      lote: c.loteQr,
    });
    expect(errado.status).toBe(409);
    expect(errado.corpo).toMatchObject({
      erro: "conferencia_bloqueada",
      bloqueios: [
        { codigo: "pulseira_de_outro_idoso", mensagem: "Esta pulseira é de outro paciente" },
      ],
    });

    const base = { resultado: "administrada", pulseira: c.pulseira, lote: c.loteQr };
    const sem = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, {
      chave: randomUUID(),
      ...base,
    });
    expect(sem.status).toBe(409);
    expect(sem.corpo).toEqual({ erro: "segunda_validacao_necessaria" });
    const pinErrado = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, {
      chave: randomUUID(),
      ...base,
      segundaValidacao: { usuarioId: colegaId, pin: "000000" },
    });
    expect(pinErrado.status).toBe(422);
    expect(pinErrado.corpo).toEqual({ erro: "pin_invalido", etapa: "segunda_validacao" });
    // O tablet continua logado: PIN errado do colega não derruba a sessão de quem registra.
    expect((await tablet.get("/escala")).status).toBe(200);
    const ok = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, {
      chave: randomUUID(),
      ...base,
      segundaValidacao: { usuarioId: colegaId, pin: PIN },
    });
    expect(ok.status).toBe(201);
  });

  it("valida o corpo: resultado desconhecido, campo extra, chave inválida", async () => {
    const c = await cenario();
    const url = `/administracao/doses/${c.doseId}/registrar`;
    expect((await tablet.post(url, { chave: randomUUID(), resultado: "talvez" })).status).toBe(400);
    expect(
      (await tablet.post(url, { chave: randomUUID(), resultado: "administrada", extra: 1 })).status,
    ).toBe(400);
    const r = await tablet.post(url, {
      chave: "nao-e-uuid",
      resultado: "nao_administrada",
      motivo: "Fora",
    });
    expect(r.status).toBe(400);
    expect(r.corpo).toMatchObject({ erro: "dados_invalidos" });
  });

  it("lista os lotes da dose (para a exceção) e registra com exceção liberada pelo enfermeiro", async () => {
    const c = await cenario();
    const lotes = await tablet.get(`/administracao/doses/${c.doseId}/lotes`);
    expect(lotes.status).toBe(200);
    expect((lotes.corpo as { lotes: Array<{ id: string; destino: string }> }).lotes).toContainEqual(
      expect.objectContaining({ id: c.loteId, destino: "comum", vencido: false }),
    );
    const enfermeira = await criarUsuario(migrador, casa, { perfil: "enfermeiro", pin: PIN });
    const r = await tablet.post(`/administracao/doses/${c.doseId}/registrar`, {
      chave: randomUUID(),
      resultado: "administrada",
      pulseira: c.pulseira,
      excecao: {
        loteId: c.loteId,
        motivo: "etiqueta_ilegivel",
        justificativa: "Etiqueta apagada, conferido na caixa",
        liberador: { usuarioId: enfermeira.id, pin: PIN },
      },
    });
    expect(r.status).toBe(201);
  });

  it("registro tardio pede o PIN de novo no tablet", async () => {
    const c = await cenario();
    const pedido = {
      chave: randomUUID(),
      resultado: "nao_administrada",
      ocorridaEm: new Date(Date.now() - 60_000).toISOString(),
      motivo: "Anotado na folha de contingência",
    };
    // A dose é daqui a 10 minutos; "1 minuto atrás" está dentro do que a dose aceita.
    const sem = await tablet.post(`/administracao/doses/${c.doseId}/tardio`, pedido);
    expect(sem.status).toBe(403);
    expect(sem.corpo).toEqual({ erro: "reautenticacao_necessaria" });
    expect((await tablet.post("/auth/reautenticar", { segredo: PIN })).status).toBe(200);
    const com = await tablet.post(`/administracao/doses/${c.doseId}/tardio`, pedido);
    expect(com.status, JSON.stringify(com.corpo)).toBe(201);
  });

  it("SOS: lista do idoso, registro e limite", async () => {
    const c = await cenario();
    const m = await enf.post("/medicamentos", {
      nomeComercial: `Analgesico API ${randomUUID().slice(0, 4)}`,
      principioAtivo: `AnalgesicoApi${randomUUID().slice(0, 4)}`,
      forma: "comprimido",
    });
    const medicamentoId = String(m.corpo.medicamentoId);
    const l = await enf.post("/estoque/lotes", {
      medicamentoId,
      numeroLote: "SOS",
      validade: "2030-01-31",
      unidade: "comprimido",
      quantidade: 5,
    });
    const qr = await comContexto(app, { casaId: casa }, async (x) => {
      const q = await x.query<{ codigo_qr: string }>(
        "SELECT codigo_qr FROM lote_estoque WHERE id = $1",
        [String(l.corpo.loteId)],
      );
      return `ILPI:L:${q.rows[0]?.codigo_qr ?? ""}`;
    });
    const p = await enf.post(`/idosos/${c.idosoId}/prescricoes`, {
      medicamentoId,
      tipo: "sos",
      dose: 1,
      unidade: "comprimido",
      via: "oral",
      inicio: hojeEmSp(),
      altoRisco: false,
      horarios: [],
      sos: { indicacao: "Dor", limiteDiario: 2, intervaloMinimoMin: 240 },
    });
    expect(p.status, JSON.stringify(p.corpo)).toBe(201);
    const prescricaoId = String(p.corpo.prescricaoId);
    const lista = await tablet.get(`/administracao/idosos/${c.idosoId}/sos`);
    expect(
      (lista.corpo as { sos: Array<{ prescricaoId: string }> }).sos.map((s) => s.prescricaoId),
    ).toEqual([prescricaoId]);
    const corpo = { pulseira: c.pulseira, lote: qr, sintoma: "Dor nas costas" };
    expect(
      (
        await tablet.post(`/administracao/sos/${prescricaoId}/registrar`, {
          chave: randomUUID(),
          ...corpo,
        })
      ).status,
    ).toBe(201);
    const segunda = await tablet.post(`/administracao/sos/${prescricaoId}/registrar`, {
      chave: randomUUID(),
      ...corpo,
    });
    expect(segunda.status).toBe(409);
    expect(segunda.corpo).toMatchObject({ erro: "limite_sos", limite: "intervalo_minimo" });
  });

  it("a janela da casa: o gestor lê e ajusta; cuidador e enfermeiro não", async () => {
    expect((await gestor.get("/admin/configuracoes/janela")).corpo).toEqual({
      janela: { janelaMin: 30, limiteMaiorMin: 120 },
    });
    expect((await tablet.get("/admin/configuracoes/janela")).status).toBe(403);
    expect(
      (await enf.post("/admin/configuracoes/janela", { janelaMinutos: 20, limiteMaiorMinutos: 90 }))
        .status,
    ).toBe(403);
    const r = await gestor.post("/admin/configuracoes/janela", {
      janelaMinutos: 20,
      limiteMaiorMinutos: 90,
    });
    expect(r.corpo).toEqual({ janela: { janelaMin: 20, limiteMaiorMin: 90 } });
    expect(
      (
        await gestor.post("/admin/configuracoes/janela", {
          janelaMinutos: 20,
          limiteMaiorMinutos: 10,
        })
      ).status,
    ).toBe(400);
    await gestor.post("/admin/configuracoes/janela", {
      janelaMinutos: 30,
      limiteMaiorMinutos: 120,
    });
  });
});
