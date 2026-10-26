import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  configurarJanela,
  escalaDoPlantao,
  listarSosDoIdoso,
  obterJanela,
  registrarDose,
  registrarSos,
  registrarTardio,
  type RegistroSos,
  type RegistroTardio,
} from "@/modules/administracao";
import { ErroDePermissao, ErroDeReautenticacao, type Servico } from "@/modules/identidade";
import { encerrarPrescricao, novaVersao, prescrever } from "@/modules/prescricoes";
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
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import { acoesDeAuditoria, saldoDoLote } from "../ajudantes/estoque";
import { criarAtorTablet, criarAtorWeb, type AtorTablet, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const PREVISTA = new Date("2026-03-10T11:00:00Z"); // 08:00 em São Paulo
const minutos = (m: number) => new Date(PREVISTA.getTime() + m * 60_000);
const horas = (h: number) => minutos(h * 60);

let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let agora: Date;
let enf: AtorWeb;
let gestor: AtorWeb;
let cuidador: AtorTablet;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const confirmado = <A extends { reautenticadoEm: Date | null }>(a: A): A => ({
  ...a,
  reautenticadoEm: agora,
});

beforeAll(async () => {
  app = criarPoolApp(10);
  migrador = criarPoolMigrador();
  agora = minutos(-60);
  casa = await criarCasa(migrador, "Casa do SOS e do tardio");
  enf = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
  gestor = await criarAtorWeb(servico, migrador, casa, "gestor");
  cuidador = await criarAtorTablet(servico, migrador, casa);
});

beforeEach(() => {
  agora = minutos(-60);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

// ---------------------------------------------------------------------------------------------
// SOS

async function cenarioSos(
  extra: { limiteDiario?: number; intervaloMinimoMin?: number; altoRisco?: boolean } = {},
) {
  agora = minutos(-60);
  const idoso = await idosoComPulseira(servico(), enf);
  const med = await medicamento(servico(), enf);
  const l = await lote(servico(), app, enf, med, 20);
  const r = await prescrever(servico(), enf, {
    idosoId: idoso.id,
    medicamentoId: med,
    tipo: "sos",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: "2026-03-10",
    fim: null,
    altoRisco: extra.altoRisco ?? false,
    horarios: [],
    sos: {
      indicacao: "Dor de cabeça",
      limiteDiario: extra.limiteDiario ?? 3,
      intervaloMinimoMin: extra.intervaloMinimoMin ?? 240,
    },
  });
  if (!r.ok)
    throw new Error(`sos: ${r.motivo} ${JSON.stringify("problemas" in r ? r.problemas : "")}`);
  agora = PREVISTA;
  return { idoso, med, lote: l, prescricaoId: r.prescricaoId };
}

const sos = (c: Awaited<ReturnType<typeof cenarioSos>>, extra: Partial<RegistroSos> = {}) =>
  registrarSos(servico(), cuidador, {
    chave: nova(),
    prescricaoId: c.prescricaoId,
    pulseira: c.idoso.pulseira,
    lote: c.lote.qr,
    sintoma: "Queixa de dor de cabeça",
    ...extra,
  });

describe("doses SOS", () => {
  it("registra com o sintoma, baixa o lote e aparece na lista com a próxima liberação", async () => {
    const c = await cenarioSos();
    const antes = await listarSosDoIdoso(servico(), cuidador, c.idoso.id);
    expect(antes.ok && antes.sos).toEqual([
      expect.objectContaining({
        prescricaoId: c.prescricaoId,
        indicacao: "Dor de cabeça",
        dosesNas24h: 0,
        liberaEm: null,
      }),
    ]);
    const r = await sos(c);
    expect(r).toMatchObject({ ok: true, repetido: false, saldoDoLote: 19 });
    const depois = await listarSosDoIdoso(servico(), cuidador, c.idoso.id);
    expect(depois.ok && depois.sos[0]).toMatchObject({
      dosesNas24h: 1,
      ultimaEm: PREVISTA.toISOString(),
      liberaEm: horas(4).toISOString(),
      motivoDoBloqueio: "intervalo_minimo",
    });
    const a = await linhas<{ motivo: string; dose_agendada_id: string | null }>(
      app,
      casa,
      "SELECT motivo, dose_agendada_id FROM administracao WHERE prescricao_id = $1",
      [c.prescricaoId],
    );
    expect(a).toEqual([{ motivo: "Queixa de dor de cabeça", dose_agendada_id: null }]);
  });

  it("respeita o intervalo mínimo e o limite em 24 horas (janela móvel), e deixa o bloqueio na trilha", async () => {
    const c = await cenarioSos({ limiteDiario: 2, intervaloMinimoMin: 120 });
    expect((await sos(c)).ok).toBe(true);
    agora = horas(1);
    expect(await sos(c)).toMatchObject({
      ok: false,
      motivo: "limite_sos",
      limite: "intervalo_minimo",
      liberaEm: horas(2).toISOString(),
    });
    agora = horas(2);
    expect((await sos(c)).ok).toBe(true);
    agora = horas(5);
    const r = await sos(c);
    expect(r).toMatchObject({
      motivo: "limite_sos",
      limite: "limite_diario",
      liberaEm: horas(24).toISOString(),
    });
    expect(r.ok === false && "mensagem" in r && r.mensagem).toMatch(/24 horas/);
    agora = horas(24);
    expect((await sos(c)).ok).toBe(true);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(17);
    expect(await acoesDeAuditoria(app, casa, c.prescricaoId)).toContain(
      "administracao.sos_bloqueada",
    );
  });

  it("corrigir a prescrição não zera a contagem: o limite vale para todas as versões", async () => {
    const c = await cenarioSos({ limiteDiario: 1, intervaloMinimoMin: 60 });
    expect((await sos(c)).ok).toBe(true);
    agora = horas(1);
    const v = await novaVersao(servico(), enf, {
      prescricaoId: c.prescricaoId,
      justificativa: "Ajuste de indicação",
      conteudo: {
        medicamentoId: c.med,
        tipo: "sos",
        dose: 1,
        unidade: "comprimido",
        via: "oral",
        inicio: "2026-03-10",
        fim: null,
        altoRisco: false,
        horarios: [],
        sos: { indicacao: "Dor ou febre", limiteDiario: 1, intervaloMinimoMin: 60 },
      },
    });
    if (!v.ok) throw new Error("nova versão");
    agora = horas(2);
    expect(await sos({ ...c, prescricaoId: v.prescricaoId })).toMatchObject({
      motivo: "limite_sos",
      limite: "limite_diario",
    });
    // A versão antiga não vale mais.
    expect(await sos(c)).toMatchObject({
      motivo: "conferencia_bloqueada",
      bloqueios: [{ codigo: "prescricao_encerrada" }],
    });
  });

  it("duas doses SOS ao mesmo tempo não furam o intervalo", async () => {
    const c = await cenarioSos({ limiteDiario: 6, intervaloMinimoMin: 60 });
    const r = await Promise.all(Array.from({ length: 4 }, () => sos(c)));
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok && x.motivo === "limite_sos")).toHaveLength(3);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(19);
  });

  it("passa pela mesma conferência: pulseira, remédio, sintoma; e o SOS de alto risco pede a segunda pessoa", async () => {
    const c = await cenarioSos({ altoRisco: true });
    const outro = await idosoComPulseira(servico(), enf);
    expect(await sos(c, { pulseira: outro.pulseira })).toMatchObject({
      bloqueios: [{ codigo: "pulseira_de_outro_idoso" }],
    });
    expect(await sos(c, { sintoma: "  " })).toMatchObject({ motivo: "dados_invalidos" });
    expect(await sos(c)).toEqual({ ok: false, motivo: "segunda_validacao_necessaria" });
    const colega = await pessoaComPin(migrador, casa, "cuidador");
    expect((await sos(c, { segundaValidacao: { usuarioId: colega.id, pin: PIN } })).ok).toBe(true);
  });

  it("prescrição regular não é SOS; a chave repetida devolve o mesmo registro", async () => {
    agora = minutos(-60);
    const idoso = await idosoComPulseira(servico(), enf);
    const med = await medicamento(servico(), enf);
    const l = await lote(servico(), app, enf, med, 5);
    const regular = await prescreverComDose(servico(), enf, idoso.id, med);
    agora = PREVISTA;
    expect(
      await registrarSos(servico(), cuidador, {
        chave: nova(),
        prescricaoId: regular.prescricaoId,
        pulseira: idoso.pulseira,
        lote: l.qr,
        sintoma: "Dor",
      }),
    ).toEqual({ ok: false, motivo: "nao_e_sos" });

    const c = await cenarioSos();
    const chave = nova();
    const a = await sos(c, { chave });
    const b = await sos(c, { chave });
    expect(a).toMatchObject({ ok: true, repetido: false });
    expect(b).toMatchObject({ ok: true, repetido: true });
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(19);
  });
});

// ---------------------------------------------------------------------------------------------
// Registro tardio

async function cenarioTardio(extra: Parameters<typeof prescreverComDose>[4] = {}) {
  agora = minutos(-60);
  const idoso = await idosoComPulseira(servico(), enf);
  const med = await medicamento(servico(), enf);
  const l = await lote(servico(), app, enf, med, 10);
  const { prescricaoId, doseId } = await prescreverComDose(servico(), enf, idoso.id, med, extra);
  agora = horas(5); // o sistema voltou; a dose das 08:00 passou do limite
  return { idoso, med, lote: l, prescricaoId, doseId };
}

const tardio = (
  c: Awaited<ReturnType<typeof cenarioTardio>>,
  extra: Partial<RegistroTardio> = {},
  ator: AtorTablet | AtorWeb = confirmado(cuidador),
) =>
  registrarTardio(servico(), ator, {
    chave: nova(),
    doseId: c.doseId,
    resultado: "administrada",
    ocorridaEm: minutos(5).toISOString(),
    motivo: "Sem internet: registrado na folha de contingência",
    lote: c.lote.qr,
    ...extra,
  });

describe("registro tardio", () => {
  it("lança a dose com o horário real, marca como tardio e baixa o estoque", async () => {
    const c = await cenarioTardio();
    // O registro normal já não serve: passou do limite.
    expect(
      await registrarDose(servico(), cuidador, {
        chave: nova(),
        doseId: c.doseId,
        resultado: "administrada",
        pulseira: c.idoso.pulseira,
        lote: c.lote.qr,
        motivo: "atraso",
      }),
    ).toMatchObject({ bloqueios: [{ codigo: "horario_expirado" }] });

    const r = await tardio(c);
    expect(r).toMatchObject({ ok: true, saldoDoLote: 9 });
    const a = await linhas<{ metodo: string; ocorrida_em: Date; registrada_em: Date }>(
      app,
      casa,
      "SELECT metodo, ocorrida_em, registrada_em FROM administracao WHERE dose_agendada_id = $1",
      [c.doseId],
    );
    expect(a).toEqual([{ metodo: "tardio", ocorrida_em: minutos(5), registrada_em: horas(5) }]);
    expect(await acoesDeAuditoria(app, casa, r.ok ? r.administracaoId : "")).toEqual([
      "administracao.registro_tardio",
    ]);
    const escala = await escalaDoPlantao(servico(), cuidador);
    expect(escala.ok && escala.escala.doses.find((d) => d.id === c.doseId)?.registro).toMatchObject(
      {
        tardio: true,
        ocorridaEm: minutos(5).toISOString(),
      },
    );
  });

  it("pede a senha ou o PIN de novo", async () => {
    const c = await cenarioTardio();
    await expect(tardio(c, {}, { ...cuidador, reautenticadoEm: null })).rejects.toBeInstanceOf(
      ErroDeReautenticacao,
    );
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(10);
  });

  it("recusa horário no futuro, longe demais da dose, e lançamento depois do prazo", async () => {
    const c = await cenarioTardio();
    expect(await tardio(c, { ocorridaEm: horas(6).toISOString() })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(await tardio(c, { ocorridaEm: minutos(-121).toISOString() })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(await tardio(c, { ocorridaEm: "ontem" })).toMatchObject({ motivo: "dados_invalidos" });
    expect(await tardio(c, { motivo: "" })).toMatchObject({ motivo: "dados_invalidos" });
    agora = horas(24 * 8);
    expect(await tardio(c, {}, confirmado(cuidador))).toEqual({
      ok: false,
      motivo: "prazo_do_registro_tardio",
    });
  });

  it("vale a prescrição e a validade do momento da dose, não as de agora", async () => {
    // Encerrada depois da dose: o lançamento continua valendo.
    const c = await cenarioTardio();
    agora = horas(3);
    await encerrarPrescricao(servico(), enf, {
      prescricaoId: c.prescricaoId,
      motivo: "Suspenso hoje à tarde",
    });
    agora = horas(5);
    expect((await tardio(c)).ok).toBe(true);

    // Lote que venceu no próprio dia 10 (último dia de uso): valia às 08:05.
    const d = await cenarioTardio();
    agora = new Date("2026-02-01T12:00:00Z");
    const ateHoje = await lote(servico(), app, enf, d.med, 5, { validade: "2026-03-10" });
    agora = new Date("2026-03-11T13:00:00Z"); // dia seguinte: já vencido agora
    expect((await tardio(d, { lote: ateHoje.qr }, confirmado(cuidador))).ok).toBe(true);
  });

  it("alergia, remédio errado e dose já registrada continuam bloqueando; alto risco pede a segunda pessoa", async () => {
    const c = await cenarioTardio({ altoRisco: true });
    const outroRemedio = await lote(servico(), app, enf, await medicamento(servico(), enf), 10);
    expect(await tardio(c, { lote: outroRemedio.qr })).toMatchObject({
      bloqueios: [{ codigo: "medicamento_errado" }],
    });
    expect(await tardio(c)).toEqual({ ok: false, motivo: "segunda_validacao_necessaria" });
    const colega = await pessoaComPin(migrador, casa, "cuidador");
    expect((await tardio(c, { segundaValidacao: { usuarioId: colega.id, pin: PIN } })).ok).toBe(
      true,
    );
    expect(await tardio(c, { segundaValidacao: { usuarioId: colega.id, pin: PIN } })).toMatchObject(
      {
        bloqueios: [{ codigo: "dose_ja_registrada" }],
      },
    );
  });

  it("recusa anotada na folha também se lança, sem lote", async () => {
    const c = await cenarioTardio();
    expect(await tardio(c, { resultado: "recusada", lote: c.lote.qr })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(
      (
        await tardio(c, {
          resultado: "recusada",
          lote: undefined,
          motivo: "Recusou; anotado na folha",
        })
      ).ok,
    ).toBe(true);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
// Janela configurável

describe("janela de tolerância da casa", () => {
  it("o gestor ajusta (com a senha confirmada) e o registro passa a seguir a nova janela", async () => {
    agora = minutos(-60);
    const idoso = await idosoComPulseira(servico(), enf);
    const med = await medicamento(servico(), enf);
    const l = await lote(servico(), app, enf, med, 10);
    const { doseId } = await prescreverComDose(servico(), enf, idoso.id, med);
    expect(await obterJanela(servico(), cuidador)).toEqual({ janelaMin: 30, limiteMaiorMin: 120 });

    await expect(
      configurarJanela(servico(), gestor, { janelaMinutos: 10, limiteMaiorMinutos: 60 }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    await expect(
      configurarJanela(servico(), confirmado(enf), { janelaMinutos: 10, limiteMaiorMinutos: 60 }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    expect(
      await configurarJanela(servico(), confirmado(gestor), {
        janelaMinutos: 60,
        limiteMaiorMinutos: 30,
      }),
    ).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(
      await configurarJanela(servico(), confirmado(gestor), {
        janelaMinutos: 2,
        limiteMaiorMinutos: 60,
      }),
    ).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(
      await configurarJanela(servico(), confirmado(gestor), {
        janelaMinutos: 10,
        limiteMaiorMinutos: 60,
      }),
    ).toEqual({
      ok: true,
      janela: { janelaMin: 10, limiteMaiorMin: 60 },
    });
    expect(await acoesDeAuditoria(app, casa, casa)).toContain("configuracao.janela_alterada");

    try {
      agora = minutos(20); // dentro da janela antiga (30), fora da nova (10)
      expect(
        await registrarDose(servico(), cuidador, {
          chave: nova(),
          doseId,
          resultado: "administrada",
          pulseira: idoso.pulseira,
          lote: l.qr,
        }),
      ).toEqual({ ok: false, motivo: "motivo_obrigatorio", sentido: "atrasado" });
    } finally {
      await configurarJanela(servico(), confirmado(gestor), {
        janelaMinutos: 30,
        limiteMaiorMinutos: 120,
      });
    }
  });
});
