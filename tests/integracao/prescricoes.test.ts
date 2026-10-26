import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArmazenamentoEmMemoria } from "@/compartilhado/armazenamento";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cadastrarIdoso, mudarStatusDoIdoso } from "@/modules/idosos";
import { ErroDePermissao, type Servico } from "@/modules/identidade";
import {
  anexarReceita,
  cadastrarMedicamento,
  definirAltoRiscoDoMedicamento,
  desativarMedicamento,
  encerrarPrescricao,
  listarMedicamentos,
  listarPrescricoes,
  listarReceitas,
  lerReceita,
  novaVersao,
  obterPrescricao,
  prescrever,
  type ConteudoDePrescricao,
} from "@/modules/prescricoes";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import { criarAtorTablet, criarAtorWeb, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const UUID_INEXISTENTE = "00000000-0000-4000-8000-0000000000aa";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let armazenamento: ArmazenamentoEmMemoria;
let agora: Date;
let enf: AtorWeb;
let enfB: AtorWeb;
let n = 0;

const servico = (): Servico => ({
  pool: app,
  chaveCampos: CHAVE,
  armazenamento,
  agora: () => agora,
});
const hoje = () => agora.toISOString().slice(0, 10);

async function sql<T extends pg.QueryResultRow>(casaId: string, texto: string, v: unknown[] = []) {
  return comContexto(app, { casaId }, async (c) => (await c.query<T>(texto, v)).rows);
}

async function novoMedicamento(
  extra: Partial<Parameters<typeof cadastrarMedicamento>[2]> = {},
  ator = enf,
) {
  n += 1;
  const r = await cadastrarMedicamento(servico(), ator, {
    nomeComercial: `Remedio ${n}`,
    principioAtivo: `Substancia${n}x`,
    concentracao: "500 mg",
    forma: "comprimido",
    ...extra,
  });
  if (!r.ok) throw new Error(`medicamento: ${r.motivo}`);
  return r.medicamentoId;
}

async function novoIdoso(
  ator = enf,
  alergias: Array<{ substancia: string; gravidade: "leve" | "moderada" | "grave" }> = [],
) {
  n += 1;
  const r = await cadastrarIdoso(servico(), ator, {
    nome: `Idoso Teste ${n}`,
    dataNascimento: "1940-01-01",
    alergias,
  });
  if (!r.ok) throw new Error("idoso");
  return r.idosoId;
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
  medicamentoId: string,
  extra: Partial<ConteudoDePrescricao> = {},
) {
  const r = await prescrever(servico(), enf, { idosoId, ...conteudo(medicamentoId, extra) });
  if (!r.ok) throw new Error(`prescrever: ${r.motivo}`);
  return r;
}

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("RECEITA-CONFIDENCIAL-DO-PACIENTE"),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png-qualquer"),
]);
const PDF = Buffer.from("%PDF-1.7\nconteudo da receita");

beforeAll(async () => {
  app = criarPoolApp(8);
  migrador = criarPoolMigrador();
  armazenamento = new ArmazenamentoEmMemoria();
  agora = new Date("2026-03-10T15:00:00Z");
  casaA = await criarCasa(migrador, "Casa A Prescricoes");
  casaB = await criarCasa(migrador, "Casa B Prescricoes");
  enf = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
  enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("catálogo de medicamentos", () => {
  it("cadastra, lista em ordem e sugere alto risco pelo princípio ativo", async () => {
    const insulina = await cadastrarMedicamento(servico(), enf, {
      nomeComercial: "Insulina NPH Catálogo",
      principioAtivo: "Insulina humana",
      forma: "injetavel",
    });
    expect(insulina).toMatchObject({ ok: true, altoRisco: true });
    const comum = await cadastrarMedicamento(servico(), enf, {
      nomeComercial: "Comum Catálogo",
      principioAtivo: "Losartana",
      forma: "comprimido",
    });
    expect(comum).toMatchObject({ ok: true, altoRisco: false });
    const lista = await listarMedicamentos(servico(), enf);
    const nomes = lista.map((m) => m.nomeComercial);
    expect(nomes.indexOf("Comum Catálogo")).toBeLessThan(nomes.indexOf("Insulina NPH Catálogo"));
  });

  it("respeita a escolha explícita de alto risco, nos dois sentidos", async () => {
    const a = await cadastrarMedicamento(servico(), enf, {
      nomeComercial: "Explícito 1",
      principioAtivo: "Varfarina",
      forma: "comprimido",
      altoRisco: false,
    });
    const b = await cadastrarMedicamento(servico(), enf, {
      nomeComercial: "Explícito 2",
      principioAtivo: "Paracetamol",
      forma: "comprimido",
      altoRisco: true,
    });
    expect(a).toMatchObject({ ok: true, altoRisco: false });
    expect(b).toMatchObject({ ok: true, altoRisco: true });
  });

  it("recusa duplicata ignorando caixa e espaços, mesmo com dois cadastros simultâneos", async () => {
    const base = {
      nomeComercial: "Duplicável",
      principioAtivo: "Substância Dup",
      concentracao: "10 mg",
      forma: "comprimido" as const,
    };
    const [x, y] = await Promise.all([
      cadastrarMedicamento(servico(), enf, base),
      cadastrarMedicamento(servico(), enf, base),
    ]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    const repetido = await cadastrarMedicamento(servico(), enf, {
      ...base,
      nomeComercial: "  DUPLICÁVEL ",
      principioAtivo: "substância dup",
    });
    expect(repetido).toEqual({ ok: false, motivo: "ja_cadastrado" });
    // Outra concentração é outro medicamento.
    expect(
      (await cadastrarMedicamento(servico(), enf, { ...base, concentracao: "20 mg" })).ok,
    ).toBe(true);
  });

  it("recusa dados inválidos", async () => {
    const r = await cadastrarMedicamento(servico(), enf, {
      nomeComercial: "x",
      principioAtivo: "",
      forma: "xarope",
    });
    expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    const r2 = await cadastrarMedicamento(servico(), enf, {
      nomeComercial: "Bom nome",
      principioAtivo: "Bom",
      forma: "bala" as never,
    });
    expect(r2).toMatchObject({ motivo: "dados_invalidos" });
  });

  it("só enfermeiro e gestor mexem no catálogo", async () => {
    const cuidador = await criarAtorTablet(servico, migrador, casaA);
    await expect(listarMedicamentos(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      cadastrarMedicamento(servico(), cuidador, {
        nomeComercial: "Nao",
        principioAtivo: "Nao",
        forma: "outro",
      }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(
      desativarMedicamento(servico(), cuidador, { medicamentoId: UUID_INEXISTENTE }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
  });

  it("cada casa tem seu catálogo: mesmo nome em outra casa é permitido e não aparece na primeira", async () => {
    const base = {
      nomeComercial: "Isolado Catálogo",
      principioAtivo: "Isolada",
      forma: "comprimido" as const,
    };
    expect((await cadastrarMedicamento(servico(), enf, base)).ok).toBe(true);
    expect((await cadastrarMedicamento(servico(), enfB, base)).ok).toBe(true);
    const daB = await listarMedicamentos(servico(), enfB);
    expect(daB.filter((m) => m.nomeComercial === "Isolado Catálogo")).toHaveLength(1);
    expect(daB.map((m) => m.nomeComercial)).not.toContain("Comum Catálogo");
  });

  it("desativar: recusa se há prescrição ativa, aceita depois de encerrar, e some da lista", async () => {
    const med = await novoMedicamento();
    const idoso = await novoIdoso();
    const p = await prescreverOk(idoso, med);
    expect(await desativarMedicamento(servico(), enf, { medicamentoId: med })).toEqual({
      ok: false,
      motivo: "em_uso",
    });
    await encerrarPrescricao(servico(), enf, {
      prescricaoId: p.prescricaoId,
      motivo: "Tratamento concluído",
    });
    expect(await desativarMedicamento(servico(), enf, { medicamentoId: med })).toEqual({
      ok: true,
    });
    expect((await listarMedicamentos(servico(), enf)).map((m) => m.id)).not.toContain(med);
    expect(
      (await listarMedicamentos(servico(), enf, { incluirInativos: true })).map((m) => m.id),
    ).toContain(med);
    // Medicamento fora do catálogo não pode mais ser prescrito.
    expect(await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) })).toEqual({
      ok: false,
      motivo: "medicamento_nao_encontrado",
    });
  });

  it("mudar a política de alto risco é auditado e repetir o mesmo valor é recusado", async () => {
    const med = await novoMedicamento({ altoRisco: false });
    expect(
      await definirAltoRiscoDoMedicamento(servico(), enf, { medicamentoId: med, altoRisco: true }),
    ).toEqual({ ok: true });
    expect(
      await definirAltoRiscoDoMedicamento(servico(), enf, { medicamentoId: med, altoRisco: true }),
    ).toEqual({ ok: false, motivo: "sem_mudanca" });
    expect(
      await definirAltoRiscoDoMedicamento(servico(), enfB, {
        medicamentoId: med,
        altoRisco: false,
      }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    const log = await sql<{ antes: unknown; depois: unknown }>(
      casaA,
      "SELECT antes, depois FROM auditoria WHERE acao = 'medicamento.alto_risco_alterado' AND entidade_id = $1",
      [med],
    );
    expect(log).toEqual([{ antes: { altoRisco: false }, depois: { altoRisco: true } }]);
  });
});

describe("prescrever", () => {
  it("grava a prescrição regular com os horários e a mostra vigente", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const r = await prescreverOk(idoso, med, {
      dose: 2.5,
      instrucoes: "  Após o café  ",
      fim: "2026-03-15",
      prescritor: "Dra. Helena",
      horarios: [{ hora: "20:00" }, { hora: "08:00", diasSemana: [5, 1, 3, 3] }],
    });
    const [p] = await listarPrescricoes(servico(), enf, { idosoId: idoso });
    expect(p).toMatchObject({
      id: r.prescricaoId,
      versao: 1,
      dose: 2.5,
      unidade: "comprimido",
      via: "oral",
      instrucoes: "Após o café",
      inicio: "2026-03-10",
      fim: "2026-03-15",
      prescritor: "Dra. Helena",
      status: "ativa",
      situacao: "vigente",
      diasParaVencer: 5,
      receitas: 0,
      horarios: [
        { hora: "08:00", diasSemana: [1, 3, 5] },
        { hora: "20:00", diasSemana: [1, 2, 3, 4, 5, 6, 7] },
      ],
    });
  });

  it("grava a prescrição SOS com limite e intervalo, sem horários", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    await prescreverOk(idoso, med, {
      tipo: "sos",
      horarios: [],
      sos: { indicacao: "Dor de cabeça", limiteDiario: 3, intervaloMinimoMin: 360 },
    });
    const [p] = await listarPrescricoes(servico(), enf, { idosoId: idoso });
    expect(p).toMatchObject({
      tipo: "sos",
      horarios: [],
      sos: { indicacao: "Dor de cabeça", limiteDiario: 3, intervaloMinimoMin: 360 },
    });
  });

  it("recusa dados inválidos sem gravar nada", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const r = await prescrever(servico(), enf, {
      idosoId: idoso,
      ...conteudo(med, { dose: 0, horarios: [] }),
    });
    expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    expect(await sql(casaA, "SELECT 1 FROM prescricao WHERE idoso_id = $1", [idoso])).toHaveLength(
      0,
    );
  });

  it("usa a data de hoje do fuso da casa, não a data em UTC", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const original = agora;
    // 01h UTC do dia 11 ainda é noite do dia 10 em São Paulo.
    agora = new Date("2026-03-11T01:00:00Z");
    try {
      expect(
        (
          await prescrever(servico(), enf, {
            idosoId: idoso,
            ...conteudo(med, { inicio: "2026-03-10", fim: "2026-03-10" }),
          })
        ).ok,
      ).toBe(true);
    } finally {
      agora = original;
    }
  });

  it("recusa idoso inexistente, de outra casa ou desligado", async () => {
    const med = await novoMedicamento();
    expect(
      await prescrever(servico(), enf, { idosoId: UUID_INEXISTENTE, ...conteudo(med) }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    const idosoB = await novoIdoso(enfB);
    expect(await prescrever(servico(), enf, { idosoId: idosoB, ...conteudo(med) })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    const idoso = await novoIdoso();
    await mudarStatusDoIdoso(servico(), enf, { idosoId: idoso, status: "desligado" });
    expect(await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) })).toEqual({
      ok: false,
      motivo: "idoso_desligado",
    });
    // Hospitalizado continua podendo receber prescrição (a volta é rápida).
    const internado = await novoIdoso();
    await mudarStatusDoIdoso(servico(), enf, { idosoId: internado, status: "hospitalizado" });
    expect((await prescrever(servico(), enf, { idosoId: internado, ...conteudo(med) })).ok).toBe(
      true,
    );
  });

  it("não aceita medicamento de outra casa", async () => {
    const idoso = await novoIdoso();
    const medB = await novoMedicamento({}, enfB);
    expect(await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(medB) })).toEqual({
      ok: false,
      motivo: "medicamento_nao_encontrado",
    });
  });

  it("recusa a segunda prescrição ativa do mesmo medicamento, mas permite regular + SOS", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    await prescreverOk(idoso, med);
    expect(await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) })).toEqual({
      ok: false,
      motivo: "ja_existe_ativa",
    });
    const sos = await prescrever(servico(), enf, {
      idosoId: idoso,
      ...conteudo(med, {
        tipo: "sos",
        horarios: [],
        sos: { indicacao: "Dor", limiteDiario: 2, intervaloMinimoMin: 240 },
      }),
    });
    expect(sos.ok).toBe(true);
  });

  it("duas prescrições simultâneas do mesmo medicamento: só uma entra", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const resultados = await Promise.all([
      prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) }),
      prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) }),
      prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) }),
    ]);
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(await sql(casaA, "SELECT 1 FROM prescricao WHERE idoso_id = $1", [idoso])).toHaveLength(
      1,
    );
  });

  it("medicamento de alto risco na casa não pode ser prescrito como comum", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento({ altoRisco: true });
    expect(
      await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med, { altoRisco: false }) }),
    ).toEqual({ ok: false, motivo: "alto_risco_obrigatorio" });
    expect(
      (await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med, { altoRisco: true }) }))
        .ok,
    ).toBe(true);
  });

  it("alergia: avisa antes de gravar e só grava com justificativa; a justificativa não vai para a auditoria", async () => {
    const idoso = await novoIdoso(enf, [{ substancia: "Dipirona", gravidade: "grave" }]);
    const med = await novoMedicamento({
      nomeComercial: "Novalgina Teste",
      principioAtivo: "Dipirona sódica",
    });

    const aviso = await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) });
    expect(aviso).toMatchObject({
      ok: false,
      motivo: "conflito_alergia",
      conflitos: [{ substancia: "Dipirona", gravidade: "grave", tipo: "mesma_substancia" }],
    });
    expect(await sql(casaA, "SELECT 1 FROM prescricao WHERE idoso_id = $1", [idoso])).toHaveLength(
      0,
    );

    const curta = await prescrever(servico(), enf, {
      idosoId: idoso,
      ...conteudo(med),
      justificativaAlergia: "ok",
    });
    expect(curta).toMatchObject({ motivo: "conflito_alergia" });

    const ok = await prescrever(servico(), enf, {
      idosoId: idoso,
      ...conteudo(med),
      justificativaAlergia: "Médico ciente, tolera em dose baixa SEGREDO-CLINICO",
    });
    expect(ok).toMatchObject({ ok: true, conflitosConfirmados: [{ substancia: "Dipirona" }] });
    const [linha] = await sql<{ justificativa: string }>(
      casaA,
      "SELECT justificativa FROM prescricao WHERE idoso_id = $1",
      [idoso],
    );
    expect(linha?.justificativa).toContain("SEGREDO-CLINICO");
    const auditoria = JSON.stringify(await sql(casaA, "SELECT to_jsonb(a) AS l FROM auditoria a"));
    expect(auditoria).not.toContain("SEGREDO-CLINICO");
    expect(auditoria).not.toContain("Dipirona");
  });

  it("alergia desativada não bloqueia", async () => {
    const idoso = await novoIdoso(enf, [{ substancia: "Ibuprofeno", gravidade: "moderada" }]);
    const med = await novoMedicamento({ principioAtivo: "Ibuprofeno" });
    expect(await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) })).toMatchObject({
      motivo: "conflito_alergia",
    });
    await sql(
      casaA,
      "UPDATE alergia SET ativa = false, desativada_em = now() WHERE idoso_id = $1",
      [idoso],
    );
    expect((await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) })).ok).toBe(true);
  });

  it("só enfermeiro e gestor prescrevem", async () => {
    const cuidador = await criarAtorTablet(servico, migrador, casaA);
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    await expect(
      prescrever(servico(), cuidador, { idosoId: idoso, ...conteudo(med) }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(listarPrescricoes(servico(), cuidador, { idosoId: idoso })).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
  });
});

describe("versões e encerramento", () => {
  it("mudar a dose cria a versão 2, substitui a 1 e guarda quem, quando e por quê", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const v1 = await prescreverOk(idoso, med);
    agora = new Date("2026-03-12T10:00:00Z");
    const v2 = await novaVersao(servico(), enf, {
      prescricaoId: v1.prescricaoId,
      justificativa: "Ajuste após consulta",
      conteudo: conteudo(med, { dose: 2, inicio: "2026-03-10" }),
    });
    expect(v2).toMatchObject({ ok: true, versao: 2, camposAlterados: ["dose"] });

    const ativas = await listarPrescricoes(servico(), enf, { idosoId: idoso });
    expect(ativas).toHaveLength(1);
    expect(ativas[0]).toMatchObject({
      versao: 2,
      dose: 2,
      status: "ativa",
      justificativa: "Ajuste após consulta",
    });

    const detalhe = await obterPrescricao(servico(), enf, v1.prescricaoId);
    if (!detalhe.ok) throw new Error("deveria achar");
    expect(detalhe.historico.map((h) => [h.versao, h.status, h.dose])).toEqual([
      [2, "ativa", 2],
      [1, "substituida", 1],
    ]);
    expect(detalhe.historico[1]).toMatchObject({
      motivoEncerramento: "Ajuste após consulta",
      encerradaEm: "2026-03-12T10:00:00.000Z",
    });
    expect(detalhe.historico[1]?.situacao).toBe("encerrada");

    const [log] = await sql<{ antes: unknown; depois: { campos: string[]; versao: number } }>(
      casaA,
      "SELECT antes, depois FROM auditoria WHERE acao = 'prescricao.nova_versao' AND entidade_id = $1",
      [v2.ok ? v2.prescricaoId : ""],
    );
    expect(log?.depois).toMatchObject({ campos: ["dose"], versao: 2 });
    agora = new Date("2026-03-10T15:00:00Z");
  });

  it("muda horário, via e vigência de uma vez e informa todos os campos", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const v1 = await prescreverOk(idoso, med);
    const r = await novaVersao(servico(), enf, {
      prescricaoId: v1.prescricaoId,
      justificativa: "Troca de esquema",
      conteudo: conteudo(med, {
        via: "sublingual",
        horarios: [{ hora: "12:00" }],
        fim: "2026-04-01",
      }),
    });
    expect(r).toMatchObject({ ok: true, camposAlterados: ["via", "fim", "horarios"] });
  });

  it("recusa versão idêntica, sem justificativa, de outro medicamento e de versão já substituída", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const outro = await novoMedicamento();
    const v1 = await prescreverOk(idoso, med);
    const base = { prescricaoId: v1.prescricaoId, justificativa: "Motivo claro" };
    expect(await novaVersao(servico(), enf, { ...base, conteudo: conteudo(med) })).toEqual({
      ok: false,
      motivo: "sem_mudanca",
    });
    expect(
      await novaVersao(servico(), enf, {
        ...base,
        justificativa: " ",
        conteudo: conteudo(med, { dose: 3 }),
      }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    expect(await novaVersao(servico(), enf, { ...base, conteudo: conteudo(outro) })).toEqual({
      ok: false,
      motivo: "medicamento_diferente",
    });
    expect(
      await novaVersao(servico(), enf, { ...base, conteudo: conteudo(med, { dose: 0 }) }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    expect(
      (await novaVersao(servico(), enf, { ...base, conteudo: conteudo(med, { dose: 3 }) })).ok,
    ).toBe(true);
    // A versão 1 já foi substituída: não se edita versão antiga.
    expect(
      await novaVersao(servico(), enf, { ...base, conteudo: conteudo(med, { dose: 4 }) }),
    ).toEqual({ ok: false, motivo: "nao_ativa" });
  });

  it("duas alterações simultâneas da mesma prescrição: só uma vira versão 2", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const v1 = await prescreverOk(idoso, med);
    const rs = await Promise.all(
      [2, 3, 4].map((dose) =>
        novaVersao(servico(), enf, {
          prescricaoId: v1.prescricaoId,
          justificativa: "Corrida",
          conteudo: conteudo(med, { dose }),
        }),
      ),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.motivo === "nao_ativa")).toBe(true);
    const ativas = await sql(
      casaA,
      "SELECT 1 FROM prescricao WHERE idoso_id = $1 AND status = 'ativa'",
      [idoso],
    );
    expect(ativas).toHaveLength(1);
  });

  it("nova versão reconfere alergia cadastrada depois da prescrição original", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento({ principioAtivo: "Amoxicilina" });
    const v1 = await prescreverOk(idoso, med);
    await sql(
      casaA,
      "INSERT INTO alergia (casa_id, idoso_id, substancia, gravidade) VALUES (app_casa_id(), $1, 'Penicilina', 'grave')",
      [idoso],
    );
    const sem = await novaVersao(servico(), enf, {
      prescricaoId: v1.prescricaoId,
      justificativa: "Aumento",
      conteudo: conteudo(med, { dose: 2 }),
    });
    expect(sem).toMatchObject({
      ok: false,
      motivo: "conflito_alergia",
      conflitos: [{ tipo: "mesma_familia" }],
    });
    const com = await novaVersao(servico(), enf, {
      prescricaoId: v1.prescricaoId,
      justificativa: "Aumento",
      justificativaAlergia: "Médico ciente da alergia",
      conteudo: conteudo(med, { dose: 2 }),
    });
    expect(com.ok).toBe(true);
  });

  it("encerrar: registra motivo, recusa repetir e libera nova prescrição do mesmo medicamento", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const p = await prescreverOk(idoso, med);
    expect(
      await encerrarPrescricao(servico(), enf, { prescricaoId: p.prescricaoId, motivo: "" }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    expect(
      await encerrarPrescricao(servico(), enf, {
        prescricaoId: p.prescricaoId,
        motivo: "Suspenso pelo médico",
      }),
    ).toEqual({ ok: true });
    expect(
      await encerrarPrescricao(servico(), enf, { prescricaoId: p.prescricaoId, motivo: "De novo" }),
    ).toEqual({ ok: false, motivo: "nao_ativa" });
    expect(
      await novaVersao(servico(), enf, {
        prescricaoId: p.prescricaoId,
        justificativa: "Tentativa",
        conteudo: conteudo(med, { dose: 2 }),
      }),
    ).toEqual({ ok: false, motivo: "nao_ativa" });
    expect(await listarPrescricoes(servico(), enf, { idosoId: idoso })).toHaveLength(0);
    const todas = await listarPrescricoes(servico(), enf, {
      idosoId: idoso,
      incluirInativas: true,
    });
    expect(todas[0]).toMatchObject({
      status: "encerrada",
      motivoEncerramento: "Suspenso pelo médico",
      situacao: "encerrada",
    });
    expect((await prescrever(servico(), enf, { idosoId: idoso, ...conteudo(med) })).ok).toBe(true);
  });

  it("a casa B não enxerga nem altera prescrições da casa A", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const p = await prescreverOk(idoso, med);
    expect(await obterPrescricao(servico(), enfB, p.prescricaoId)).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(await listarPrescricoes(servico(), enfB, { idosoId: idoso })).toEqual([]);
    expect(
      await encerrarPrescricao(servico(), enfB, {
        prescricaoId: p.prescricaoId,
        motivo: "Invasão",
      }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(
      await novaVersao(servico(), enfB, {
        prescricaoId: p.prescricaoId,
        justificativa: "Invasão",
        conteudo: conteudo(med, { dose: 9 }),
      }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    const [linha] = await sql<{ status: string; dose: string }>(
      casaA,
      "SELECT status, dose::text FROM prescricao WHERE id = $1",
      [p.prescricaoId],
    );
    expect(linha).toEqual({ status: "ativa", dose: "1.000" });
  });

  it("a auditoria não guarda conteúdo clínico, só identificadores e nomes de campos", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const p = await prescreverOk(idoso, med, {
      instrucoes: "INSTRUCAO-SIGILOSA",
      prescritor: "PRESCRITOR-SIGILOSO",
    });
    await novaVersao(servico(), enf, {
      prescricaoId: p.prescricaoId,
      justificativa: "JUSTIFICATIVA-SIGILOSA",
      conteudo: conteudo(med, { dose: 5, instrucoes: "INSTRUCAO-SIGILOSA" }),
    });
    const tudo = JSON.stringify(await sql(casaA, "SELECT to_jsonb(a) AS l FROM auditoria a"));
    for (const s of ["INSTRUCAO-SIGILOSA", "PRESCRITOR-SIGILOSO", "JUSTIFICATIVA-SIGILOSA"])
      expect(tudo).not.toContain(s);
  });
});

describe("garantias do banco (mesmo se a aplicação errar)", () => {
  async function criarPrescricaoDireta() {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    return { ...(await prescreverOk(idoso, med)), idoso, med };
  }

  it("o conteúdo clínico de uma prescrição não pode ser alterado por UPDATE", async () => {
    const { prescricaoId } = await criarPrescricaoDireta();
    for (const alteracao of [
      "dose = 99",
      "via = 'retal'",
      "inicio = inicio - 1",
      "fim = inicio + 30",
      "alto_risco = NOT alto_risco",
      "instrucoes = 'x'",
      "versao = 7",
      "justificativa = 'x'",
    ]) {
      await expect(
        sql(casaA, `UPDATE prescricao SET ${alteracao} WHERE id = $1`, [prescricaoId]),
        alteracao,
      ).rejects.toThrow(/não pode ser alterado/);
    }
  });

  it("encerrada não reabre, e prescrição nunca é apagada", async () => {
    const { prescricaoId } = await criarPrescricaoDireta();
    await encerrarPrescricao(servico(), enf, { prescricaoId, motivo: "Fim do tratamento" });
    await expect(
      sql(
        casaA,
        "UPDATE prescricao SET status = 'ativa', encerrada_em = NULL, encerrada_por = NULL, motivo_encerramento = NULL WHERE id = $1",
        [prescricaoId],
      ),
    ).rejects.toThrow();
    await expect(
      sql(casaA, "DELETE FROM prescricao WHERE id = $1", [prescricaoId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("horários só se inserem: UPDATE e DELETE são negados", async () => {
    const { prescricaoId } = await criarPrescricaoDireta();
    await expect(
      sql(casaA, "UPDATE horario_prescricao SET hora = '03:00' WHERE prescricao_id = $1", [
        prescricaoId,
      ]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      sql(casaA, "DELETE FROM horario_prescricao WHERE prescricao_id = $1", [prescricaoId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("o índice garante uma única versão ativa por prescrição", async () => {
    const { prescricaoId, grupoId, idoso, med } = await criarPrescricaoDireta();
    await expect(
      sql(
        casaA,
        `INSERT INTO prescricao (casa_id, idoso_id, medicamento_id, grupo_id, versao, substitui_id, tipo, dose, unidade, via, inicio, justificativa)
         VALUES (app_casa_id(), $1, $2, $3, 2, $4, 'regular', 1, 'comprimido', 'oral', current_date, 'dupla ativa')`,
        [idoso, med, grupoId, prescricaoId],
      ),
    ).rejects.toThrow(/prescricao_uma_ativa_por_grupo|duplicate/i);
  });

  it("as regras de consistência valem no banco: SOS incompleto, fim antes do início, versão sem justificativa", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const base = (extra: string) =>
      sql(
        casaA,
        `INSERT INTO prescricao (casa_id, idoso_id, medicamento_id, grupo_id, versao, tipo, dose, unidade, via, inicio ${extra.split("|")[0]})
         VALUES (app_casa_id(), $1, $2, gen_random_uuid(), 1, ${extra.split("|")[1]})`,
        [idoso, med],
      );
    await expect(base(`|'sos', 1, 'comprimido', 'oral', current_date`)).rejects.toThrow(
      /prescricao_sos_completa/,
    );
    await expect(
      base(`, fim|'regular', 1, 'comprimido', 'oral', current_date, current_date - 1`),
    ).rejects.toThrow(/prescricao_fim_depois_do_inicio/);
    await expect(base(`|'regular', 0, 'comprimido', 'oral', current_date`)).rejects.toThrow(
      /dose|check/i,
    );
    await expect(
      sql(
        casaA,
        `INSERT INTO prescricao (casa_id, idoso_id, medicamento_id, grupo_id, versao, tipo, dose, unidade, via, inicio)
                  VALUES (app_casa_id(), $1, $2, gen_random_uuid(), 2, 'regular', 1, 'comprimido', 'oral', current_date)`,
        [idoso, med],
      ),
    ).rejects.toThrow(/prescricao_versao_/);
  });

  it("a chave composta impede apontar para idoso ou medicamento de outra casa", async () => {
    const idosoB = await novoIdoso(enfB);
    const med = await novoMedicamento();
    await expect(
      sql(
        casaA,
        `INSERT INTO prescricao (casa_id, idoso_id, medicamento_id, grupo_id, versao, tipo, dose, unidade, via, inicio)
                  VALUES (app_casa_id(), $1, $2, gen_random_uuid(), 1, 'regular', 1, 'comprimido', 'oral', current_date)`,
        [idosoB, med],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("receita da prescrição", () => {
  async function comPrescricao() {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    return prescreverOk(idoso, med);
  }

  it("guarda a receita cifrada no armazenamento e devolve os mesmos bytes ao ler", async () => {
    const { prescricaoId } = await comPrescricao();
    for (const [bytes, tipo] of [
      [JPEG, "image/jpeg"],
      [PNG, "image/png"],
      [PDF, "application/pdf"],
    ] as const) {
      const r = await anexarReceita(servico(), enf, { prescricaoId, bytes });
      expect(r).toMatchObject({ ok: true, tipoMime: tipo, tamanhoBytes: bytes.length });
      if (!r.ok) continue;
      const lida = await lerReceita(servico(), enf, { prescricaoId, receitaId: r.receitaId });
      expect(lida).toMatchObject({ ok: true, tipoMime: tipo });
      expect(lida.ok && Buffer.compare(lida.bytes, bytes)).toBe(0);
    }
    // Nada no armazenamento contém o texto do arquivo original.
    for (const guardado of armazenamento.objetos.values()) {
      expect(Buffer.from(guardado).includes("RECEITA-CONFIDENCIAL")).toBe(false);
    }
    expect(
      (await listarReceitas(servico(), enf, prescricaoId)).map((r) => r.tipoMime).sort(),
    ).toEqual(["application/pdf", "image/jpeg", "image/png"]);
    const [p] = await listarPrescricoes(servico(), enf, {
      idosoId:
        (
          await sql<{ idoso_id: string }>(casaA, "SELECT idoso_id FROM prescricao WHERE id = $1", [
            prescricaoId,
          ])
        )[0]?.idoso_id ?? "",
    });
    expect(p?.receitas).toBe(3);
  });

  it("reconhece o tipo pelo conteúdo e recusa o que não é imagem nem PDF", async () => {
    const { prescricaoId } = await comPrescricao();
    const recusados = [
      Buffer.from("<html><script>alert(1)</script></html>"),
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      Buffer.from("MZ\x90\x00 executavel"),
      Buffer.from("texto qualquer"),
      Buffer.from([0xff, 0xd8]), // começo de JPEG truncado
      Buffer.alloc(0),
    ];
    for (const bytes of recusados) {
      expect(await anexarReceita(servico(), enf, { prescricaoId, bytes })).toEqual({
        ok: false,
        motivo: "arquivo_invalido",
      });
    }
    expect(await listarReceitas(servico(), enf, prescricaoId)).toEqual([]);
  });

  it("recusa arquivo acima de 10 MB", async () => {
    const { prescricaoId } = await comPrescricao();
    const grande = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]);
    expect(await anexarReceita(servico(), enf, { prescricaoId, bytes: grande })).toEqual({
      ok: false,
      motivo: "arquivo_grande_demais",
    });
  });

  it("falha no armazenamento desfaz tudo: sem linha no banco e sem auditoria", async () => {
    const { prescricaoId } = await comPrescricao();
    armazenamento.falharNaGravacao = true;
    try {
      await expect(anexarReceita(servico(), enf, { prescricaoId, bytes: JPEG })).rejects.toThrow();
    } finally {
      armazenamento.falharNaGravacao = false;
    }
    expect(await listarReceitas(servico(), enf, prescricaoId)).toEqual([]);
    expect(
      await sql(
        casaA,
        "SELECT 1 FROM auditoria WHERE acao = 'receita.anexada' AND depois->>'prescricaoId' = $1",
        [prescricaoId],
      ),
    ).toHaveLength(0);
  });

  it("a receita vale para o histórico: aparece nas versões seguintes da prescrição", async () => {
    const idoso = await novoIdoso();
    const med = await novoMedicamento();
    const v1 = await prescreverOk(idoso, med);
    const r = await anexarReceita(servico(), enf, { prescricaoId: v1.prescricaoId, bytes: PDF });
    const v2 = await novaVersao(servico(), enf, {
      prescricaoId: v1.prescricaoId,
      justificativa: "Ajuste",
      conteudo: conteudo(med, { dose: 2 }),
    });
    if (!r.ok || !v2.ok) throw new Error("setup");
    expect((await listarReceitas(servico(), enf, v2.prescricaoId)).map((x) => x.id)).toEqual([
      r.receitaId,
    ]);
    expect(
      (await lerReceita(servico(), enf, { prescricaoId: v2.prescricaoId, receitaId: r.receitaId }))
        .ok,
    ).toBe(true);
  });

  it("não lê receita de outra prescrição, de outra casa, nem id inexistente", async () => {
    const a = await comPrescricao();
    const b = await comPrescricao();
    const ra = await anexarReceita(servico(), enf, { prescricaoId: a.prescricaoId, bytes: JPEG });
    if (!ra.ok) throw new Error("setup");
    expect(
      await lerReceita(servico(), enf, { prescricaoId: b.prescricaoId, receitaId: ra.receitaId }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(
      await lerReceita(servico(), enfB, { prescricaoId: a.prescricaoId, receitaId: ra.receitaId }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(
      await lerReceita(servico(), enf, {
        prescricaoId: a.prescricaoId,
        receitaId: UUID_INEXISTENTE,
      }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await listarReceitas(servico(), enfB, a.prescricaoId)).toEqual([]);
    expect(
      await anexarReceita(servico(), enfB, { prescricaoId: a.prescricaoId, bytes: JPEG }),
    ).toEqual({ ok: false, motivo: "nao_encontrado" });
  });

  it("detecta adulteração e troca de arquivos no armazenamento", async () => {
    const a = await comPrescricao();
    const ra = await anexarReceita(servico(), enf, { prescricaoId: a.prescricaoId, bytes: JPEG });
    const rb = await anexarReceita(servico(), enf, { prescricaoId: a.prescricaoId, bytes: PDF });
    if (!ra.ok || !rb.ok) throw new Error("setup");
    const chaveDe = async (id: string) =>
      (
        await sql<{ chave: string }>(casaA, "SELECT chave FROM receita_prescricao WHERE id = $1", [
          id,
        ])
      )[0]?.chave;
    const chaveA = await chaveDe(ra.receitaId);
    const chaveB = await chaveDe(rb.receitaId);
    if (!chaveA || !chaveB) throw new Error("setup");
    const objA = armazenamento.objetos.get(chaveA);
    const objB = armazenamento.objetos.get(chaveB);
    if (!objA || !objB) throw new Error("setup");

    // 1) bit alterado
    const adulterado = Uint8Array.from(objA);
    adulterado[adulterado.length - 1] = (adulterado[adulterado.length - 1] ?? 0) ^ 1;
    armazenamento.objetos.set(chaveA, adulterado);
    await expect(
      lerReceita(servico(), enf, { prescricaoId: a.prescricaoId, receitaId: ra.receitaId }),
    ).rejects.toThrow();
    // 2) conteúdo de outra receita colocado na chave desta
    armazenamento.objetos.set(chaveA, objB);
    await expect(
      lerReceita(servico(), enf, { prescricaoId: a.prescricaoId, receitaId: ra.receitaId }),
    ).rejects.toThrow();
    armazenamento.objetos.set(chaveA, objA);
    expect(
      (await lerReceita(servico(), enf, { prescricaoId: a.prescricaoId, receitaId: ra.receitaId }))
        .ok,
    ).toBe(true);
  });

  it("anexar e ler ficam na trilha, sem o conteúdo do arquivo", async () => {
    const { prescricaoId } = await comPrescricao();
    const r = await anexarReceita(servico(), enf, { prescricaoId, bytes: JPEG });
    if (!r.ok) throw new Error("setup");
    await lerReceita(servico(), enf, { prescricaoId, receitaId: r.receitaId });
    const acoes = await sql<{ acao: string; usuario_id: string }>(
      casaA,
      "SELECT acao, usuario_id FROM auditoria WHERE entidade_id = $1 ORDER BY seq",
      [r.receitaId],
    );
    expect(acoes.map((a) => a.acao)).toEqual(["receita.anexada", "receita.lida"]);
    expect(acoes.every((a) => a.usuario_id === enf.usuarioId)).toBe(true);
    expect(
      JSON.stringify(await sql(casaA, "SELECT to_jsonb(a) AS l FROM auditoria a")),
    ).not.toContain("RECEITA-CONFIDENCIAL");
  });

  it("só enfermeiro e gestor anexam ou leem receitas", async () => {
    const { prescricaoId } = await comPrescricao();
    const cuidador = await criarAtorTablet(servico, migrador, casaA);
    await expect(
      anexarReceita(servico(), cuidador, { prescricaoId, bytes: JPEG }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(listarReceitas(servico(), cuidador, prescricaoId)).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
    await expect(
      lerReceita(servico(), cuidador, { prescricaoId, receitaId: UUID_INEXISTENTE }),
    ).rejects.toBeInstanceOf(ErroDePermissao);
  });

  it("o banco recusa alterar ou apagar o registro da receita", async () => {
    const { prescricaoId } = await comPrescricao();
    const r = await anexarReceita(servico(), enf, { prescricaoId, bytes: JPEG });
    if (!r.ok) throw new Error("setup");
    await expect(
      sql(casaA, "UPDATE receita_prescricao SET sha256 = repeat('0', 64) WHERE id = $1", [
        r.receitaId,
      ]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      sql(casaA, "DELETE FROM receita_prescricao WHERE id = $1", [r.receitaId]),
    ).rejects.toThrow(/permission denied/i);
  });
});
