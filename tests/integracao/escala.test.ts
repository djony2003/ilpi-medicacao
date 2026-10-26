import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import {
  dadosDaFolhaDeContingencia,
  escalaDoPlantao,
  gerarDosesDaCasa,
  gerarPdfDaFolha,
} from "@/modules/administracao";
import { type Servico } from "@/modules/identidade";
import {
  adicionarAlergia,
  cadastrarIdoso,
  desativarAlergia,
  mudarStatusDoIdoso,
} from "@/modules/idosos";
import {
  cadastrarMedicamento,
  encerrarPrescricao,
  prescrever,
  type ConteudoDePrescricao,
} from "@/modules/prescricoes";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import { criarAtorTablet, criarAtorWeb, type AtorTablet, type AtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let enf: AtorWeb;
let enfB: AtorWeb;
let cuidador: AtorTablet;
let agora: Date;
let n = 0;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });
const T = (iso: string) => new Date(iso);

async function novoIdoso(
  ator: AtorWeb,
  extra: {
    nome?: string;
    quarto?: string;
    alergias?: { substancia: string; gravidade: "leve" | "moderada" | "grave" }[];
  } = {},
) {
  n += 1;
  const r = await cadastrarIdoso(servico(), ator, {
    nome: extra.nome ?? `Residente Escala ${n}`,
    dataNascimento: "1940-01-01",
    quarto: extra.quarto,
    alergias: extra.alergias ?? [],
  });
  if (!r.ok) throw new Error("idoso");
  return r.idosoId;
}

async function prescreverOk(
  ator: AtorWeb,
  idosoId: string,
  horarios: string[],
  extra: Partial<ConteudoDePrescricao> = {},
  nomeMed?: string,
) {
  n += 1;
  const m = await cadastrarMedicamento(servico(), ator, {
    nomeComercial: nomeMed ?? `Remedio Escala ${n}`,
    principioAtivo: `SubstanciaEsc${n}x`,
    concentracao: "50 mg",
    forma: "comprimido",
  });
  if (!m.ok) throw new Error("med");
  const r = await prescrever(servico(), ator, {
    idosoId,
    medicamentoId: m.medicamentoId,
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: "2026-03-10",
    fim: "2026-03-10",
    altoRisco: false,
    horarios: horarios.map((hora) => ({ hora })),
    ...extra,
  });
  if (!r.ok) throw new Error(`prescrever: ${r.motivo}`);
  return r.prescricaoId;
}

async function escala(ator: AtorWeb | AtorTablet = enf, p = {}) {
  const r = await escalaDoPlantao(servico(), ator, p);
  if (!r.ok) throw new Error("escala");
  return r.escala;
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  agora = T("2026-03-10T10:00:00Z");
  casaA = await criarCasa(migrador, "Casa A Escala");
  casaB = await criarCasa(migrador, "Casa B Escala");
  enf = await criarAtorWeb(servico, migrador, casaA, "enfermeiro");
  cuidador = await criarAtorTablet(servico, migrador, casaA);
  enfB = await criarAtorWeb(servico, migrador, casaB, "enfermeiro");
  // 07:00 em São Paulo: as prescrições nascem aqui e geram suas doses do dia.
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("escala do plantão", () => {
  it("ordena por urgência e mostra o estado de cada dose", async () => {
    const idoso = await novoIdoso(enf, { nome: "Maria Ordem", quarto: "12" });
    await prescreverOk(enf, idoso, ["09:30", "11:00", "12:10", "14:00"]);
    await gerarDosesDaCasa(servico(), casaA);

    agora = T("2026-03-10T15:00:00Z"); // 12:00 local
    const e = await escala(cuidador);
    const minhas = e.doses.filter((d) => d.idosoId === idoso);
    expect(minhas.map((d) => [d.horaLocal, d.estado])).toEqual([
      ["09:30", "sem_registro"],
      ["11:00", "atrasada"],
      ["12:10", "em_janela"],
      ["14:00", "a_fazer"],
    ]);
    expect(minhas[0]?.minutosDesdeOHorario).toBe(150);
    expect(minhas[3]?.minutosDesdeOHorario).toBe(-120);
    expect(e.fuso).toBe("America/Sao_Paulo");
    expect(e.janela).toEqual({ janelaMin: 30, limiteMaiorMin: 120 });
    expect(minhas[0]).toMatchObject({ idosoNome: "Maria Ordem", quarto: "12", altoRisco: false });
    expect(minhas[0]?.medicamento.concentracao).toBe("50 mg");
  });

  it("alergias vêm com as graves primeiro e sem as desativadas", async () => {
    agora = T("2026-03-10T10:00:00Z");
    const idoso = await novoIdoso(enf, {
      alergias: [
        { substancia: "Dipirona", gravidade: "leve" },
        { substancia: "Penicilina", gravidade: "grave" },
        { substancia: "Látex", gravidade: "moderada" },
      ],
    });
    const info = await comContexto(
      app,
      { casaId: casaA },
      async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM alergia WHERE idoso_id = $1 AND substancia = 'Dipirona'",
            [idoso],
          )
        ).rows,
    );
    expect(
      (await desativarAlergia(servico(), enf, { idosoId: idoso, alergiaId: info[0]?.id ?? "" })).ok,
    ).toBe(true);
    await adicionarAlergia(servico(), enf, {
      idosoId: idoso,
      substancia: "Iodo",
      gravidade: "grave",
    });
    await prescreverOk(enf, idoso, ["13:00"]);
    await gerarDosesDaCasa(servico(), casaA);
    agora = T("2026-03-10T15:00:00Z");
    const dose = (await escala()).doses.find((d) => d.idosoId === idoso);
    expect(dose?.alergias.map((a) => `${a.gravidade}:${a.substancia}`)).toEqual([
      "grave:Iodo",
      "grave:Penicilina",
      "moderada:Látex",
    ]);
  });

  it("não mostra dose cancelada, de prescrição encerrada, nem de idoso internado", async () => {
    agora = T("2026-03-10T10:00:00Z");
    const a = await novoIdoso(enf);
    const b = await novoIdoso(enf);
    const pa = await prescreverOk(enf, a, ["16:00"]);
    // 09:30 já passou quando b for internado (12:00): essa dose não é cancelada, mas não pode
    // continuar aparecendo como "sem registro" para quem está no hospital.
    await prescreverOk(enf, b, ["09:30", "16:30"]);
    await gerarDosesDaCasa(servico(), casaA);
    agora = T("2026-03-10T15:00:00Z");
    let e = await escala();
    expect(e.doses.some((d) => d.idosoId === a)).toBe(true);
    expect(e.doses.some((d) => d.idosoId === b)).toBe(true);
    expect(e.doses.find((d) => d.idosoId === b && d.horaLocal === "09:30")?.estado).toBe(
      "sem_registro",
    );

    expect(
      (await encerrarPrescricao(servico(), enf, { prescricaoId: pa, motivo: "Suspensa" })).ok,
    ).toBe(true);
    expect(
      (await mudarStatusDoIdoso(servico(), enf, { idosoId: b, status: "hospitalizado" })).ok,
    ).toBe(true);
    e = await escala();
    expect(e.doses.some((d) => d.idosoId === a)).toBe(false);
    expect(e.doses.some((d) => d.idosoId === b)).toBe(false);
  });

  it("isola as casas: a escala de uma nunca traz dose da outra", async () => {
    agora = T("2026-03-10T10:00:00Z");
    const idosoB = await novoIdoso(enfB, { nome: "Residente Da Casa B Secreto" });
    await prescreverOk(enfB, idosoB, ["15:00"], {}, "MedicamentoSecretoB");
    await gerarDosesDaCasa(servico(), casaB);
    agora = T("2026-03-10T15:00:00Z");
    const daB = await escala(enfB);
    expect(daB.doses.some((d) => d.idosoId === idosoB)).toBe(true);
    const daA = JSON.stringify(await escala(enf));
    expect(daA).not.toContain("Secreto");
    expect(daA).not.toContain(idosoB);
  });

  it("respeita o período pedido e recusa período inválido", async () => {
    agora = T("2026-03-10T15:00:00Z");
    const recorte = await escala(enf, {
      de: T("2026-03-10T17:00:00Z"), // 14:00 local
      ate: T("2026-03-10T17:30:00Z"),
    });
    expect(recorte.doses.every((d) => d.horaLocal === "14:00")).toBe(true);
    for (const p of [
      { de: T("2026-03-10T17:00:00Z"), ate: T("2026-03-10T17:00:00Z") },
      { de: T("2026-03-10T17:00:00Z"), ate: T("2026-03-10T16:00:00Z") },
      { de: T("2026-03-08T00:00:00Z"), ate: T("2026-03-11T00:00:00Z") },
      { de: new Date("lixo"), ate: T("2026-03-11T00:00:00Z") },
    ]) {
      expect(await escalaDoPlantao(servico(), enf, p)).toMatchObject({
        ok: false,
        motivo: "dados_invalidos",
      });
    }
  });

  it("a janela de tolerância vem da configuração da casa", async () => {
    const casa = await criarCasa(migrador, "Casa Janela Larga");
    await comContexto(migrador, { casaId: casa }, (c) =>
      c.query(
        `UPDATE casa SET configuracoes = '{"janelaMinutos": 60, "limiteMaiorMinutos": 180}'::jsonb WHERE id = $1`,
        [casa],
      ),
    );
    const ator = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
    agora = T("2026-03-10T10:00:00Z");
    const idoso = await novoIdoso(ator);
    await prescreverOk(ator, idoso, ["11:00"]);
    await gerarDosesDaCasa(servico(), casa);
    agora = T("2026-03-10T15:00:00Z"); // 60 min depois
    const e = await escala(ator);
    expect(e.janela).toEqual({ janelaMin: 60, limiteMaiorMin: 180 });
    expect(e.doses.find((d) => d.idosoId === idoso)?.estado).toBe("em_janela");
  });
});

describe("folha de contingência", () => {
  it("ordena por horário e quarto (numérico), registra a emissão sem dados pessoais e gera PDF", async () => {
    const casa = await criarCasa(migrador, "Casa da Folha");
    const ator = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
    agora = T("2026-03-10T10:00:00Z");
    const q10 = await novoIdoso(ator, { nome: "Residente Dez", quarto: "10" });
    const q2 = await novoIdoso(ator, { nome: "Residente Dois", quarto: "2" });
    await prescreverOk(ator, q10, ["21:00"], { altoRisco: true });
    await prescreverOk(ator, q2, ["21:00", "22:00"]);
    await gerarDosesDaCasa(servico(), casa);

    agora = T("2026-03-10T15:20:00Z");
    const r = await dadosDaFolhaDeContingencia(servico(), ator, { ip: "10.0.0.1" });
    if (!r.ok) throw new Error("folha");
    expect(r.folha.doses.map((d) => `${d.horaLocal} ${d.quarto}`)).toEqual([
      "21:00 2",
      "21:00 10",
      "22:00 2",
    ]);
    // Período padrão: do início da hora atual (12:00 local) até 12 horas à frente.
    expect(r.folha.de).toBe("2026-03-10T15:00:00.000Z");
    expect(r.folha.ate).toBe("2026-03-11T03:20:00.000Z");

    const trilha = await comContexto(
      app,
      { casaId: casa },
      async (c) =>
        (
          await c.query<{ depois: Record<string, unknown>; entidade_id: string; ip: string }>(
            "SELECT depois, entidade_id, ip FROM auditoria WHERE acao = 'escala.folha_emitida'",
          )
        ).rows,
    );
    expect(trilha).toHaveLength(1);
    expect(trilha[0]?.depois).toMatchObject({ doses: 3, truncada: false });
    const bruto = JSON.stringify(trilha);
    expect(bruto).not.toContain("Residente");

    const pdf = await gerarPdfDaFolha(r.folha);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    const pasta = mkdtempSync(join(tmpdir(), "folha-"));
    const arquivo = join(pasta, "folha.pdf");
    writeFileSync(arquivo, pdf);
    const textoDoPdf = execFileSync("pdftotext", ["-layout", arquivo, "-"], { encoding: "utf8" });
    expect(textoDoPdf).toContain("Folha de contingência - Casa da Folha");
    expect(textoDoPdf).toContain("Residente Dois");
    expect(textoDoPdf).toContain("ALTO RISCO");
    expect(textoDoPdf).toContain("Página 1 de 1");
    // O "alto risco" aparece uma única vez: só a linha do residente do quarto 10 o tem.
    expect(textoDoPdf.match(/ALTO RISCO/g)).toHaveLength(1);
  });

  it("pagina quando há muitas doses e cobra rubrica em todas as linhas", async () => {
    const doses = Array.from({ length: 41 }, (_, i) => ({
      id: `d${i}`,
      idosoId: `i${i}`,
      idosoNome: `Residente ${String(i).padStart(2, "0")}`,
      quarto: String(i + 1),
      alergias:
        i === 0
          ? [
              { substancia: "A", gravidade: "grave" as const },
              { substancia: "B", gravidade: "grave" as const },
              { substancia: "C", gravidade: "grave" as const },
              { substancia: "D", gravidade: "leve" as const },
            ]
          : [],
      medicamento: {
        nome: "Remédio com nome bem comprido para testar o ajuste de largura",
        principioAtivo: "x",
        concentracao: "10 mg",
      },
      dose: 1.5,
      unidade: "comprimido",
      via: "oral",
      instrucoes: "Tomar com água",
      altoRisco: false,
      dataLocal: "2026-03-10",
      horaLocal: "08:00",
      previstaEm: "2026-03-10T11:00:00.000Z",
      estado: "a_fazer" as const,
      minutosDesdeOHorario: -10,
      adiadaPara: null,
      registro: null,
    }));
    const pdf = await gerarPdfDaFolha({
      casaNome: "Casa Longa",
      emitidaEm: "2026-03-10T10:00:00.000Z",
      fuso: "America/Sao_Paulo",
      de: "2026-03-10T10:00:00.000Z",
      ate: "2026-03-10T22:00:00.000Z",
      truncada: true,
      doses,
    });
    const doc = await PDFDocument.load(pdf);
    // 11 linhas cabem por página em A4 paisagem: 41 doses ocupam 4 páginas.
    expect(doc.getPageCount()).toBe(4);
    const pasta = mkdtempSync(join(tmpdir(), "folha-"));
    const arquivo = join(pasta, "longa.pdf");
    writeFileSync(arquivo, pdf);
    const t = execFileSync("pdftotext", ["-layout", arquivo, "-"], { encoding: "utf8" });
    expect(t).toContain("Residente 40");
    expect(t).toContain("+2: ver cadastro");
    expect(t).toContain("ATENÇÃO: havia mais doses");
    expect(t).toContain(`Página ${doc.getPageCount()} de ${doc.getPageCount()}`);
  });

  it("folha vazia explica que não há doses", async () => {
    const pdf = await gerarPdfDaFolha({
      casaNome: "Casa Vazia",
      emitidaEm: "2026-03-10T10:00:00.000Z",
      fuso: "America/Sao_Paulo",
      de: "2026-03-10T10:00:00.000Z",
      ate: "2026-03-10T22:00:00.000Z",
      truncada: false,
      doses: [],
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("recusa período inválido e não registra emissão", async () => {
    agora = T("2026-03-10T15:00:00Z");
    const r = await dadosDaFolhaDeContingencia(servico(), enf, {
      de: T("2026-03-01T00:00:00Z"),
      ate: T("2026-03-10T00:00:00Z"),
    });
    expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
  });
});
