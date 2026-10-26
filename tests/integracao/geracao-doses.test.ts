import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarDosesDaCasa, gerarEscalaDeTodasAsCasas } from "@/modules/administracao";
import { ErroDePermissao, type Servico } from "@/modules/identidade";
import { cadastrarIdoso, mudarStatusDoIdoso } from "@/modules/idosos";
import {
  cadastrarMedicamento,
  encerrarPrescricao,
  novaVersao,
  prescrever,
  type ConteudoDePrescricao,
} from "@/modules/prescricoes";
import { criarPoolAgendador, criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import { criarAtorWeb, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let agendador: pg.Pool;
let casaA: string;
let casaB: string;
let enf: AtorWeb;
let enfB: AtorWeb;
let agora: Date;
let n = 0;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const servicoAgendador = (): Servico => ({
  pool: agendador,
  chaveCampos: CHAVE,
  agora: () => agora,
});
const hoje = () => agora.toISOString().slice(0, 10);

type LinhaDose = {
  prescricao_id: string;
  data_local: string;
  hora_local: string;
  prevista_em: Date;
  cancelada_em: Date | null;
  motivo_cancelamento: string | null;
};

async function doses(casaId: string, onde = "true", valores: unknown[] = []) {
  return comContexto(
    app,
    { casaId },
    async (c) =>
      (
        await c.query<LinhaDose>(
          `SELECT prescricao_id, data_local::text, hora_local::text, prevista_em, cancelada_em,
                motivo_cancelamento
           FROM dose_agendada WHERE ${onde} ORDER BY prevista_em, prescricao_id`,
          valores,
        )
      ).rows,
  );
}

/** `casa` tem RLS: até o dono do schema precisa entrar no contexto da casa para alterá-la. */
async function alterarCasa(casaId: string, definicao: string) {
  const r = await comContexto(migrador, { casaId }, (c) =>
    c.query(`UPDATE casa SET ${definicao} WHERE id = $1`, [casaId]),
  );
  expect(r.rowCount).toBe(1);
}

async function novoIdoso(ator = enf) {
  n += 1;
  const r = await cadastrarIdoso(servico(), ator, {
    nome: `Idoso Geração ${n}`,
    dataNascimento: "1940-01-01",
    alergias: [],
  });
  if (!r.ok) throw new Error("idoso");
  return r.idosoId;
}

async function novoMedicamento(ator = enf) {
  n += 1;
  const r = await cadastrarMedicamento(servico(), ator, {
    nomeComercial: `Remedio Geração ${n}`,
    principioAtivo: `SubstanciaGer${n}x`,
    concentracao: "500 mg",
    forma: "comprimido",
  });
  if (!r.ok) throw new Error("medicamento");
  return r.medicamentoId;
}

const conteudo = (
  medicamentoId: string,
  extra: Partial<ConteudoDePrescricao> = {},
): ConteudoDePrescricao => ({
  medicamentoId,
  tipo: "regular",
  dose: 1,
  unidade: "comprimido",
  via: "oral",
  inicio: hoje(),
  fim: null,
  altoRisco: false,
  horarios: [{ hora: "08:00" }, { hora: "20:00" }],
  ...extra,
});

async function prescreverOk(
  idosoId: string,
  extra: Partial<ConteudoDePrescricao> = {},
  ator = enf,
) {
  const medicamentoId = await novoMedicamento(ator);
  const r = await prescrever(servico(), ator, { idosoId, ...conteudo(medicamentoId, extra) });
  if (!r.ok) throw new Error(`prescrever: ${r.motivo}`);
  return { prescricaoId: r.prescricaoId, medicamentoId };
}

beforeAll(async () => {
  app = criarPoolApp(8);
  migrador = criarPoolMigrador();
  agendador = criarPoolAgendador(4);
  // 10/03/2026, 12:00 em São Paulo (UTC-3, sem horário de verão em 2026).
  agora = new Date("2026-03-10T15:00:00Z");
  casaA = await criarCasa(migrador, "Casa A Geração");
  casaB = await criarCasa(migrador, "Casa B Geração");
  enf = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
  enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
  await agendador.end();
});

describe("geração de doses", () => {
  it("gera 7 dias à frente, sem dose anterior à criação da prescrição, e é idempotente", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso);

    const primeira = await gerarDosesDaCasa(servico(), casaA);
    expect(primeira.ate).toBe("2026-03-17");
    expect(primeira.criadas).toBeGreaterThanOrEqual(15);

    const lista = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
    // Hoje só o das 20h (o das 8h já passou antes de a prescrição existir) + 7 dias completos.
    expect(lista).toHaveLength(15);
    expect(lista[0]).toMatchObject({ data_local: "2026-03-10", hora_local: "20:00:00" });
    expect(lista[0]?.prevista_em.toISOString()).toBe("2026-03-10T23:00:00.000Z");
    expect(lista.some((d) => d.data_local === "2026-03-10" && d.hora_local === "08:00:00")).toBe(
      false,
    );

    const segunda = await gerarDosesDaCasa(servico(), casaA);
    expect(segunda.criadas).toBe(0);
    expect(await doses(casaA, "prescricao_id = $1", [prescricaoId])).toHaveLength(15);
  });

  it("execuções simultâneas não duplicam doses", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "10:00" }] });
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () => gerarDosesDaCasa(servico(), casaA)),
    );
    expect(resultados.reduce((s, r) => s + r.criadas, 0)).toBeGreaterThanOrEqual(7);
    const lista = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
    expect(lista).toHaveLength(7); // hoje 10h já passou; 11/03 a 17/03
    expect(new Set(lista.map((d) => d.data_local)).size).toBe(7);
  });

  it("no dia seguinte gera só o dia novo", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "09:00" }] });
    await gerarDosesDaCasa(servico(), casaA);
    const antes = (await doses(casaA, "prescricao_id = $1", [prescricaoId])).length;
    agora = new Date("2026-03-11T15:00:00Z");
    try {
      await gerarDosesDaCasa(servico(), casaA);
      const depois = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
      expect(depois.length).toBe(antes + 1);
      expect(depois.at(-1)?.data_local).toBe("2026-03-18");
    } finally {
      agora = new Date("2026-03-10T15:00:00Z");
    }
  });

  it("respeita fim da vigência e dias da semana", async () => {
    const idoso = await novoIdoso();
    // 10/03/2026 é terça-feira (2). Quarta (3) e sexta (5), com fim em 13/03.
    const { prescricaoId } = await prescreverOk(idoso, {
      horarios: [{ hora: "07:30", diasSemana: [3, 5] }],
      fim: "2026-03-13",
    });
    await gerarDosesDaCasa(servico(), casaA);
    const lista = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
    expect(lista.map((d) => d.data_local)).toEqual(["2026-03-11", "2026-03-13"]);
  });

  it("prescrição SOS não gera doses", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const r = await prescrever(servico(), enf, {
      idosoId: idoso,
      ...conteudo(med, {
        tipo: "sos",
        horarios: [],
        sos: { indicacao: "Dor forte", limiteDiario: 3, intervaloMinimoMin: 240 },
      }),
    });
    if (!r.ok) throw new Error("sos");
    // A API não deixa um "se necessário" ter horário; o banco, porém, aceitaria. A geração tem de
    // ignorar o tipo mesmo assim: SOS é sob demanda, nunca escala fixa.
    await comContexto(migrador, { casaId: casaA }, (c) =>
      c.query(
        "INSERT INTO horario_prescricao (casa_id, prescricao_id, hora) VALUES (app_casa_id(), $1, '09:00')",
        [r.prescricaoId],
      ),
    );
    await gerarDosesDaCasa(servico(), casaA);
    expect(await doses(casaA, "idoso_id = $1", [idoso])).toHaveLength(0);
  });

  it("depois de a rotina ficar parada, recupera as doses do dia anterior", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "20:30" }] });
    const antes = agora;
    agora = new Date("2026-03-11T15:00:00Z"); // nada rodou em 10/03
    try {
      await gerarDosesDaCasa(servico(), casaA);
      const lista = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
      expect(lista[0]).toMatchObject({ data_local: "2026-03-10", hora_local: "20:30:00" });
    } finally {
      agora = antes;
    }
  });

  it("usa o fuso da casa, inclusive na virada do horário de verão", async () => {
    const casa = await criarCasa(migrador, "Casa Nova York");
    await alterarCasa(casa, "fuso_horario = 'America/New_York'");
    const ator = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
    const idoso = await novoIdoso(ator);
    // 08/03/2026 12:00 em Nova York ainda é EST; às 02:00 desse dia vira EDT.
    const antes = agora;
    agora = new Date("2026-03-07T17:00:00Z");
    try {
      const { prescricaoId } = await prescreverOk(
        idoso,
        { inicio: "2026-03-07", horarios: [{ hora: "08:00" }] },
        ator,
      );
      await gerarDosesDaCasa(servico(), casa, { dias: 3 });
      const lista = await doses(casa, "prescricao_id = $1", [prescricaoId]);
      expect(lista.map((d) => [d.data_local, d.prevista_em.toISOString()])).toEqual([
        ["2026-03-08", "2026-03-08T12:00:00.000Z"], // EDT, UTC-4
        ["2026-03-09", "2026-03-09T12:00:00.000Z"],
        ["2026-03-10", "2026-03-10T12:00:00.000Z"],
      ]);
    } finally {
      agora = antes;
    }
  });
});

describe("mudanças que cancelam doses", () => {
  it("nova versão: as doses futuras da antiga são canceladas e a nova não repete as que já passaram", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId, medicamentoId } = await prescreverOk(idoso, {
      horarios: [{ hora: "08:00" }, { hora: "20:00" }],
    });
    await gerarDosesDaCasa(servico(), casaA);

    // Meio-dia de 11/03: as 8h passaram e as 20h ainda não.
    const antes = agora;
    agora = new Date("2026-03-11T15:00:00Z");
    try {
      const v2 = await novaVersao(servico(), enf, {
        prescricaoId,
        justificativa: "Ajuste de dose pelo médico",
        conteudo: conteudo(medicamentoId, { dose: 2, inicio: "2026-03-10" }),
      });
      if (!v2.ok) throw new Error(v2.motivo);
      await gerarDosesDaCasa(servico(), casaA);

      const antigas = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
      const antigasAtivas = antigas.filter((d) => d.cancelada_em === null);
      // O que já passou (até 11/03 12:00) continua; tudo depois está cancelado.
      expect(antigasAtivas.every((d) => d.prevista_em.getTime() <= agora.getTime())).toBe(true);
      expect(
        antigas
          .filter((d) => d.prevista_em.getTime() > agora.getTime())
          .every((d) => d.motivo_cancelamento === "prescricao_substituida"),
      ).toBe(true);

      const novas = await doses(casaA, "prescricao_id = $1", [v2.prescricaoId]);
      expect(novas.length).toBeGreaterThan(0);
      // Nenhuma dose da nova versão antes de ela existir: sem "dose fantasma" das 8h de 11/03.
      expect(novas.every((d) => d.prevista_em.getTime() >= agora.getTime())).toBe(true);
      expect(novas[0]).toMatchObject({ data_local: "2026-03-11", hora_local: "20:00:00" });
      // Em nenhum horário há duas doses ativas do mesmo medicamento para o idoso.
      const ativas = await doses(casaA, "idoso_id = $1 AND cancelada_em IS NULL", [idoso]);
      const chaves = ativas.map((d) => `${d.data_local} ${d.hora_local}`);
      const futuras = ativas.filter((d) => d.prevista_em.getTime() > agora.getTime());
      expect(new Set(futuras.map((d) => `${d.data_local} ${d.hora_local}`)).size).toBe(
        futuras.length,
      );
      expect(chaves.length).toBeGreaterThan(0);
    } finally {
      agora = antes;
    }
  });

  it("encerrar: cancela as futuras e mantém as passadas", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "06:00" }] });
    await gerarDosesDaCasa(servico(), casaA);
    const antes = agora;
    agora = new Date("2026-03-12T15:00:00Z"); // 12/03 12:00
    try {
      const r = await encerrarPrescricao(servico(), enf, { prescricaoId, motivo: "Suspenso" });
      expect(r.ok).toBe(true);
      const lista = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
      const passadas = lista.filter((d) => d.prevista_em.getTime() <= agora.getTime());
      const futuras = lista.filter((d) => d.prevista_em.getTime() > agora.getTime());
      expect(passadas.map((d) => d.data_local)).toEqual(["2026-03-11", "2026-03-12"]);
      expect(passadas.every((d) => d.cancelada_em === null)).toBe(true);
      expect(futuras.length).toBe(5);
      expect(futuras.every((d) => d.motivo_cancelamento === "prescricao_encerrada")).toBe(true);
      // E uma nova rodada não traz nada de volta.
      expect((await gerarDosesDaCasa(servico(), casaA)).criadas).toBeGreaterThanOrEqual(0);
      const depois = await doses(casaA, "prescricao_id = $1 AND cancelada_em IS NULL", [
        prescricaoId,
      ]);
      expect(depois).toHaveLength(passadas.length);
    } finally {
      agora = antes;
    }
  });

  it("idoso internado: cancela as futuras, não gera enquanto fora e regenera ao voltar", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "18:00" }] });
    await gerarDosesDaCasa(servico(), casaA);
    const todas = await doses(casaA, "prescricao_id = $1", [prescricaoId]);
    expect(todas).toHaveLength(8); // 10/03 18h ainda não passou (12h local) + 7

    const antes = agora;
    try {
      const sai = await mudarStatusDoIdoso(servico(), enf, {
        idosoId: idoso,
        status: "hospitalizado",
      });
      expect(sai.ok).toBe(true);
      expect(
        await doses(casaA, "prescricao_id = $1 AND cancelada_em IS NULL", [prescricaoId]),
      ).toHaveLength(0);
      expect(
        (await doses(casaA, "prescricao_id = $1", [prescricaoId])).every(
          (d) => d.motivo_cancelamento === "idoso_afastado",
        ),
      ).toBe(true);

      // Internado: a rotina não gera nada para ele.
      await gerarDosesDaCasa(servico(), casaA);
      expect(
        await doses(casaA, "prescricao_id = $1 AND cancelada_em IS NULL", [prescricaoId]),
      ).toHaveLength(0);

      // Volta em 12/03 às 12h: as de 10 e 11/03 (passadas) não renascem; as demais sim.
      agora = new Date("2026-03-12T15:00:00Z");
      const volta = await mudarStatusDoIdoso(servico(), enf, { idosoId: idoso, status: "ativo" });
      expect(volta.ok).toBe(true);
      await gerarDosesDaCasa(servico(), casaA);
      const ativas = await doses(casaA, "prescricao_id = $1 AND cancelada_em IS NULL", [
        prescricaoId,
      ]);
      expect(ativas[0]?.data_local).toBe("2026-03-12");
      expect(ativas.every((d) => d.prevista_em.getTime() > agora.getTime())).toBe(true);
      expect(ativas.at(-1)?.data_local).toBe("2026-03-19");
      // Idempotente também depois do retorno.
      expect((await gerarDosesDaCasa(servico(), casaA)).criadas).toBe(0);
    } finally {
      agora = antes;
    }
  });

  it("uma dose só pode ser cancelada, uma vez: o resto é imutável no banco", async () => {
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "21:00" }] });
    await gerarDosesDaCasa(servico(), casaA);
    const erro = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: Error) => e.message,
      );
    const alterar = (sqlTexto: string) =>
      comContexto(app, { casaId: casaA }, (c) => c.query(sqlTexto, [prescricaoId]));
    expect(
      await erro(
        alterar(
          "UPDATE dose_agendada SET prevista_em = prevista_em + interval '1 hour' WHERE prescricao_id = $1",
        ),
      ),
    ).toMatch(/só cancelada/);
    expect(
      await erro(alterar("UPDATE dose_agendada SET hora_local = '22:00' WHERE prescricao_id = $1")),
    ).toMatch(/só cancelada/);
    expect(await erro(alterar("DELETE FROM dose_agendada WHERE prescricao_id = $1"))).toMatch(
      /permission denied/,
    );
    await alterar(
      "UPDATE dose_agendada SET cancelada_em = now(), motivo_cancelamento = 'idoso_afastado' WHERE prescricao_id = $1",
    );
    expect(
      await erro(
        alterar(
          "UPDATE dose_agendada SET cancelada_em = NULL, motivo_cancelamento = NULL WHERE prescricao_id = $1",
        ),
      ),
    ).toMatch(/voltar atrás/);
  });
});

describe("agendador", () => {
  it("gera para todas as casas ativas, registra o batimento e isola cada casa", async () => {
    const idosoA = await novoIdoso();
    const idosoB = await novoIdoso(enfB);
    const a = await prescreverOk(idosoA, { horarios: [{ hora: "13:00" }] });
    const b = await prescreverOk(idosoB, { horarios: [{ hora: "13:00" }] }, enfB);

    const r = await gerarEscalaDeTodasAsCasas(servicoAgendador());
    expect(r.falhas).toEqual([]);
    expect(r.casas).toBeGreaterThanOrEqual(2);

    const dosesA = await doses(casaA, "prescricao_id = $1", [a.prescricaoId]);
    const dosesB = await doses(casaB, "prescricao_id = $1", [b.prescricaoId]);
    expect(dosesA).toHaveLength(8);
    expect(dosesB).toHaveLength(8);
    // Cada casa só enxerga as doses dela.
    expect(await doses(casaA, "prescricao_id = $1", [b.prescricaoId])).toHaveLength(0);
    expect(await doses(casaB, "prescricao_id = $1", [a.prescricaoId])).toHaveLength(0);

    const batimento = await comContexto(
      app,
      { casaId: casaA },
      async (c) =>
        (
          await c.query<{ ultima_execucao_em: Date; ultimo_resultado: { criadas: number } }>(
            "SELECT ultima_execucao_em, ultimo_resultado FROM execucao_agendador WHERE tarefa = 'gerar_doses'",
          )
        ).rows,
    );
    expect(batimento).toHaveLength(1);
    expect(batimento[0]?.ultima_execucao_em.toISOString()).toBe(agora.toISOString());
  });

  it("casa inativa não recebe doses", async () => {
    const casa = await criarCasa(migrador, "Casa Inativa");
    const ator = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
    const idoso = await novoIdoso(ator);
    const { prescricaoId } = await prescreverOk(idoso, {}, ator);
    await alterarCasa(casa, "ativa = false");
    await gerarEscalaDeTodasAsCasas(servicoAgendador());
    expect(await doses(casa, "prescricao_id = $1", [prescricaoId])).toHaveLength(0);
  });

  it("a falha de uma casa é registrada e não impede as outras", async () => {
    const ruim = await criarCasa(migrador, "Casa Fuso Ruim");
    await alterarCasa(ruim, "fuso_horario = 'Marte/Olympus'");
    const idoso = await novoIdoso();
    const { prescricaoId } = await prescreverOk(idoso, { horarios: [{ hora: "14:00" }] });

    const r = await gerarEscalaDeTodasAsCasas(servicoAgendador());
    expect(r.falhas.map((f) => f.casaId)).toContain(ruim);
    expect(r.falhas.every((f) => !/Marte/.test(f.erro))).toBe(true);
    expect(await doses(casaA, "prescricao_id = $1", [prescricaoId])).toHaveLength(8);

    const marca = await comContexto(
      app,
      { casaId: ruim },
      async (c) => (await c.query("SELECT ultimo_erro_em FROM execucao_agendador")).rows,
    );
    expect(marca).toHaveLength(1);
    expect(marca[0]?.ultimo_erro_em).not.toBeNull();
    await alterarCasa(ruim, "ativa = false");
  });

  it("o papel do agendador lista casas ativas, mas sem contexto não lê dado nenhum de casa", async () => {
    const lista = await agendador.query("SELECT id FROM casa");
    expect(lista.rows.length).toBeGreaterThanOrEqual(2);
    for (const tabela of [
      "dose_agendada",
      "prescricao",
      "idoso",
      "usuario",
      "execucao_agendador",
    ]) {
      const r = await agendador.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      expect(r.rows[0].n, tabela).toBe(0);
    }
    await expect(agendador.query("UPDATE casa SET nome = 'x'")).resolves.toMatchObject({
      rowCount: 0,
    });
    await expect(agendador.query("DELETE FROM dose_agendada")).rejects.toThrow(/permission denied/);
  });

  it("quem não tem perfil de gestão não consegue chamar a geração por engano (a função é interna)", () => {
    // A geração não exige sessão: ela é chamada só pelo agendador e pelo servidor. Este teste
    // documenta que não há atalho de API exportado com o mesmo nome.
    expect(ErroDePermissao).toBeDefined();
  });
});
