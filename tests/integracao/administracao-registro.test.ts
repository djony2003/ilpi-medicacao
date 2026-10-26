import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  conferirDoseAgendada,
  escalaDoPlantao,
  registrarDose,
  type RegistroDeDose,
} from "@/modules/administracao";
import { ErroDePermissao, type Servico } from "@/modules/identidade";
import { encerrarPrescricao, novaVersao } from "@/modules/prescricoes";
import {
  PIN,
  alergia,
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

// Registro da dose agendada (spec 5.2 a 5.6) contra o PostgreSQL real.
//
// Relógio: a casa fica em America/Sao_Paulo (UTC-3). A dose das 08:00 de 10/03 está prevista
// para 11:00Z. Cada teste começa às 07:00 locais (para a geração incluir a dose) e avança o
// relógio até o momento do registro.

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const PREVISTA = new Date("2026-03-10T11:00:00Z");
const minutos = (m: number) => new Date(PREVISTA.getTime() + m * 60_000);

let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let agora: Date;
let enf: AtorWeb;
let cuidador: AtorTablet;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });

/** Um idoso, um remédio, um lote de 10 e a dose das 08:00. */
async function cenario(extra: Parameters<typeof prescreverComDose>[4] = {}) {
  agora = minutos(-60);
  const idoso = await idosoComPulseira(servico(), enf);
  const med = await medicamento(servico(), enf);
  const l = await lote(servico(), app, enf, med, 10);
  const { prescricaoId, doseId } = await prescreverComDose(servico(), enf, idoso.id, med, extra);
  agora = PREVISTA;
  return { idoso, med, lote: l, prescricaoId, doseId };
}

const registrar = (e: Partial<RegistroDeDose> & { doseId: string }, ator = cuidador) =>
  registrarDose(servico(), ator, { chave: nova(), resultado: "administrada", ...e });

const administracoesDa = (doseId: string) =>
  linhas<{
    resultado: string;
    metodo: string;
    fora_da_janela: string | null;
    liberada_por: string | null;
  }>(
    app,
    casa,
    "SELECT resultado, metodo, fora_da_janela, liberada_por FROM administracao WHERE dose_agendada_id = $1 ORDER BY seq",
    [doseId],
  );

beforeAll(async () => {
  app = criarPoolApp(12);
  migrador = criarPoolMigrador();
  agora = minutos(-60);
  casa = await criarCasa(migrador, "Casa do registro");
  enf = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
  cuidador = await criarAtorTablet(servico, migrador, casa);
});

beforeEach(() => {
  agora = minutos(-60);
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("fluxo normal", () => {
  it("pulseira, etiqueta e registro: grava, baixa o lote e a escala mostra a dose concluída", async () => {
    const c = await cenario();

    const so = await conferirDoseAgendada(servico(), cuidador, {
      doseId: c.doseId,
      pulseira: c.idoso.pulseira,
    });
    if (!so.ok) throw new Error("conferir");
    expect(so.conferencia).toMatchObject({
      pulseiraConferida: true,
      lote: null,
      bloqueios: [],
      horario: { tipo: "livre" },
      exigeSegundaValidacao: false,
    });
    expect(so.conferencia.dose).toMatchObject({
      horaLocal: "08:00",
      dose: 1,
      unidade: "comprimido",
    });

    const ambos = await conferirDoseAgendada(servico(), cuidador, {
      doseId: c.doseId,
      pulseira: c.idoso.pulseira,
      lote: c.lote.qr,
    });
    expect(ambos.ok && ambos.conferencia.lote).toMatchObject({ saldo: 10, unidade: "comprimido" });

    const r = await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr });
    expect(r).toMatchObject({
      ok: true,
      resultado: "administrada",
      repetido: false,
      saldoDoLote: 9,
    });
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(9);
    expect(await administracoesDa(c.doseId)).toEqual([
      { resultado: "administrada", metodo: "qr", fora_da_janela: null, liberada_por: null },
    ]);
    const mov = await linhas<{ administracao_id: string }>(
      app,
      casa,
      "SELECT administracao_id FROM movimento_estoque WHERE lote_id = $1 AND tipo = 'consumo'",
      [c.lote.id],
    );
    expect(mov).toEqual([{ administracao_id: r.ok ? r.administracaoId : "" }]);
    expect(await acoesDeAuditoria(app, casa, r.ok ? r.administracaoId : "")).toEqual([
      "administracao.registrada",
    ]);

    const escala = await escalaDoPlantao(servico(), cuidador);
    const dose = escala.ok ? escala.escala.doses.find((d) => d.id === c.doseId) : undefined;
    expect(dose).toMatchObject({
      estado: "concluida",
      registro: { resultado: "administrada", usuarioNome: cuidador.usuario.nome, tardio: false },
    });
  });

  it("aceita o código da etiqueta e da pulseira digitados à mão (agrupados com hífen)", async () => {
    const c = await cenario();
    const agrupar = (s: string) => s.match(/.{1,5}/g)?.join("-") ?? s;
    const r = await registrar({
      doseId: c.doseId,
      pulseira: agrupar(c.idoso.pulseira.slice(7)).toLowerCase(),
      lote: agrupar(c.lote.codigo),
    });
    expect(r.ok).toBe(true);
  });
});

describe("bloqueios (tabela 5.4)", () => {
  async function bloqueios(r: Awaited<ReturnType<typeof registrarDose>>) {
    if (r.ok || r.motivo !== "conferencia_bloqueada") throw new Error(JSON.stringify(r));
    return r.bloqueios.map((b) => b.codigo);
  }

  it("pulseira de outro paciente: nada gravado, estoque intacto, e o quase-erro fica na trilha", async () => {
    const c = await cenario();
    const outro = await idosoComPulseira(servico(), enf);
    const r = await registrar({ doseId: c.doseId, pulseira: outro.pulseira, lote: c.lote.qr });
    expect(await bloqueios(r)).toEqual(["pulseira_de_outro_idoso"]);
    expect(r.ok === false && "bloqueios" in r && r.bloqueios[0]?.mensagem).toBe(
      "Esta pulseira é de outro paciente",
    );
    expect(await administracoesDa(c.doseId)).toEqual([]);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(10);
    expect(await acoesDeAuditoria(app, casa, c.doseId)).toEqual(["administracao.bloqueada"]);
  });

  it("etiqueta lida no lugar da pulseira, e pulseira no lugar da etiqueta, não passam", async () => {
    const c = await cenario();
    const r = await registrar({ doseId: c.doseId, pulseira: c.lote.qr, lote: c.idoso.pulseira });
    expect(await bloqueios(r)).toEqual(["pulseira_invalida", "etiqueta_invalida"]);
  });

  it("remédio errado", async () => {
    const c = await cenario();
    const outroRemedio = await lote(servico(), app, enf, await medicamento(servico(), enf), 10);
    const r = await registrar({
      doseId: c.doseId,
      pulseira: c.idoso.pulseira,
      lote: outroRemedio.qr,
    });
    expect(await bloqueios(r)).toEqual(["medicamento_errado"]);
  });

  it("lote vencido, lote de outro paciente e saldo que não confere", async () => {
    const c = await cenario();
    const outro = await idosoComPulseira(servico(), enf);
    agora = minutos(-60);
    agora = new Date("2026-02-01T12:00:00Z"); // entrou antes de vencer
    const vencido = await lote(servico(), app, enf, c.med, 10, { validade: "2026-03-09" });
    agora = minutos(-60);
    const deOutro = await lote(servico(), app, enf, c.med, 10, { idosoId: outro.id });
    const quase = await lote(servico(), app, enf, c.med, 0.5);
    agora = PREVISTA;
    const tenta = (qr: string) =>
      registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: qr });
    expect(await bloqueios(await tenta(vencido.qr))).toEqual(["lote_vencido"]);
    expect(await bloqueios(await tenta(deOutro.qr))).toEqual(["lote_de_outro_idoso"]);
    expect(await bloqueios(await tenta(quase.qr))).toEqual(["saldo_insuficiente"]);
    // O lote individual do próprio paciente vale.
    agora = minutos(-60);
    const proprio = await lote(servico(), app, enf, c.med, 5, { idosoId: c.idoso.id });
    agora = PREVISTA;
    expect((await tenta(proprio.qr)).ok).toBe(true);
    expect(await saldoDoLote(app, casa, proprio.id)).toBe(4);
  });

  it("unidade do lote diferente da prescrita", async () => {
    const c = await cenario();
    agora = minutos(-60);
    const emMl = await lote(servico(), app, enf, c.med, 100, { unidade: "ml" });
    agora = PREVISTA;
    const r = await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: emMl.qr });
    expect(await bloqueios(r)).toEqual(["unidade_diferente"]);
  });

  it("alergia cadastrada depois da prescrição bloqueia; a confirmada ao prescrever só avisa", async () => {
    agora = minutos(-60);
    const idoso = await idosoComPulseira(servico(), enf);
    const med = await medicamento(servico(), enf, {
      principioAtivo: "Amoxicilina",
      nome: "Amoxil",
    });
    const l = await lote(servico(), app, enf, med, 10);
    const { doseId } = await prescreverComDose(servico(), enf, idoso.id, med);
    await alergia(servico(), enf, idoso.id, "Penicilina");
    agora = PREVISTA;
    const r = await registrar({ doseId, pulseira: idoso.pulseira, lote: l.qr });
    expect(await bloqueios(r)).toEqual(["alergia"]);
    expect(r.ok === false && "bloqueios" in r && r.bloqueios[0]?.mensagem).toBe(
      "Alerta: alergia registrada: Penicilina (grave)",
    );
    // Recusa continua possível (o remédio não é dado).
    expect(
      (
        await registrar({
          doseId,
          resultado: "recusada",
          pulseira: idoso.pulseira,
          motivo: "Alergia: enfermeiro avisado",
        })
      ).ok,
    ).toBe(true);

    agora = minutos(-60);
    const outro = await idosoComPulseira(servico(), enf);
    await alergia(servico(), enf, outro.id, "Penicilina");
    const confirmada = await prescreverComDose(servico(), enf, outro.id, med, {
      justificativaAlergia: "Avaliado pelo médico: reação leve antiga, manter",
    });
    agora = PREVISTA;
    const conf = await conferirDoseAgendada(servico(), cuidador, {
      doseId: confirmada.doseId,
      pulseira: outro.pulseira,
      lote: l.qr,
    });
    expect(conf.ok && conf.conferencia.bloqueios).toEqual([]);
    expect(conf.ok && conf.conferencia.alergiasConfirmadas.map((a) => a.substancia)).toEqual([
      "Penicilina",
    ]);
    expect(
      (await registrar({ doseId: confirmada.doseId, pulseira: outro.pulseira, lote: l.qr })).ok,
    ).toBe(true);
  });

  it("dose já registrada: diz por quem e quando, e não grava de novo", async () => {
    const c = await cenario();
    expect(
      (await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr })).ok,
    ).toBe(true);
    agora = minutos(5);
    const r = await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr });
    expect(r).toMatchObject({
      ok: false,
      motivo: "conferencia_bloqueada",
      bloqueios: [
        {
          codigo: "dose_ja_registrada",
          mensagem: `Dose já registrada: por ${cuidador.usuario.nome} às 08:00`,
        },
      ],
    });
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(9);
  });

  it("prescrição substituída depois do horário: a dose antiga não se dá mais; encerrada cancela as futuras", async () => {
    const c = await cenario();
    agora = minutos(10);
    const v = await novaVersao(servico(), enf, {
      prescricaoId: c.prescricaoId,
      justificativa: "Dose corrigida pelo médico",
      conteudo: {
        medicamentoId: c.med,
        tipo: "regular",
        dose: 2,
        unidade: "comprimido",
        via: "oral",
        inicio: "2026-03-10",
        fim: null,
        altoRisco: false,
        horarios: [{ hora: "20:00" }],
      },
    });
    expect(v.ok).toBe(true);
    const r = await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr });
    expect(await bloqueios(r)).toEqual(["prescricao_encerrada"]);

    const d = await cenario({ hora: "20:00" });
    agora = minutos(60);
    await encerrarPrescricao(servico(), enf, {
      prescricaoId: d.prescricaoId,
      motivo: "Suspenso pelo médico",
    });
    agora = new Date("2026-03-10T23:00:00Z");
    expect(
      await registrar({ doseId: d.doseId, pulseira: d.idoso.pulseira, lote: d.lote.qr }),
    ).toEqual({
      ok: false,
      motivo: "dose_cancelada",
    });
  });
});

describe("janela de tolerância", () => {
  it("fora da janela até 2 h exige motivo, nos dois sentidos, e grava o sentido", async () => {
    for (const [m, sentido] of [
      [45, "atrasado"],
      [-45, "adiantado"],
    ] as const) {
      const c = await cenario();
      agora = minutos(m);
      const pedido = { doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr };
      expect(await registrar(pedido)).toEqual({ ok: false, motivo: "motivo_obrigatorio", sentido });
      expect(await registrar({ ...pedido, motivo: "ab" })).toMatchObject({
        motivo: "motivo_obrigatorio",
      });
      expect((await registrar({ ...pedido, motivo: "Paciente estava no banho" })).ok).toBe(true);
      expect((await administracoesDa(c.doseId))[0]?.fora_da_janela).toBe(sentido);
    }
  });

  it("mais de 2 h depois: só como registro tardio", async () => {
    const c = await cenario();
    agora = minutos(121);
    const r = await registrar({
      doseId: c.doseId,
      pulseira: c.idoso.pulseira,
      lote: c.lote.qr,
      motivo: "Atrasou muito",
    });
    expect(r).toMatchObject({
      motivo: "conferencia_bloqueada",
      bloqueios: [{ codigo: "horario_expirado" }],
    });
  });

  it("mais de 2 h antes: bloqueado; o enfermeiro libera com o PIN; cuidador não libera; PIN errado não libera", async () => {
    const c = await cenario();
    const enfermeira = await pessoaComPin(migrador, casa, "enfermeiro", "Enfermeira Liberadora");
    const outroCuidador = await pessoaComPin(migrador, casa, "cuidador");
    agora = minutos(-150);
    const pedido = {
      doseId: c.doseId,
      pulseira: c.idoso.pulseira,
      lote: c.lote.qr,
      motivo: "Paciente vai sair para exame",
    };
    expect(await registrar(pedido)).toMatchObject({
      motivo: "conferencia_bloqueada",
      bloqueios: [{ codigo: "horario_antecipado", liberavel: true }],
    });
    expect(
      await registrar({ ...pedido, liberacao: { usuarioId: outroCuidador.id, pin: PIN } }),
    ).toEqual({
      ok: false,
      motivo: "perfil_nao_autorizado",
      etapa: "liberacao",
    });
    expect(
      await registrar({ ...pedido, liberacao: { usuarioId: enfermeira.id, pin: "000000" } }),
    ).toEqual({
      ok: false,
      motivo: "pin_invalido",
      etapa: "liberacao",
    });
    expect(await administracoesDa(c.doseId)).toEqual([]);
    const ok = await registrar({ ...pedido, liberacao: { usuarioId: enfermeira.id, pin: PIN } });
    expect(ok.ok).toBe(true);
    expect(await administracoesDa(c.doseId)).toEqual([
      {
        resultado: "administrada",
        metodo: "qr",
        fora_da_janela: "adiantado",
        liberada_por: enfermeira.id,
      },
    ]);
  });
});

describe("outros resultados", () => {
  it("recusada e não administrada: exigem motivo, não usam lote, e encerram a dose", async () => {
    const c = await cenario();
    expect(
      await registrar({ doseId: c.doseId, resultado: "recusada", pulseira: c.idoso.pulseira }),
    ).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(
      await registrar({
        doseId: c.doseId,
        resultado: "recusada",
        motivo: "Recusou",
        lote: c.lote.qr,
      }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    const r = await registrar({
      doseId: c.doseId,
      resultado: "recusada",
      pulseira: c.idoso.pulseira,
      motivo: "Recusou, cuspiu o comprimido",
    });
    expect(r.ok).toBe(true);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(10);

    // Não administrada não exige o paciente diante do tablet (pode estar fora, no hospital).
    const d = await cenario();
    const sem = await registrar({
      doseId: d.doseId,
      resultado: "nao_administrada",
      motivo: "Paciente em consulta externa",
    });
    expect(sem.ok).toBe(true);
    const escala = await escalaDoPlantao(servico(), cuidador);
    expect(
      escala.ok && escala.escala.doses.find((x) => x.id === d.doseId)?.registro?.resultado,
    ).toBe("nao_administrada");
  });

  it("adiada: não encerra a dose, muda o horário de referência e não aceita adiar além do limite", async () => {
    const c = await cenario();
    agora = minutos(10);
    const pedido = {
      doseId: c.doseId,
      resultado: "adiada" as const,
      pulseira: c.idoso.pulseira,
      motivo: "Paciente dormindo",
    };
    expect(await registrar({ ...pedido, adiadaPara: minutos(121).toISOString() })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect((await registrar({ ...pedido, adiadaPara: minutos(90).toISOString() })).ok).toBe(true);

    const escala = await escalaDoPlantao(servico(), cuidador);
    const dose = escala.ok ? escala.escala.doses.find((x) => x.id === c.doseId) : undefined;
    expect(dose).toMatchObject({
      adiadaPara: minutos(90).toISOString(),
      registro: null,
      estado: "a_fazer",
    });

    // No novo horário, registra sem motivo: a janela conta a partir dele.
    agora = minutos(95);
    const r = await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr });
    expect(r.ok).toBe(true);
    expect((await administracoesDa(c.doseId)).map((a) => a.resultado)).toEqual([
      "adiada",
      "administrada",
    ]);
  });
});

describe("idempotência e concorrência", () => {
  it("reenviar a mesma tentativa devolve o mesmo registro e baixa o lote uma vez só", async () => {
    const c = await cenario();
    const pedido = { chave: nova(), doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr };
    const a = await registrar(pedido);
    const b = await registrar(pedido);
    expect(a).toMatchObject({ ok: true, repetido: false });
    expect(b).toMatchObject({ ok: true, repetido: true });
    expect(a.ok && b.ok && a.administracaoId === b.administracaoId).toBe(true);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(9);

    // A mesma chave em outra dose é erro do aparelho, não um registro novo.
    const d = await cenario();
    expect(
      await registrar({ ...pedido, doseId: d.doseId, pulseira: d.idoso.pulseira, lote: d.lote.qr }),
    ).toEqual({
      ok: false,
      motivo: "chave_reutilizada",
    });
  });

  it("leituras simultâneas da mesma dose (chaves diferentes): um registro só", async () => {
    const c = await cenario();
    const r = await Promise.all(
      Array.from({ length: 6 }, () =>
        registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr }),
      ),
    );
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    for (const x of r.filter((y) => !y.ok)) {
      expect(x).toMatchObject({
        motivo: "conferencia_bloqueada",
        bloqueios: [{ codigo: "dose_ja_registrada" }],
      });
    }
    expect(await administracoesDa(c.doseId)).toHaveLength(1);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(9);
  });

  it("toque duplo (mesma chave ao mesmo tempo): um grava, os outros recebem o mesmo registro", async () => {
    const c = await cenario();
    const pedido = { chave: nova(), doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr };
    const r = await Promise.all(Array.from({ length: 5 }, () => registrar(pedido)));
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r.filter((x) => x.ok && !x.repetido)).toHaveLength(1);
    expect(new Set(r.map((x) => (x.ok ? x.administracaoId : ""))).size).toBe(1);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(9);
  });

  it("duas doses diferentes disputando a última unidade do lote: só uma leva", async () => {
    agora = minutos(-60);
    const med = await medicamento(servico(), enf);
    const unico = await lote(servico(), app, enf, med, 1);
    const a = await idosoComPulseira(servico(), enf);
    const b = await idosoComPulseira(servico(), enf);
    const da = await prescreverComDose(servico(), enf, a.id, med);
    const db = await prescreverComDose(servico(), enf, b.id, med);
    agora = PREVISTA;
    const r = await Promise.all([
      registrar({ doseId: da.doseId, pulseira: a.pulseira, lote: unico.qr }),
      registrar({ doseId: db.doseId, pulseira: b.pulseira, lote: unico.qr }),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    const perdeu = r.find((x) => !x.ok);
    expect(
      perdeu?.ok === false &&
        (perdeu.motivo === "saldo_insuficiente" ||
          ("bloqueios" in perdeu && perdeu.bloqueios[0]?.codigo === "saldo_insuficiente")),
    ).toBe(true);
    expect(await saldoDoLote(app, casa, unico.id)).toBe(0);
  });
});

describe("exceção de conferência (etiqueta ilegível)", () => {
  it("o enfermeiro libera com o PIN e o lote escolhido à mão; fica marcado como exceção", async () => {
    const c = await cenario();
    const enfermeira = await pessoaComPin(migrador, casa, "enfermeiro");
    const r = await registrar({
      doseId: c.doseId,
      pulseira: c.idoso.pulseira,
      excecao: {
        loteId: c.lote.id,
        motivo: "etiqueta_ilegivel",
        justificativa: "Etiqueta molhada, conferi lote e validade na caixa",
        liberador: { usuarioId: enfermeira.id, pin: PIN },
      },
    });
    expect(r.ok).toBe(true);
    expect((await administracoesDa(c.doseId))[0]?.metodo).toBe("excecao");
    const ex = await linhas<{ motivo: string; liberada_por: string }>(
      app,
      casa,
      "SELECT e.motivo, e.liberada_por FROM excecao_conferencia e JOIN administracao a ON a.id = e.administracao_id WHERE a.dose_agendada_id = $1",
      [c.doseId],
    );
    expect(ex).toEqual([{ motivo: "etiqueta_ilegivel", liberada_por: enfermeira.id }]);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(9);
  });

  it("não vale para paciente errado nem lote vencido, e cuidador não libera", async () => {
    const c = await cenario();
    const enfermeira = await pessoaComPin(migrador, casa, "enfermeiro");
    const colega = await pessoaComPin(migrador, casa, "cuidador");
    agora = minutos(-60);
    agora = new Date("2026-02-01T12:00:00Z"); // entrou antes de vencer
    const vencido = await lote(servico(), app, enf, c.med, 10, { validade: "2026-03-01" });
    agora = minutos(-60);
    const outro = await idosoComPulseira(servico(), enf);
    agora = PREVISTA;
    const excecao = (loteId: string, usuarioId: string) => ({
      loteId,
      motivo: "etiqueta_danificada" as const,
      justificativa: "Etiqueta rasgada na embalagem",
      liberador: { usuarioId, pin: PIN },
    });
    expect(
      await registrar({
        doseId: c.doseId,
        pulseira: c.idoso.pulseira,
        excecao: excecao(vencido.id, enfermeira.id),
      }),
    ).toMatchObject({ bloqueios: [{ codigo: "lote_vencido" }] });
    expect(
      await registrar({
        doseId: c.doseId,
        pulseira: outro.pulseira,
        excecao: excecao(c.lote.id, enfermeira.id),
      }),
    ).toMatchObject({ bloqueios: [{ codigo: "pulseira_de_outro_idoso" }] });
    expect(
      await registrar({
        doseId: c.doseId,
        pulseira: c.idoso.pulseira,
        excecao: excecao(c.lote.id, colega.id),
      }),
    ).toEqual({ ok: false, motivo: "perfil_nao_autorizado", etapa: "excecao" });
    expect(
      await registrar({
        doseId: c.doseId,
        pulseira: c.idoso.pulseira,
        lote: c.lote.qr,
        excecao: excecao(c.lote.id, enfermeira.id),
      }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    expect(await administracoesDa(c.doseId)).toEqual([]);
  });
});

describe("alto risco: segunda validação", () => {
  it("exige outra pessoa, com o PIN dela; a mesma pessoa e PIN errado não valem", async () => {
    const c = await cenario({ altoRisco: true });
    const colega = await pessoaComPin(migrador, casa, "cuidador", "Colega Validadora");
    const pedido = { doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr };
    const conf = await conferirDoseAgendada(servico(), cuidador, pedido);
    expect(conf.ok && conf.conferencia.exigeSegundaValidacao).toBe(true);

    expect(await registrar(pedido)).toEqual({ ok: false, motivo: "segunda_validacao_necessaria" });
    expect(
      await registrar({ ...pedido, segundaValidacao: { usuarioId: cuidador.usuarioId, pin: PIN } }),
    ).toEqual({
      ok: false,
      motivo: "validador_igual",
      etapa: "segunda_validacao",
    });
    expect(
      await registrar({ ...pedido, segundaValidacao: { usuarioId: colega.id, pin: "111222" } }),
    ).toEqual({
      ok: false,
      motivo: "pin_invalido",
      etapa: "segunda_validacao",
    });
    expect(await administracoesDa(c.doseId)).toEqual([]);
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(10);

    const r = await registrar({ ...pedido, segundaValidacao: { usuarioId: colega.id, pin: PIN } });
    expect(r.ok).toBe(true);
    const v = await linhas<{ validador_id: string }>(
      app,
      casa,
      "SELECT validador_id FROM segunda_validacao WHERE administracao_id = $1",
      [r.ok ? r.administracaoId : ""],
    );
    expect(v).toEqual([{ validador_id: colega.id }]);
    const conf2 = await conferirDoseAgendada(servico(), cuidador, { doseId: c.doseId });
    expect(conf2.ok && conf2.conferencia.historico[0]?.validadorNome).toBe("Colega Validadora");
  });

  it("recusa de dose de alto risco não pede segunda validação", async () => {
    const c = await cenario({ altoRisco: true });
    const r = await registrar({
      doseId: c.doseId,
      resultado: "recusada",
      pulseira: c.idoso.pulseira,
      motivo: "Recusou",
    });
    expect(r.ok).toBe(true);
  });

  it("errar o PIN do colega 5 vezes bloqueia a conta DELE, e o registro não sai", async () => {
    const c = await cenario({ altoRisco: true });
    const colega = await pessoaComPin(migrador, casa, "cuidador");
    const pedido = { doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr };
    for (let i = 0; i < 5; i += 1) {
      expect(
        await registrar({
          ...pedido,
          segundaValidacao: { usuarioId: colega.id, pin: `99999${i}` },
        }),
      ).toMatchObject({ motivo: "pin_invalido" });
    }
    // Agora nem o PIN certo serve: a conta está bloqueada.
    expect(
      await registrar({ ...pedido, segundaValidacao: { usuarioId: colega.id, pin: PIN } }),
    ).toMatchObject({
      motivo: "pin_invalido",
    });
    const u = await linhas<{ bloqueado: boolean }>(
      app,
      casa,
      "SELECT bloqueado_ate > now() - interval '1 year' AS bloqueado FROM usuario WHERE id = $1",
      [colega.id],
    );
    expect(u[0]?.bloqueado).toBe(true);
    expect(await administracoesDa(c.doseId)).toEqual([]);
  });
});

describe("travas do banco", () => {
  it("o registro não muda nem some; a segunda validação não é da mesma pessoa; dose não tem dois finais", async () => {
    const c = await cenario();
    const r = await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr });
    if (!r.ok) throw new Error("registro");
    const erroDe = async (sql: string, params: unknown[]) => {
      try {
        await linhas(app, casa, sql, params);
        return null;
      } catch (e) {
        const x = e as { code?: string; constraint?: string; message: string };
        return x.constraint ?? x.code ?? x.message;
      }
    };
    expect(
      await erroDe("UPDATE administracao SET motivo = 'mudei' WHERE id = $1", [r.administracaoId]),
    ).toBe("42501");
    expect(await erroDe("DELETE FROM administracao WHERE id = $1", [r.administracaoId])).toBe(
      "42501",
    );
    expect(
      await erroDe(
        "INSERT INTO segunda_validacao (casa_id, administracao_id, validador_id, validada_em) VALUES (app_casa_id(), $1, $2, now())",
        [r.administracaoId, cuidador.usuarioId],
      ),
    ).toBe("segunda_validacao_outra_pessoa");
    expect(
      await erroDe(
        `INSERT INTO administracao (casa_id, chave, dose_agendada_id, prescricao_id, idoso_id, resultado, motivo,
                                    usuario_id, ocorrida_em, registrada_em, metodo)
         VALUES (app_casa_id(), gen_random_uuid(), $1, $2, $3, 'recusada', 'outra vez', $4, now(), now(), 'qr')`,
        [c.doseId, c.prescricaoId, c.idoso.id, cuidador.usuarioId],
      ),
    ).toBe("administracao_final_unica");
    // Coerência: lote de outro remédio não entra nem por fora do código.
    const d = await cenario();
    const outroRemedio = await lote(servico(), app, enf, await medicamento(servico(), enf), 10);
    expect(
      await erroDe(
        `INSERT INTO administracao (casa_id, chave, dose_agendada_id, prescricao_id, idoso_id, resultado,
                                    lote_id, quantidade, usuario_id, ocorrida_em, registrada_em, metodo)
         VALUES (app_casa_id(), gen_random_uuid(), $1, $2, $3, 'administrada', $4, 1, $5, now(), now(), 'qr')`,
        [d.doseId, d.prescricaoId, d.idoso.id, outroRemedio.id, cuidador.usuarioId],
      ),
    ).toBe("administracao_coerente");
  });
});

describe("isolamento e permissões", () => {
  it("outra casa não acha a dose, nem a pulseira nem o lote desta", async () => {
    const c = await cenario();
    const casaB = await criarCasa(migrador, "Casa B do registro");
    const cuidadorB = await criarAtorTablet(servico, migrador, casaB);
    expect(
      await registrar({ doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr }, cuidadorB),
    ).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(await conferirDoseAgendada(servico(), cuidadorB, { doseId: c.doseId })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    // Dose da casa B, lida com a pulseira e a etiqueta da casa A: desconhecidas lá.
    const enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
    agora = minutos(-60);
    const idosoB = await idosoComPulseira(servico(), enfB);
    const medB = await medicamento(servico(), enfB);
    const doseB = await prescreverComDose(servico(), enfB, idosoB.id, medB);
    agora = PREVISTA;
    const r = await registrar(
      { doseId: doseB.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr },
      cuidadorB,
    );
    expect(r).toMatchObject({
      bloqueios: [{ codigo: "pulseira_desconhecida" }, { codigo: "etiqueta_desconhecida" }],
    });
    expect(await saldoDoLote(app, casa, c.lote.id)).toBe(10);
  });

  it("todo perfil registra; quem não tem sessão de casa não chega aqui", async () => {
    const c = await cenario();
    const r = await registrar(
      { doseId: c.doseId, pulseira: c.idoso.pulseira, lote: c.lote.qr },
      enf as unknown as AtorTablet,
    );
    expect(r.ok).toBe(true);
    await expect(
      registrarDose(
        servico(),
        { ...cuidador, perfil: "intruso" as never },
        {
          chave: nova(),
          doseId: c.doseId,
          resultado: "administrada",
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(ErroDePermissao).toBeDefined();
  });
});
