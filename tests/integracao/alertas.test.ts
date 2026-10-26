import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CorreioEmMemoria } from "@/compartilhado/correio";
import { alertasDeTodasAsCasas } from "@/agendador/laco";
import { registrarDose, registrarSos, registrarTardio } from "@/modules/administracao";
import {
  configurarAlertas,
  encerrarAlerta,
  enviarAlertasDaCasa,
  listarAlertas,
  marcarComoLido,
  resumoDosAlertas,
  verificarAlertasDaCasa,
  MAXIMO_DE_TENTATIVAS,
} from "@/modules/alertas";
import { lancarSaida } from "@/modules/estoque";
import {
  ErroDePermissao,
  ErroDeReautenticacao,
  desativarUsuario,
  type Servico,
} from "@/modules/identidade";
import { prescrever } from "@/modules/prescricoes";
import {
  PIN,
  idosoComPulseira,
  linhas,
  lote,
  medicamento,
  nova,
  pessoaComPin,
  prescreverComDose,
} from "../ajudantes/administracao";
import { criarPoolAgendador, criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import { criarAtorTablet, criarAtorWeb, type AtorTablet, type AtorWeb } from "../ajudantes/sessoes";

// Alertas (spec 6.4 e 6.5) contra o PostgreSQL real, com relógio simulado. Cada teste tem a
// própria casa: a verificação olha para a casa inteira.
//
// A dose das 08:00 de 10/03 (São Paulo) está prevista para 11:00Z.

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const PREVISTA = new Date("2026-03-10T11:00:00Z");
const min = (m: number) => new Date(PREVISTA.getTime() + m * 60_000);
const hrs = (h: number) => min(h * 60);

let app: pg.Pool;
let agendador: pg.Pool;
let migrador: pg.Pool;
let agora: Date;
let casa: string;
let enf: AtorWeb;
let gestor: AtorWeb;
let cuidador: AtorTablet;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const confirmado = <A extends { reautenticadoEm: Date | null }>(a: A): A => ({
  ...a,
  reautenticadoEm: agora,
});
const verificar = () => verificarAlertasDaCasa(servico(), casa);

type Linha = {
  chave: string;
  tipo: string;
  gravidade: string;
  destino: string;
  estado: string;
  resolucao: string | null;
};
const alertas = () =>
  linhas<Linha>(
    app,
    casa,
    "SELECT chave, tipo, gravidade, destino, estado, resolucao FROM alerta ORDER BY seq",
  );
const abertos = async () => (await alertas()).filter((a) => a.estado === "aberto");
const envios = () =>
  linhas<{
    motivo: string;
    estado: string;
    usuario_id: string;
    tentativas: number;
    proxima_em: Date;
  }>(
    app,
    casa,
    "SELECT motivo, estado, usuario_id, tentativas, proxima_em FROM envio_alerta ORDER BY seq",
  );
const perfisDe = async (ids: string[]) => [
  ...new Set(
    (
      await linhas<{ perfil: string }>(
        app,
        casa,
        "SELECT perfil FROM usuario WHERE id = ANY($1::uuid[])",
        [ids],
      )
    ).map((u) => u.perfil),
  ),
];
const idDoAlerta = async (prefixo: string) =>
  (
    await linhas<{ id: string }>(
      app,
      casa,
      "SELECT id FROM alerta WHERE chave LIKE $1 AND estado = 'aberto'",
      [`${prefixo}%`],
    )
  )[0]?.id ?? "";

beforeAll(async () => {
  app = criarPoolApp(10);
  agendador = criarPoolAgendador(2);
  migrador = criarPoolMigrador();
});

beforeEach(async () => {
  agora = min(-60);
  casa = await criarCasa(migrador, "Casa dos alertas");
  enf = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
  gestor = await criarAtorWeb(servico, migrador, casa, "gestor");
  cuidador = await criarAtorTablet(servico, migrador, casa);
});

afterAll(async () => {
  await app.end();
  await agendador.end();
  await migrador.end();
});

/** Idoso com uma dose às 08:00 e lote de sobra (para o estoque não alertar junto). */
async function doseDasOito(extra: Parameters<typeof prescreverComDose>[4] = {}) {
  agora = min(-60);
  const idoso = await idosoComPulseira(servico(), enf, "Dona Alerta");
  const med = await medicamento(servico(), enf, { nome: "Remedio Alerta" });
  const l = await lote(servico(), app, enf, med, 500);
  const d = await prescreverComDose(servico(), enf, idoso.id, med, extra);
  return { idoso, med, lote: l, ...d };
}

describe("dose atrasada e sem registro", () => {
  it("atrasada → sem registro (e-mail) → escala ao gestor → fecha sozinha quando lançam", async () => {
    const d = await doseDasOito();
    agora = min(30);
    await verificar();
    expect(await abertos()).toEqual([]);

    agora = min(31);
    expect(await verificar()).toMatchObject({ abertos: 1, envios: 0 }); // aviso: só no painel
    expect(await abertos()).toEqual([
      expect.objectContaining({
        chave: `dose_atrasada:${d.doseId}`,
        gravidade: "aviso",
        destino: "enfermeiro",
      }),
    ]);
    expect((await listarAlertas(servico(), enf))[0]?.titulo).toBe(
      "Dose atrasada: Dona Alerta, Remedio Alerta das 08:00",
    );

    agora = min(121);
    const v = await verificar();
    expect(v).toMatchObject({ abertos: 1, resolvidos: 1 });
    expect(await abertos()).toEqual([
      expect.objectContaining({
        chave: `dose_sem_registro:${d.doseId}`,
        gravidade: "urgente",
        destino: "enfermeiro",
      }),
    ]);
    // Urgente: e-mail para a enfermagem.
    expect((await envios()).map((e) => [e.motivo, e.usuario_id])).toEqual([
      ["novo", enf.usuarioId],
    ]);

    agora = min(121 + 119);
    expect(await verificar()).toMatchObject({ escalados: 0 });
    agora = min(121 + 120);
    expect(await verificar()).toMatchObject({ escalados: 1 });
    expect((await abertos())[0]?.destino).toBe("gestor");
    // Escala para TODA a gestão da casa (e só para ela).
    const escalados = (await envios())
      .filter((e) => e.motivo === "escalonamento")
      .map((e) => e.usuario_id);
    expect(escalados).toContain(gestor.usuarioId);
    expect(await perfisDe(escalados)).toEqual(["gestor"]);

    // Lançado como registro tardio: o alerta fecha sozinho e o e-mail pendente é descartado.
    agora = min(250);
    const t = await registrarTardio(servico(), confirmado(cuidador), {
      chave: nova(),
      doseId: d.doseId,
      resultado: "administrada",
      ocorridaEm: min(10).toISOString(),
      motivo: "Sistema fora do ar: anotado na folha",
      lote: d.lote.qr,
    });
    expect(t.ok).toBe(true);
    expect(await verificar()).toMatchObject({ resolvidos: 1 });
    expect(await abertos()).toEqual([]);
    expect((await alertas()).at(-1)).toMatchObject({
      estado: "resolvido",
      resolucao: "automatica",
    });
    expect((await envios()).every((e) => e.estado !== "pendente")).toBe(true);
  });

  it("lido a tempo não escala; mas o fim do plantão sem registro leva ao gestor do mesmo jeito", async () => {
    const d = await doseDasOito();
    agora = min(121);
    await verificar();
    agora = min(150);
    expect(
      (await marcarComoLido(servico(), enf, { alertaId: await idDoAlerta("dose_sem_registro") }))
        .ok,
    ).toBe(true);
    agora = hrs(6);
    expect(await verificar()).toMatchObject({ escalados: 0, reavisados: 0 });
    // Plantão das 07:00 às 19:00 (22:00Z): às 19:00 ainda sem registro, vai para o gestor.
    agora = new Date("2026-03-10T22:00:00Z");
    expect(await verificar()).toMatchObject({ escalados: 1 });
    expect((await abertos())[0]).toMatchObject({
      destino: "gestor",
      chave: `dose_sem_registro:${d.doseId}`,
    });
  });

  it("dose registrada a tempo, recusada ou adiada não gera alerta indevido", async () => {
    const d = await doseDasOito();
    agora = min(10);
    const adiou = await registrarDose(servico(), cuidador, {
      chave: nova(),
      doseId: d.doseId,
      resultado: "adiada",
      pulseira: d.idoso.pulseira,
      motivo: "Paciente dormindo",
      adiadaPara: min(60).toISOString(),
    });
    expect(adiou.ok).toBe(true);
    // A janela conta do novo horário: às 08:45 ainda não está atrasada.
    agora = min(45);
    await verificar();
    expect(await abertos()).toEqual([]);
    agora = min(91);
    await verificar();
    expect((await abertos()).map((a) => a.tipo)).toEqual(["dose_atrasada"]);
    const r = await registrarDose(servico(), cuidador, {
      chave: nova(),
      doseId: d.doseId,
      resultado: "recusada",
      pulseira: d.idoso.pulseira,
      motivo: "Recusou",
    });
    expect(r.ok).toBe(true);
    await verificar();
    expect(await abertos()).toEqual([]);
  });
});

describe("estoque, validade e prescrição", () => {
  it("estoque acabando: aviso, urgente (com e-mail) e fecha quando chega lote novo", async () => {
    agora = min(-60);
    const idoso = await idosoComPulseira(servico(), enf, "Seu Estoque");
    const med = await medicamento(servico(), enf, { nome: "Losartana" });
    const l = await lote(servico(), app, enf, med, 10, { idosoId: idoso.id });
    await prescreverComDose(servico(), enf, idoso.id, med, {
      horarios: [{ hora: "08:00" }, { hora: "20:00" }],
    });
    agora = min(-30);
    await verificar();
    // 10 comprimidos, 2 por dia: acaba em 5 dias → aviso.
    expect(await abertos()).toEqual([
      expect.objectContaining({ tipo: "estoque_acabando", gravidade: "aviso" }),
    ]);
    expect((await listarAlertas(servico(), enf))[0]?.titulo).toBe(
      "Losartana 10 mg de Seu Estoque acaba em 5 dias",
    );
    await lancarSaida(servico(), confirmado(enf), {
      loteId: l.id,
      tipo: "perda",
      quantidade: 5,
      motivo: "Caiu no ralo da pia",
    });
    await verificar();
    expect(await abertos()).toEqual([
      expect.objectContaining({ tipo: "estoque_acabando", gravidade: "urgente" }),
    ]);
    expect((await envios()).map((e) => e.motivo)).toEqual(["agravado"]);
    await lote(servico(), app, enf, med, 60, { idosoId: idoso.id });
    await verificar();
    expect(await abertos()).toEqual([]);
  });

  it("validade próxima, lote vencido em estoque, e o descarte fecha o alerta", async () => {
    agora = new Date("2026-02-01T12:00:00Z");
    const med = await medicamento(servico(), enf, { nome: "Dipirona" });
    const vencendo = await lote(servico(), app, enf, med, 10, { validade: "2026-03-30" });
    const vai = await lote(servico(), app, enf, med, 10, { validade: "2026-03-09" });
    agora = min(-30);
    await verificar();
    const a = await abertos();
    expect(a).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chave: `validade:${vencendo.id}`, gravidade: "aviso" }),
        expect.objectContaining({
          chave: `vencido:${vai.id}`,
          tipo: "lote_vencido",
          gravidade: "urgente",
        }),
      ]),
    );
    const r = await lancarSaida(servico(), confirmado(enf), {
      loteId: vai.id,
      tipo: "descarte",
      descartarTudo: true,
      motivo: "Lote vencido",
    });
    expect(r.ok).toBe(true);
    await verificar();
    expect((await abertos()).map((x) => x.chave)).toEqual([`validade:${vencendo.id}`]);
  });

  it("prescrição perto do fim: aviso com 5 dias, urgente no último dia", async () => {
    agora = min(-60);
    const idoso = await idosoComPulseira(servico(), enf);
    const med = await medicamento(servico(), enf, { nome: "Amoxicilina" });
    await lote(servico(), app, enf, med, 500);
    await prescreverComDose(servico(), enf, idoso.id, med, { fim: "2026-03-14" });
    await verificar();
    expect(await abertos()).toEqual([
      expect.objectContaining({ tipo: "prescricao_vencendo", gravidade: "aviso" }),
    ]);
    agora = new Date("2026-03-14T12:00:00Z");
    await verificar();
    expect((await abertos()).filter((x) => x.tipo === "prescricao_vencendo")).toEqual([
      expect.objectContaining({ gravidade: "urgente" }),
    ]);
  });
});

describe("exceções e SOS", () => {
  it("resumo de ontem para o gestor fecha ao ser lido e não reabre; repetidas pela mesma pessoa, urgente", async () => {
    const enfermeira = await pessoaComPin(migrador, casa, "enfermeiro");
    for (let i = 0; i < 3; i += 1) {
      const d = await doseDasOito();
      agora = PREVISTA;
      const r = await registrarDose(servico(), cuidador, {
        chave: nova(),
        doseId: d.doseId,
        resultado: "administrada",
        pulseira: d.idoso.pulseira,
        excecao: {
          loteId: d.lote.id,
          motivo: "etiqueta_ilegivel",
          justificativa: "Etiqueta molhada, conferido na caixa",
          liberador: { usuarioId: enfermeira.id, pin: PIN },
        },
      });
      expect(r.ok).toBe(true);
    }
    agora = new Date("2026-03-11T12:00:00Z");
    await verificar();
    const a = await abertos();
    expect(a.map((x) => [x.tipo, x.gravidade, x.destino])).toEqual(
      expect.arrayContaining([
        ["excecoes_do_dia", "aviso", "gestor"],
        ["excecoes_repetidas", "urgente", "gestor"],
      ]),
    );
    const lido = await marcarComoLido(servico(), gestor, {
      alertaId: await idDoAlerta("excecoes_dia"),
    });
    expect(lido).toEqual({ ok: true, fechado: true });
    await verificar();
    expect((await abertos()).map((x) => x.tipo)).not.toContain("excecoes_do_dia");
    expect((await alertas()).find((x) => x.tipo === "excecoes_do_dia")).toMatchObject({
      resolucao: "lido",
    });
  });

  it("SOS pedido além do limite avisa a enfermagem", async () => {
    agora = min(-60);
    const idoso = await idosoComPulseira(servico(), enf, "Dona Dor");
    const med = await medicamento(servico(), enf, { nome: "Paracetamol" });
    const l = await lote(servico(), app, enf, med, 50);
    const p = await prescrever(servico(), enf, {
      idosoId: idoso.id,
      medicamentoId: med,
      tipo: "sos",
      dose: 1,
      unidade: "comprimido",
      via: "oral",
      inicio: "2026-03-10",
      fim: null,
      altoRisco: false,
      horarios: [],
      sos: { indicacao: "Dor", limiteDiario: 1, intervaloMinimoMin: 60 },
    });
    if (!p.ok) throw new Error("sos");
    agora = PREVISTA;
    const dar = () =>
      registrarSos(servico(), cuidador, {
        chave: nova(),
        prescricaoId: p.prescricaoId,
        pulseira: idoso.pulseira,
        lote: l.qr,
        sintoma: "Dor de cabeça",
      });
    expect((await dar()).ok).toBe(true);
    agora = hrs(2);
    expect(await dar()).toMatchObject({ motivo: "limite_sos" });
    await verificar();
    const a = (await listarAlertas(servico(), enf)).find((x) => x.tipo === "sos_bloqueado");
    expect(a).toMatchObject({
      informativo: true,
      titulo: 'Dona Dor pediu Paracetamol "se necessário" além do limite',
    });
  });
});

describe("quem tratou não é incomodado", () => {
  it("encerrado à mão não reabre igual, mas reabre se piorar", async () => {
    agora = min(-60);
    const idoso = await idosoComPulseira(servico(), enf);
    const med = await medicamento(servico(), enf, { nome: "Metformina" });
    const l = await lote(servico(), app, enf, med, 10, { idosoId: idoso.id });
    await prescreverComDose(servico(), enf, idoso.id, med, {
      horarios: [{ hora: "08:00" }, { hora: "20:00" }],
    });
    await verificar();
    const id = await idDoAlerta("estoque");
    expect(
      await encerrarAlerta(servico(), enf, { alertaId: id, justificativa: "ok" }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    expect(
      await encerrarAlerta(servico(), enf, {
        alertaId: id,
        justificativa: "Compra feita, chega amanhã",
      }),
    ).toEqual({ ok: true });
    expect(
      await encerrarAlerta(servico(), enf, { alertaId: id, justificativa: "De novo encerrando" }),
    ).toEqual({ ok: false, motivo: "ja_resolvido" });
    await verificar();
    expect(await abertos()).toEqual([]);
    await lancarSaida(servico(), confirmado(enf), {
      loteId: l.id,
      tipo: "perda",
      quantidade: 5,
      motivo: "Frasco quebrado",
    });
    await verificar();
    expect(await abertos()).toEqual([
      expect.objectContaining({ tipo: "estoque_acabando", gravidade: "urgente" }),
    ]);
    const lista = await listarAlertas(servico(), enf, { estado: "resolvido" });
    expect(lista[0]).toMatchObject({
      resolucao: "manual",
      justificativa: "Compra feita, chega amanhã",
      resolvidoPor: enf.usuario.nome,
    });
  });

  it("urgente não lido recebe reaviso; depois de lido, não", async () => {
    const d = await doseDasOito();
    agora = min(121);
    await verificar(); // novo (urgente)
    agora = min(121 + 120);
    await verificar(); // escalonamento
    agora = min(121 + 120 + 240);
    expect(await verificar()).toMatchObject({ reavisados: 1 });
    expect([...new Set((await envios()).map((e) => e.motivo))]).toEqual([
      "novo",
      "escalonamento",
      "reaviso",
    ]);
    await marcarComoLido(servico(), gestor, {
      alertaId: await idDoAlerta(`dose_sem_registro:${d.doseId}`),
    });
    agora = min(121 + 120 + 240 + 300);
    expect(await verificar()).toMatchObject({ reavisados: 0 });
    const r = await resumoDosAlertas(servico(), gestor);
    expect(r).toEqual({ abertos: 1, urgentes: 1, naoLidosPorMim: 0 });
    expect((await resumoDosAlertas(servico(), enf)).naoLidosPorMim).toBe(1);
  });
});

describe("e-mail", () => {
  it("envia sem dados de saúde, tenta de novo com espera e desiste depois do limite", async () => {
    await doseDasOito();
    agora = min(121);
    await verificar();
    const correio = new CorreioEmMemoria();
    correio.falharProximas = 1;
    expect(
      await enviarAlertasDaCasa(servico(), casa, correio, "https://app.exemplo/painel"),
    ).toMatchObject({ enviados: 0, falhas: 1 });
    const [e] = await envios();
    expect(e).toMatchObject({ estado: "pendente", tentativas: 1 });
    expect(e?.proxima_em.getTime()).toBe(min(122).getTime());
    // Antes da espera, nada sai.
    expect(await enviarAlertasDaCasa(servico(), casa, correio, "x")).toMatchObject({
      enviados: 0,
      falhas: 0,
    });
    agora = min(122);
    expect(
      await enviarAlertasDaCasa(servico(), casa, correio, "https://app.exemplo/painel"),
    ).toMatchObject({ enviados: 1 });
    expect(correio.enviadas).toHaveLength(1);
    const m = correio.enviadas[0];
    expect(m?.para).toBe(enf.usuario.email);
    expect(m?.assunto).toBe("[Urgente] Alerta no ILPI Medicação: Casa dos alertas");
    for (const proibido of ["Dona Alerta", "Remedio Alerta", "08:00", "dose", "sem registro"]) {
      expect(`${m?.assunto} ${m?.texto}`).not.toContain(proibido);
    }

    // Servidor de e-mail fora do ar: desiste depois do limite, e o alerta continua no painel.
    agora = min(121 + 120);
    await verificar(); // escalonamento → e-mail para o gestor
    correio.falharProximas = 100;
    for (let i = 0; i < MAXIMO_DE_TENTATIVAS + 2; i += 1) {
      agora = new Date(agora.getTime() + 4 * 3_600_000);
      await enviarAlertasDaCasa(servico(), casa, correio, "x");
    }
    expect((await envios()).find((x) => x.motivo === "escalonamento")).toMatchObject({
      estado: "falhou",
      tentativas: MAXIMO_DE_TENTATIVAS,
    });
    expect((await abertos()).length).toBe(1);
  });

  it("e-mail de alerta já resolvido, ou para quem saiu da casa, é descartado", async () => {
    await doseDasOito();
    agora = min(121);
    await verificar();
    // A enfermeira saiu da casa depois que o alerta abriu.
    expect(
      (await desativarUsuario(servico(), confirmado(gestor), { usuarioId: enf.usuarioId })).ok,
    ).toBe(true);
    const correio = new CorreioEmMemoria();
    expect(await enviarAlertasDaCasa(servico(), casa, correio, "x")).toMatchObject({
      enviados: 0,
      descartados: 1,
    });
    expect(correio.enviadas).toEqual([]);
  });
});

describe("isolamento, permissões, concorrência e configuração", () => {
  it("outra casa não vê, não lê e não encerra os alertas desta", async () => {
    await doseDasOito();
    agora = min(121);
    await verificar();
    const id = await idDoAlerta("dose_sem_registro");
    const casaB = await criarCasa(migrador, "Casa B dos alertas");
    const enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
    expect(await listarAlertas(servico(), enfB)).toEqual([]);
    expect(await marcarComoLido(servico(), enfB, { alertaId: id })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(
      await encerrarAlerta(servico(), enfB, {
        alertaId: id,
        justificativa: "tentativa de outra casa",
      }),
    ).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect((await abertos()).length).toBe(1);
  });

  it("cuidador não vê o painel; enfermeiro não muda a configuração", async () => {
    await expect(listarAlertas(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(resumoDosAlertas(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      configurarAlertas(servico(), confirmado(enf), { estoqueAvisoDias: 10 }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      configurarAlertas(servico(), gestor, { estoqueAvisoDias: 10 }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
  });

  it("o gestor ajusta os limites; a próxima verificação já segue", async () => {
    agora = min(-60);
    const idoso = await idosoComPulseira(servico(), enf);
    const med = await medicamento(servico(), enf);
    await lote(servico(), app, enf, med, 20, { idosoId: idoso.id });
    await prescreverComDose(servico(), enf, idoso.id, med, {
      horarios: [{ hora: "08:00" }, { hora: "20:00" }],
    });
    await verificar(); // 20 comprimidos, 2 por dia: 10 dias, sem alerta
    expect(await abertos()).toEqual([]);
    expect(
      await configurarAlertas(servico(), confirmado(gestor), {
        estoqueAvisoDias: 5,
        estoqueUrgenteDias: 6,
      }),
    ).toMatchObject({
      motivo: "dados_invalidos",
    });
    const r = await configurarAlertas(servico(), confirmado(gestor), { prazoReposicaoDias: 12 });
    expect(r.ok && r.configuracao.prazoReposicaoDias).toBe(12);
    await verificar();
    expect(await abertos()).toEqual([
      expect.objectContaining({ tipo: "estoque_acabando", gravidade: "aviso" }),
    ]);
  });

  it("duas verificações ao mesmo tempo: uma pula, e não há alerta duplicado", async () => {
    await doseDasOito();
    agora = min(121);
    const r = await Promise.all([verificar(), verificar(), verificar()]);
    expect(r.filter((x) => !x.pulada).length).toBeGreaterThanOrEqual(1);
    expect(r.reduce((t, x) => t + x.abertos, 0)).toBe(1);
    expect((await abertos()).length).toBe(1);
  });

  it("a rodada do agendador verifica e envia em todas as casas, com o papel do agendador", async () => {
    await doseDasOito();
    agora = min(121);
    const correio = new CorreioEmMemoria();
    const r = await alertasDeTodasAsCasas(
      { pool: agendador, agora: () => agora },
      { correio, linkDoPainel: "https://app.exemplo/painel" },
    );
    expect(r.falhas).toEqual([]);
    expect(r.casas).toBeGreaterThanOrEqual(1);
    expect(correio.enviadas.map((m) => m.para)).toContain(enf.usuario.email);
    expect((await abertos()).length).toBe(1);
  });
});
