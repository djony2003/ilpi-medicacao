import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cifrar } from "@/compartilhado/criptografia";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarSegredoTotp, type Servico } from "@/modules/identidade";
import { criarApi } from "@/web/api";
import { gerarEscalaAposMudanca } from "@/web/rotas-escala";
import type { Contexto } from "@/web/rota";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa, criarUsuario } from "../ajudantes/dados";
import { Navegador, entrarNaApi } from "../ajudantes/navegador";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let enf: Navegador;
let tablet: Navegador;
let semSessao: Navegador;
let idosoId: string;
let medicamentoId: string;
let prescricaoId: string;

const hoje = () => new Date().toISOString().slice(0, 10);
const janela = () => {
  const agora = Date.now();
  return {
    de: new Date(agora - 3_600_000).toISOString(),
    ate: new Date(agora + 47 * 3_600_000).toISOString(),
  };
};
const consulta = () => {
  const { de, ate } = janela();
  return `/escala?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`;
};
type DoseApi = {
  idosoId: string;
  idosoNome: string;
  estado: string;
  horaLocal: string;
  previstaEm: string;
};
const dosesDe = (corpo: unknown): DoseApi[] =>
  (corpo as { escala: { doses: DoseApi[] } }).escala.doses;

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE });
  const api = criarApi({ servico, producao: false });
  casa = await criarCasa(migrador, "Casa da API de escala");

  const segredo = gerarSegredoTotp();
  const u = await criarUsuario(migrador, casa, {
    perfil: "enfermeiro",
    totpSegredoCifrado: cifrar(segredo, CHAVE),
    totpAtivo: true,
  });
  enf = new Navegador(api);
  await entrarNaApi(enf, u.email ?? "", segredo, { confirmarSenha: true });

  const sg = gerarSegredoTotp();
  const g = await criarUsuario(migrador, casa, {
    perfil: "gestor",
    totpSegredoCifrado: cifrar(sg, CHAVE),
    totpAtivo: true,
  });
  const gestor = new Navegador(api);
  await entrarNaApi(gestor, g.email ?? "", sg, { confirmarSenha: true });
  const aparelho = await gestor.post("/admin/dispositivos", { nome: "Tablet" });
  tablet = new Navegador(api);
  await tablet.post("/tablet/ativar", { codigo: String(aparelho.corpo.codigo) });
  const c = await criarUsuario(migrador, casa, { perfil: "cuidador", pin: "846201" });
  await tablet.post("/tablet/entrar", { usuarioId: c.id, pin: "846201" });
  semSessao = new Navegador(api);

  const i = await enf.post("/idosos", {
    nome: "Dona Escala da API",
    dataNascimento: "1939-05-05",
    quarto: "7",
    alergias: [{ substancia: "Iodo", gravidade: "grave" }],
  });
  idosoId = String(i.corpo.idosoId);
  const m = await enf.post("/medicamentos", {
    nomeComercial: "Remedio da Escala",
    principioAtivo: "SubstanciaEscalaApi",
    forma: "comprimido",
  });
  medicamentoId = String(m.corpo.medicamentoId);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("API da escala", () => {
  it("prescrever já gera as doses: a escala do tablet mostra o idoso sem esperar o agendador", async () => {
    expect(
      dosesDe((await tablet.get(consulta())).corpo).filter((d) => d.idosoId === idosoId),
    ).toHaveLength(0);
    const r = await enf.post(`/idosos/${idosoId}/prescricoes`, {
      medicamentoId,
      tipo: "regular",
      dose: 1,
      unidade: "comprimido",
      via: "oral",
      inicio: hoje(),
      altoRisco: false,
      horarios: [{ hora: "05:00" }, { hora: "11:00" }, { hora: "17:00" }, { hora: "23:00" }],
    });
    expect(r.status).toBe(201);
    prescricaoId = String(r.corpo.prescricaoId);

    for (const nav of [tablet, enf]) {
      const resp = await nav.get(consulta());
      expect(resp.status).toBe(200);
      expect(resp.cabecalhos.get("cache-control")).toBe("no-store");
      const minhas = dosesDe(resp.corpo).filter((d) => d.idosoId === idosoId);
      expect(minhas.length).toBeGreaterThanOrEqual(4);
      expect(minhas[0]?.idosoNome).toBe("Dona Escala da API");
    }
  });

  it("exige sessão", async () => {
    expect((await semSessao.get("/escala")).status).toBe(401);
    expect((await semSessao.post("/escala/folha-de-contingencia", {})).status).toBe(401);
  });

  it("recusa período inválido, grande demais ou com campo desconhecido", async () => {
    expect((await enf.get("/escala?de=ontem")).status).toBe(400);
    const agora = Date.now();
    const de = new Date(agora).toISOString();
    const longe = new Date(agora + 49 * 3_600_000).toISOString();
    expect(
      (await enf.get(`/escala?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(longe)}`))
        .status,
    ).toBe(400);
    expect(
      (await enf.get(`/escala?de=${encodeURIComponent(longe)}&ate=${encodeURIComponent(de)}`))
        .status,
    ).toBe(400);
    expect((await enf.post("/escala/folha-de-contingencia", { de: "ontem" })).status).toBe(400);
    expect(
      (await enf.post("/escala/folha-de-contingencia", { de: janela().de, casaId: "x" })).status,
    ).toBe(400);
    expect((await enf.post("/escala/folha-de-contingencia", { de, ate: longe })).status).toBe(400);
  });

  it("a folha sai em PDF, sem cache, e cada emissão fica na trilha", async () => {
    const antes = await trilha();
    const resp = await tablet.post("/escala/folha-de-contingencia", janela());
    expect(resp.status).toBe(200);
    expect(resp.cabecalhos.get("content-type")).toBe("application/pdf");
    expect(resp.cabecalhos.get("cache-control")).toBe("no-store");
    expect(resp.cabecalhos.get("x-content-type-options")).toBe("nosniff");
    expect(resp.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    // Corpo vazio também vale (período padrão): o JSON `{}` é obrigatório, não o conteúdo.
    expect((await enf.post("/escala/folha-de-contingencia", {})).status).toBe(200);
    expect(await trilha()).toBe(antes + 2);
  });

  it("internado some da escala; ao voltar a ativo, as doses voltam na hora", async () => {
    const sai = await enf.post(`/idosos/${idosoId}/status`, { status: "hospitalizado" });
    expect(sai.status).toBe(200);
    expect(dosesDe((await enf.get(consulta())).corpo).some((d) => d.idosoId === idosoId)).toBe(
      false,
    );

    const volta = await enf.post(`/idosos/${idosoId}/status`, { status: "ativo" });
    expect(volta.status).toBe(200);
    expect(dosesDe((await enf.get(consulta())).corpo).some((d) => d.idosoId === idosoId)).toBe(
      true,
    );
  });

  it("nova versão: as doses do horário novo aparecem na hora e as futuras do horário antigo saem", async () => {
    const r = await enf.post(`/prescricoes/${prescricaoId}/nova-versao`, {
      justificativa: "Mudança de horário pelo médico",
      conteudo: {
        medicamentoId,
        tipo: "regular",
        dose: 2,
        unidade: "comprimido",
        via: "oral",
        inicio: hoje(),
        altoRisco: false,
        horarios: [{ hora: "03:30" }],
      },
    });
    expect(r.status).toBe(201);
    prescricaoId = String(r.corpo.prescricaoId);
    const minhas = dosesDe((await enf.get(consulta())).corpo).filter((d) => d.idosoId === idosoId);
    expect(minhas.some((d) => d.horaLocal === "03:30")).toBe(true);
    const futurasAntigas = minhas.filter(
      (d) => d.horaLocal !== "03:30" && new Date(d.previstaEm).getTime() > Date.now(),
    );
    expect(futurasAntigas).toEqual([]);
  });

  it("encerrar a prescrição tira as doses futuras da escala", async () => {
    const r = await enf.post(`/prescricoes/${prescricaoId}/encerrar`, {
      motivo: "Suspensa pelo médico",
    });
    expect(r.status).toBe(200);
    expect(dosesDe((await enf.get(consulta())).corpo).some((d) => d.idosoId === idosoId)).toBe(
      false,
    );
  });
});

async function trilha(): Promise<number> {
  return comContexto(app, { casaId: casa }, async (c) =>
    Number(
      (
        await c.query(
          "SELECT count(*)::int AS n FROM auditoria WHERE acao = 'escala.folha_emitida'",
        )
      ).rows[0].n,
    ),
  );
}

describe("geração imediata", () => {
  it("falha na geração depois de gravar não vira erro para quem prescreveu", async () => {
    const ctx = {
      servico: {
        pool: { connect: () => Promise.reject(new Error("banco fora do ar")) },
        chaveCampos: "",
      },
      sessao: { casaId: casa },
    } as unknown as Contexto;
    await expect(gerarEscalaAposMudanca(ctx)).resolves.toBeUndefined();
  });
});
