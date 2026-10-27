import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registrarDose } from "@/modules/administracao";
import { ErroDePermissao, ErroDeReautenticacao, type Servico } from "@/modules/identidade";
import { cadastrarIdoso } from "@/modules/idosos";
import {
  consultarAuditoria,
  csvDaAuditoria,
  csvDeExcecoes,
  exportarAuditoria,
  exportarDadosDoIdoso,
  pdfDaAuditoria,
  pdfDeExcecoes,
  relatorioDeExcecoes,
  verificarAuditoria,
} from "@/modules/relatorios";
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
import { criarAtorTablet, criarAtorWeb, type AtorTablet, type AtorWeb } from "../ajudantes/sessoes";

// Gestão (M7): consulta e exportação da trilha, relatório de exceções e exportação LGPD do
// residente, contra o PostgreSQL real.

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const PREVISTA = new Date("2026-03-10T11:00:00Z");

let app: pg.Pool;
let migrador: pg.Pool;
let casa: string;
let outraCasa: string;
let agora: Date;
let gestor: AtorWeb; // com a senha confirmada
let gestorSemSenha: AtorWeb;
let enf: AtorWeb;
let cuidador: AtorTablet;
let gestorB: AtorWeb;
let idosoId: string;
let idosoDaB: string;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });

beforeAll(async () => {
  app = criarPoolApp(10);
  migrador = criarPoolMigrador();
  agora = new Date(PREVISTA.getTime() - 3_600_000);
  casa = await criarCasa(migrador, "Casa da gestão");
  outraCasa = await criarCasa(migrador, "Outra casa da gestão");
  enf = await criarAtorWeb(servico, migrador, casa, "enfermeiro");
  cuidador = await criarAtorTablet(servico, migrador, casa);

  // Residente com CPF, alergia e contato; remédio com lote; dose com exceção de conferência.
  const r = await cadastrarIdoso(servico(), enf, {
    nome: "Residente da Gestão",
    dataNascimento: "1938-01-01",
    cpf: "529.982.247-25",
    quarto: "7",
    alergias: [{ substancia: "Dipirona", gravidade: "grave" }],
    contatos: [
      {
        nome: "Filha Marta",
        parentesco: "filha",
        telefone: "(11) 98765-4321",
        responsavelLegal: true,
      },
    ],
  });
  if (!r.ok) throw new Error("idoso");
  idosoId = r.idosoId;
  const med = await medicamento(servico(), enf, { nome: "Remedio da Gestao" });
  const l = await lote(servico(), app, enf, med, 10);
  const { doseId } = await prescreverComDose(servico(), enf, idosoId, med);
  const liberadora = await pessoaComPin(migrador, casa, "enfermeiro", "Liberadora Lia");
  agora = PREVISTA;
  const reg = await registrarDose(servico(), cuidador, {
    chave: nova(),
    doseId,
    resultado: "administrada",
    pulseira: `ILPI:I:${await codigoDaPulseira(idosoId)}`,
    excecao: {
      loteId: l.id,
      motivo: "etiqueta_ilegivel",
      justificativa: "Etiqueta molhada, conferi lote e validade na caixa",
      liberador: { usuarioId: liberadora.id, pin: PIN },
    },
  });
  if (!reg.ok) throw new Error(`registro: ${JSON.stringify(reg)}`);

  // A outra casa também tem uma exceção, com nomes que não podem aparecer do lado de cá.
  agora = new Date(PREVISTA.getTime() - 3_600_000);
  const enfB = await criarAtorWeb(servico, migrador, outraCasa, "enfermeiro");
  const cuidadorB = await criarAtorTablet(servico, migrador, outraCasa);
  const idosoB = await idosoComPulseira(servico(), enfB, "SEGREDO-DA-B Residente");
  idosoDaB = idosoB.id;
  const medB = await medicamento(servico(), enfB, { nome: "SEGREDO-DA-B Remedio" });
  const loteB = await lote(servico(), app, enfB, medB, 10);
  const doseB = await prescreverComDose(servico(), enfB, idosoB.id, medB);
  const liberadoraB = await pessoaComPin(
    migrador,
    outraCasa,
    "enfermeiro",
    "SEGREDO-DA-B Liberadora",
  );
  agora = PREVISTA;
  const regB = await registrarDose(servico(), cuidadorB, {
    chave: nova(),
    doseId: doseB.doseId,
    resultado: "administrada",
    pulseira: idosoB.pulseira,
    excecao: {
      loteId: loteB.id,
      motivo: "etiqueta_danificada",
      justificativa: "SEGREDO-DA-B justificativa da exceção",
      liberador: { usuarioId: liberadoraB.id, pin: PIN },
    },
  });
  if (!regB.ok) throw new Error(`registro B: ${JSON.stringify(regB)}`);

  // A confirmação de senha carimba o relógio do serviço: os gestores nascem já com o relógio
  // real, e é nele que os testes de gestão seguem.
  agora = new Date();
  gestor = await criarAtorWeb(servico, migrador, casa, "gestor", { reautenticado: true });
  gestorSemSenha = await criarAtorWeb(servico, migrador, casa, "gestor");
  gestorB = await criarAtorWeb(servico, migrador, outraCasa, "gestor", { reautenticado: true });
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

async function codigoDaPulseira(id: string): Promise<string> {
  const r = await linhas<{ codigo_pulseira: string }>(
    app,
    casa,
    "SELECT codigo_pulseira FROM idoso WHERE id = $1",
    [id],
  );
  return r[0]?.codigo_pulseira ?? "";
}

describe("consulta da trilha de auditoria", () => {
  it("o gestor vê a trilha da própria casa, do mais novo para o mais antigo", async () => {
    const r = await consultarAuditoria(servico(), gestor);
    if (!r.ok) throw new Error("consulta");
    expect(r.registros.length).toBeGreaterThan(5);
    const seqs = r.registros.map((x) => x.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(r.registros.some((x) => x.acao === "administracao.registrada")).toBe(true);
    expect(r.registros.some((x) => x.usuarioNome !== null)).toBe(true);
  });

  it("filtra por prefixo da ação, objeto e identificador", async () => {
    const porAcao = await consultarAuditoria(servico(), gestor, { acao: "administracao." });
    expect(porAcao.ok && porAcao.registros.length > 0).toBe(true);
    expect(porAcao.ok && porAcao.registros.every((x) => x.acao.startsWith("administracao."))).toBe(
      true,
    );
    const porObjeto = await consultarAuditoria(servico(), gestor, {
      entidade: "idoso",
      entidadeId: idosoId,
    });
    expect(porObjeto.ok && porObjeto.registros.length > 0).toBe(true);
    expect(porObjeto.ok && porObjeto.registros.every((x) => x.entidadeId === idosoId)).toBe(true);
    // O "_" do LIKE não pode virar coringa.
    const coringa = await consultarAuditoria(servico(), gestor, { acao: "administracao_" });
    expect(coringa.ok && coringa.registros).toEqual([]);
  });

  it("filtra por período no fuso da casa (fim inclusivo) e por pessoa", async () => {
    const dentro = await consultarAuditoria(servico(), gestor, {
      de: "2026-03-10",
      ate: "2026-03-10",
    });
    // O relógio dos testes de banco usa o relógio real para a trilha: a trilha grava
    // clock_timestamp(), então o período de 2026 não pega nada e o de hoje pega tudo.
    expect(dentro.ok && dentro.registros).toEqual([]);
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
      new Date(),
    );
    const todos = await consultarAuditoria(servico(), gestor, { de: hoje, ate: hoje });
    expect(todos.ok && todos.registros.length > 0).toBe(true);
    const daEnfermeira = await consultarAuditoria(servico(), gestor, { usuarioId: enf.usuarioId });
    expect(daEnfermeira.ok && daEnfermeira.registros.length > 0).toBe(true);
    expect(
      daEnfermeira.ok && daEnfermeira.registros.every((x) => x.usuarioId === enf.usuarioId),
    ).toBe(true);
  });

  it("pagina sem repetir nem pular", async () => {
    const p1 = await consultarAuditoria(servico(), gestor, { limite: 3 });
    if (!p1.ok) throw new Error("p1");
    expect(p1.registros).toHaveLength(3);
    expect(p1.proximaPagina).not.toBeNull();
    const p2 = await consultarAuditoria(servico(), gestor, {
      limite: 3,
      antesDeSeq: p1.proximaPagina ?? 0,
    });
    if (!p2.ok) throw new Error("p2");
    const todos = await consultarAuditoria(servico(), gestor, { limite: 6 });
    expect([...p1.registros, ...p2.registros].map((x) => x.seq)).toEqual(
      todos.ok ? todos.registros.map((x) => x.seq) : [],
    );
  });

  it("recusa filtros malformados", async () => {
    for (const filtro of [
      { de: "2026-03-10" }, // só uma ponta
      { de: "2026-13-40", ate: "2026-13-41" },
      { de: "2026-03-10", ate: "2026-03-01" },
      { usuarioId: "nao-e-uuid" },
      { acao: "ação com espaço; DROP TABLE" },
      { entidade: "Idoso'--" },
    ]) {
      const r = await consultarAuditoria(servico(), gestor, filtro);
      expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    }
  });

  it("só o gestor consulta; enfermeiro e cuidador não", async () => {
    await expect(consultarAuditoria(servico(), enf)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(consultarAuditoria(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    await expect(verificarAuditoria(servico(), enf)).rejects.toBeInstanceOf(ErroDePermissao);
  });

  it("a trilha de outra casa não aparece", async () => {
    const r = await consultarAuditoria(servico(), gestorB, { limite: 200 });
    if (!r.ok) throw new Error("consulta");
    // A casa B tem a sua própria trilha (não está vazia), mas só ela.
    expect(r.registros.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.registros)).not.toContain(idosoId);
    const doutra = await consultarAuditoria(servico(), gestorB, {
      entidade: "idoso",
      entidadeId: idosoId,
    });
    expect(doutra.ok && doutra.registros).toEqual([]);
  });

  it("a verificação da cadeia dá íntegra", async () => {
    const v = await verificarAuditoria(servico(), gestor);
    expect(v).toMatchObject({ integra: true, problema: null });
  });
});

describe("exportação da trilha", () => {
  it("pede a senha de novo", async () => {
    await expect(
      exportarAuditoria(servico(), gestorSemSenha, { formato: "csv" }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
  });

  it("só o gestor exporta", async () => {
    await expect(exportarAuditoria(servico(), enf, { formato: "pdf" })).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
  });

  it("gera planilha e PDF, e deixa rastro sem o conteúdo", async () => {
    const r = await exportarAuditoria(servico(), gestor, {
      formato: "csv",
      filtro: { acao: "administracao." },
      ip: "203.0.113.9",
    });
    if (!r.ok) throw new Error("exportar");
    const csv = csvDaAuditoria(r.exportacao);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\r\n")[0]).toContain("Data e hora;Pessoa;Ação");
    expect(csv).toContain("administracao.registrada");
    const pdf = await pdfDaAuditoria(r.exportacao);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");

    const rastro = await linhas<{ depois: Record<string, unknown>; ip: string }>(
      app,
      casa,
      "SELECT depois, ip FROM auditoria WHERE acao = 'auditoria.exportada' ORDER BY seq DESC LIMIT 1",
    );
    expect(rastro[0]?.depois).toMatchObject({
      formato: "csv",
      linhas: r.exportacao.registros.length,
    });
    expect(rastro[0]?.ip).toBe("203.0.113.9");
    expect(JSON.stringify(rastro[0]?.depois)).not.toContain("Etiqueta molhada");
  });

  it("recusa filtro inválido sem exportar nada", async () => {
    const antes = await linhas<{ n: string }>(
      app,
      casa,
      "SELECT count(*) AS n FROM auditoria WHERE acao = 'auditoria.exportada'",
    );
    const r = await exportarAuditoria(servico(), gestor, {
      formato: "pdf",
      filtro: { de: "ontem", ate: "hoje" },
    });
    expect(r).toMatchObject({ ok: false, motivo: "dados_invalidos" });
    const depois = await linhas<{ n: string }>(
      app,
      casa,
      "SELECT count(*) AS n FROM auditoria WHERE acao = 'auditoria.exportada'",
    );
    expect(depois[0]?.n).toBe(antes[0]?.n);
  });
});

describe("relatório de exceções de conferência", () => {
  it("lista a exceção com quem registrou e quem liberou, e conta por motivo e pessoa", async () => {
    const r = await relatorioDeExcecoes(servico(), gestor, { de: "2026-03-01", ate: "2026-03-31" });
    if (!r.ok) throw new Error("relatório");
    expect(r.relatorio.total).toBe(1);
    expect(r.relatorio.totalDeRegistros).toBe(1);
    expect(r.relatorio.porMotivo).toEqual([{ motivo: "etiqueta_ilegivel", quantidade: 1 }]);
    expect(r.relatorio.porLiberador).toEqual([{ nome: "Liberadora Lia", quantidade: 1 }]);
    expect(r.relatorio.itens[0]).toMatchObject({
      idosoNome: "Residente da Gestão",
      medicamento: "Remedio da Gestao",
      liberadoPor: "Liberadora Lia",
      justificativa: "Etiqueta molhada, conferi lote e validade na caixa",
    });
  });

  it("fora do período não aparece; período ruim é recusado", async () => {
    const vazio = await relatorioDeExcecoes(servico(), gestor, {
      de: "2026-04-01",
      ate: "2026-04-30",
    });
    expect(vazio.ok && vazio.relatorio.total).toBe(0);
    expect(
      await relatorioDeExcecoes(servico(), gestor, { de: "2026-04-30", ate: "2026-04-01" }),
    ).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
    expect(
      await relatorioDeExcecoes(servico(), gestor, { de: "2020-01-01", ate: "2026-04-01" }),
    ).toMatchObject({
      ok: false,
      motivo: "dados_invalidos",
    });
  });

  it("só o gestor vê; cada casa vê só as exceções dela", async () => {
    await expect(relatorioDeExcecoes(servico(), enf)).rejects.toBeInstanceOf(ErroDePermissao);
    const periodo = { de: "2026-03-01", ate: "2026-03-31" };
    const a = await relatorioDeExcecoes(servico(), gestor, periodo);
    const b = await relatorioDeExcecoes(servico(), gestorB, periodo);
    if (!a.ok || !b.ok) throw new Error("relatório");
    expect(b.relatorio.total).toBe(1);
    expect(JSON.stringify(b.relatorio)).toContain("SEGREDO-DA-B Liberadora");
    expect(JSON.stringify(a.relatorio)).not.toContain("SEGREDO-DA-B");
    expect(csvDeExcecoes(a.relatorio)).not.toContain("SEGREDO-DA-B");
  });

  it("exportar pede a senha, gera os dois formatos e deixa rastro", async () => {
    await expect(
      relatorioDeExcecoes(servico(), gestorSemSenha, {
        de: "2026-03-01",
        ate: "2026-03-31",
        exportacao: { formato: "csv" },
      }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    const r = await relatorioDeExcecoes(servico(), gestor, {
      de: "2026-03-01",
      ate: "2026-03-31",
      exportacao: { formato: "pdf" },
    });
    if (!r.ok) throw new Error("exportar");
    expect(csvDeExcecoes(r.relatorio)).toContain("Liberadora Lia");
    expect(
      Buffer.from(await pdfDeExcecoes(r.relatorio))
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    const rastro = await linhas<{ n: string }>(
      app,
      casa,
      "SELECT count(*) AS n FROM auditoria WHERE acao = 'relatorio.excecoes_exportado'",
    );
    expect(rastro[0]?.n).toBe("1");
  });
});

describe("exportação dos dados do residente (LGPD)", () => {
  it("traz o cadastro com CPF e telefone por extenso, prescrições, administrações e alterações", async () => {
    const r = await exportarDadosDoIdoso(servico(), gestor, { idosoId, ip: "203.0.113.7" });
    if (!r.ok) throw new Error("exportação");
    const e = r.exportacao;
    expect(e.residente).toMatchObject({
      nome: "Residente da Gestão",
      cpf: "52998224725",
      quarto: "7",
      situacao: "ativo",
    });
    expect(e.alergias).toMatchObject([{ substancia: "Dipirona", gravidade: "grave", ativa: true }]);
    expect(e.contatosDeEmergencia).toMatchObject([{ nome: "Filha Marta", responsavelLegal: true }]);
    expect(e.contatosDeEmergencia[0]?.telefone).toMatch(/98765.?4321/);
    expect(e.prescricoes).toHaveLength(1);
    expect(e.prescricoes[0]).toMatchObject({
      medicamento: "Remedio da Gestao",
      horarios: ["08:00"],
    });
    expect(e.administracoes).toHaveLength(1);
    expect(e.administracoes[0]).toMatchObject({
      resultado: "administrada",
      metodo: "excecao",
      excecaoDeConferencia: { liberadaPor: "Liberadora Lia" },
    });
    expect(e.alteracoesDoCadastro.length).toBeGreaterThan(0);
  });

  it("não leva credencial, caminho de foto, IP nem outro residente", async () => {
    const r = await exportarDadosDoIdoso(servico(), gestor, { idosoId });
    if (!r.ok) throw new Error("exportação");
    const texto = JSON.stringify(r.exportacao);
    expect(texto).not.toContain(await codigoDaPulseira(idosoId));
    expect(texto).not.toMatch(/codigo_pulseira|codigoPulseira|foto|senha|pin_hash|totp|hash/i);
    expect(texto).not.toContain("203.0.113");
    expect(texto).not.toContain(idosoDaB);
  });

  it("deixa rastro só com contagens, sem CPF nem telefone", async () => {
    const rastro = await linhas<{ depois: Record<string, unknown>; ip: string | null }>(
      app,
      casa,
      "SELECT depois, ip FROM auditoria WHERE acao = 'idoso.dados_exportados' ORDER BY seq LIMIT 1",
    );
    expect(rastro[0]?.depois).toEqual({
      alergias: 1,
      contatos: 1,
      prescricoes: 1,
      administracoes: 1,
    });
    expect(rastro[0]?.ip).toBe("203.0.113.7");
  });

  it("pede a senha de novo e só o gestor exporta", async () => {
    await expect(
      exportarDadosDoIdoso(servico(), gestorSemSenha, { idosoId }),
    ).rejects.toBeInstanceOf(ErroDeReautenticacao);
    await expect(exportarDadosDoIdoso(servico(), enf, { idosoId })).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
  });

  it("residente de outra casa ou inexistente não existe", async () => {
    expect(await exportarDadosDoIdoso(servico(), gestor, { idosoId: idosoDaB })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(await exportarDadosDoIdoso(servico(), gestor, { idosoId: nova() })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
  });
});
