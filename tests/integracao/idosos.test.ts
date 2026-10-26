import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto } from "@/compartilhado/banco/transacao";
import { codigoLegivel, montarPayloadQr } from "@/compartilhado/qr";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import { ErroDePermissao, type Servico } from "@/modules/identidade";
import {
  adicionarAlergia,
  adicionarContato,
  cadastrarIdoso,
  desativarAlergia,
  desativarContato,
  editarIdoso,
  emitirPulseira,
  listarIdosos,
  localizarPorPulseira,
  mudarStatusDoIdoso,
  obterIdoso,
  regenerarPulseira,
  revelarDadosSensiveis,
} from "@/modules/idosos";
import { criarPoolApp, criarPoolMigrador } from "../ajudantes/banco";
import { criarCasa } from "../ajudantes/dados";
import { criarAtorTablet, criarAtorWeb } from "../ajudantes/sessoes";

const CHAVE = process.env.CHAVE_CAMPOS ?? "";
const CPF = "529.982.247-25";

let app: pg.Pool;
let migrador: pg.Pool;
let casaA: string;
let casaB: string;
let agora: Date;

const servico = (): Servico => ({ pool: app, chaveCampos: CHAVE, agora: () => agora });

const novoIdoso = (nome = "Dona Maria da Silva") => ({
  nome,
  dataNascimento: "1938-05-20",
  cpf: CPF,
  quarto: "12B",
  alergias: [
    { substancia: "Dipirona", gravidade: "grave" as const },
    { substancia: "Penicilina", gravidade: "moderada" as const, observacao: "urticária" },
    { substancia: "Látex", gravidade: "leve" as const },
  ],
  contatos: [
    {
      nome: "João da Silva",
      parentesco: "Filho",
      telefone: "(11) 91234-5678",
      responsavelLegal: true,
    },
  ],
});

async function enfermeiraA() {
  return criarAtorWeb(servico, migrador, casaA, "enfermeiro");
}

async function cadastrar(nome?: string) {
  const ator = await enfermeiraA();
  const r = await cadastrarIdoso(servico(), ator, novoIdoso(nome));
  if (!r.ok) throw new Error(`cadastro falhou: ${r.problemas?.join(", ")}`);
  return { ator, ...r };
}

async function sql<T extends pg.QueryResultRow>(
  casaId: string,
  texto: string,
  valores: unknown[] = [],
) {
  return comContexto(app, { casaId }, async (c) => (await c.query<T>(texto, valores)).rows);
}

beforeAll(async () => {
  app = criarPoolApp(6);
  migrador = criarPoolMigrador();
  casaA = await criarCasa(migrador, "Casa A dos Idosos");
  casaB = await criarCasa(migrador, "Casa B dos Idosos");
  agora = new Date("2026-03-10T12:00:00Z");
});

afterAll(async () => {
  await app.end();
  await migrador.end();
});

describe("cadastro", () => {
  it("cadastra o idoso com alergias e contatos e gera a pulseira", async () => {
    const { ator, idosoId, codigoPulseira } = await cadastrar();
    expect(codigoPulseira).toMatch(/^[A-HJKMNP-Z2-9]{20}$/);

    const r = await obterIdoso(servico(), ator, idosoId);
    if (!r.ok) throw new Error("deveria encontrar");
    expect(r.idoso).toMatchObject({
      nome: "Dona Maria da Silva",
      dataNascimento: "1938-05-20",
      quarto: "12B",
      status: "ativo",
      temCpf: true,
      cpf: "***.***.***-25",
    });
    // Alergias da mais grave para a mais leve.
    expect(r.idoso.alergias.map((a) => a.gravidade)).toEqual(["grave", "moderada", "leve"]);
    expect(r.idoso.contatos).toEqual([
      expect.objectContaining({
        nome: "João da Silva",
        telefone: "(11) *****-5678",
        responsavelLegal: true,
      }),
    ]);
  });

  it("recusa dados inválidos sem gravar nada", async () => {
    const ator = await enfermeiraA();
    const antes = (await sql(casaA, "SELECT 1 FROM idoso")).length;
    const r = await cadastrarIdoso(servico(), ator, {
      ...novoIdoso(),
      cpf: "111.111.111-11",
      alergias: [{ substancia: "X", gravidade: "grave" }],
      contatos: [{ nome: "Z", parentesco: "", telefone: "1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.problemas ?? []).length).toBeGreaterThanOrEqual(4);
    expect((await sql(casaA, "SELECT 1 FROM idoso")).length).toBe(antes);
  });

  it("é tudo ou nada: se algo falha no meio, não sobra idoso pela metade", async () => {
    const ator = await enfermeiraA();
    const antes = (await sql(casaA, "SELECT 1 FROM idoso")).length;
    // Texto acima do limite do banco passa na validação da aplicação? Não: simulamos o erro do banco.
    await expect(
      cadastrarIdoso(servico(), ator, {
        ...novoIdoso(),
        alergias: [{ substancia: "Dipirona\u0000", gravidade: "grave" }],
      }),
    ).rejects.toThrow();
    expect((await sql(casaA, "SELECT 1 FROM idoso")).length).toBe(antes);
  });

  it("CPF e telefone ficam cifrados no banco, nunca em texto", async () => {
    const { idosoId } = await cadastrar();
    const [idoso] = await sql<{ cpf_cifrado: string }>(
      casaA,
      "SELECT cpf_cifrado FROM idoso WHERE id = $1",
      [idosoId],
    );
    expect(idoso?.cpf_cifrado).toMatch(/^v1:/);
    expect(idoso?.cpf_cifrado).not.toContain("52998224725");
    const [contato] = await sql<{ telefone_cifrado: string }>(
      casaA,
      "SELECT telefone_cifrado FROM contato_emergencia WHERE idoso_id = $1",
      [idosoId],
    );
    expect(contato?.telefone_cifrado).toMatch(/^v1:/);
    expect(contato?.telefone_cifrado).not.toContain("912345678");
  });

  it("só enfermeiro e gestor cadastram; cuidador no tablet não", async () => {
    const cuidador = await criarAtorTablet(servico, migrador, casaA);
    await expect(cadastrarIdoso(servico(), cuidador, novoIdoso())).rejects.toBeInstanceOf(
      ErroDePermissao,
    );
    await expect(listarIdosos(servico(), cuidador)).rejects.toBeInstanceOf(ErroDePermissao);
    const gestor = await criarAtorWeb(servico, migrador, casaA, "gestor");
    expect((await cadastrarIdoso(servico(), gestor, novoIdoso())).ok).toBe(true);
  });

  it("a trilha de auditoria registra o que aconteceu sem nome, CPF ou telefone", async () => {
    const { ator, idosoId } = await cadastrar("Nome Único Para Auditoria");
    const linhas = await sql<{ acao: string; usuario_id: string }>(
      casaA,
      `SELECT acao, usuario_id FROM auditoria
        WHERE entidade_id = $1 OR depois->>'idosoId' = $1::text ORDER BY seq`,
      [idosoId],
    );
    expect(linhas.map((l) => l.acao)).toEqual(
      expect.arrayContaining(["idoso.cadastrado", "alergia.adicionada", "contato.adicionado"]),
    );
    expect(linhas.every((l) => l.usuario_id === ator.usuarioId)).toBe(true);

    const tudo = JSON.stringify(await sql(casaA, "SELECT to_jsonb(a) AS linha FROM auditoria a"));
    for (const proibido of [
      "Nome Único Para Auditoria",
      "52998224725",
      "529.982",
      "912345678",
      "Dipirona",
      "João da Silva",
    ]) {
      expect(tudo, proibido).not.toContain(proibido);
    }
  });
});

describe("edição e situação", () => {
  it("edita só os campos enviados e audita apenas os nomes dos campos", async () => {
    const { ator, idosoId } = await cadastrar();
    const r = await editarIdoso(servico(), ator, {
      idosoId,
      quarto: "20A",
      nome: "Maria da Silva Santos",
    });
    expect(r).toEqual({ ok: true, camposAlterados: ["nome", "quarto"] });

    const detalhe = await obterIdoso(servico(), ator, idosoId);
    expect(detalhe.ok && detalhe.idoso).toMatchObject({
      nome: "Maria da Silva Santos",
      quarto: "20A",
      dataNascimento: "1938-05-20",
      cpf: "***.***.***-25",
    });
    const [log] = await sql<{ depois: unknown }>(
      casaA,
      "SELECT depois FROM auditoria WHERE acao = 'idoso.editado' AND entidade_id = $1",
      [idosoId],
    );
    expect(log?.depois).toEqual({ campos: ["nome", "quarto"] });
  });

  it("permite remover o CPF e o quarto", async () => {
    const { ator, idosoId } = await cadastrar();
    expect((await editarIdoso(servico(), ator, { idosoId, cpf: null, quarto: null })).ok).toBe(
      true,
    );
    const d = await obterIdoso(servico(), ator, idosoId);
    expect(d.ok && d.idoso).toMatchObject({ temCpf: false, cpf: null, quarto: null });
  });

  it("recusa edição inválida, vazia ou de idoso inexistente", async () => {
    const { ator, idosoId } = await cadastrar();
    expect(await editarIdoso(servico(), ator, { idosoId, cpf: "123" })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(await editarIdoso(servico(), ator, { idosoId })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(await editarIdoso(servico(), ator, { idosoId: gerarUuid(), quarto: "1" })).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
  });

  it("muda a situação, recusa repetir a mesma e guarda antes e depois", async () => {
    const { ator, idosoId } = await cadastrar();
    expect(await mudarStatusDoIdoso(servico(), ator, { idosoId, status: "hospitalizado" })).toEqual(
      { ok: true },
    );
    expect(await mudarStatusDoIdoso(servico(), ator, { idosoId, status: "hospitalizado" })).toEqual(
      {
        ok: false,
        motivo: "sem_mudanca",
      },
    );
    expect(
      await mudarStatusDoIdoso(servico(), ator, { idosoId, status: "voou" as never }),
    ).toMatchObject({
      motivo: "dados_invalidos",
    });
    const [log] = await sql<{ antes: unknown; depois: unknown }>(
      casaA,
      "SELECT antes, depois FROM auditoria WHERE acao = 'idoso.status_alterado' AND entidade_id = $1",
      [idosoId],
    );
    expect(log).toEqual({ antes: { status: "ativo" }, depois: { status: "hospitalizado" } });
  });

  it("a listagem filtra por situação e conta alergias", async () => {
    const { ator, idosoId } = await cadastrar("Listado Hospitalizado");
    await mudarStatusDoIdoso(servico(), ator, { idosoId, status: "hospitalizado" });

    const hospitalizados = await listarIdosos(servico(), ator, { status: "hospitalizado" });
    expect(hospitalizados.map((i) => i.id)).toContain(idosoId);
    expect(hospitalizados.every((i) => i.status === "hospitalizado")).toBe(true);
    expect(hospitalizados.find((i) => i.id === idosoId)).toMatchObject({
      alergiasAtivas: 3,
      alergiasGraves: 1,
    });

    const ativos = await listarIdosos(servico(), ator, { status: "ativo" });
    expect(ativos.map((i) => i.id)).not.toContain(idosoId);
    const todos = await listarIdosos(servico(), ator);
    expect(todos.length).toBeGreaterThanOrEqual(hospitalizados.length + ativos.length);
  });

  it("idoso nunca é apagado: o banco recusa DELETE para a aplicação", async () => {
    const { idosoId } = await cadastrar();
    await expect(sql(casaA, "DELETE FROM idoso WHERE id = $1", [idosoId])).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("alergias e contatos", () => {
  it("adiciona e desativa alergia; a desativada some das telas mas fica no banco", async () => {
    const { ator, idosoId } = await cadastrar();
    const nova = await adicionarAlergia(servico(), ator, {
      idosoId,
      substancia: "Iodo",
      gravidade: "moderada",
    });
    if (!nova.ok) throw new Error("deveria adicionar");

    expect(await desativarAlergia(servico(), ator, { idosoId, alergiaId: nova.alergiaId })).toEqual(
      { ok: true },
    );
    expect(await desativarAlergia(servico(), ator, { idosoId, alergiaId: nova.alergiaId })).toEqual(
      {
        ok: false,
        motivo: "nao_encontrado",
      },
    );
    const d = await obterIdoso(servico(), ator, idosoId);
    expect(d.ok && d.idoso.alergias.map((a) => a.substancia)).not.toContain("Iodo");
    const [linha] = await sql<{ ativa: boolean; desativada_por: string }>(
      casaA,
      "SELECT ativa, desativada_por FROM alergia WHERE id = $1",
      [nova.alergiaId],
    );
    expect(linha).toEqual({ ativa: false, desativada_por: ator.usuarioId });
  });

  it("recusa alergia inválida ou para idoso inexistente, e não desativa alergia de outro idoso", async () => {
    const { ator, idosoId } = await cadastrar();
    const outro = await cadastrar("Outro Idoso");
    expect(
      await adicionarAlergia(servico(), ator, { idosoId, substancia: "", gravidade: "leve" }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    expect(
      await adicionarAlergia(servico(), ator, {
        idosoId: gerarUuid(),
        substancia: "Iodo",
        gravidade: "leve",
      }),
    ).toMatchObject({
      motivo: "nao_encontrado",
    });
    const alergiaDoOutro = await obterIdoso(servico(), outro.ator, outro.idosoId);
    const id = alergiaDoOutro.ok ? (alergiaDoOutro.idoso.alergias[0]?.id ?? "") : "";
    expect(await desativarAlergia(servico(), ator, { idosoId, alergiaId: id })).toMatchObject({
      motivo: "nao_encontrado",
    });
  });

  it("adiciona e desativa contato; telefone inválido é recusado", async () => {
    const { ator, idosoId } = await cadastrar();
    expect(
      await adicionarContato(servico(), ator, {
        idosoId,
        nome: "Ana",
        parentesco: "Neta",
        telefone: "12",
      }),
    ).toMatchObject({ motivo: "dados_invalidos" });
    const novo = await adicionarContato(servico(), ator, {
      idosoId,
      nome: "Ana Souza",
      parentesco: "Neta",
      telefone: "+55 21 99876-5432",
    });
    if (!novo.ok) throw new Error("deveria adicionar");
    expect(await desativarContato(servico(), ator, { idosoId, contatoId: novo.contatoId })).toEqual(
      { ok: true },
    );
    const d = await obterIdoso(servico(), ator, idosoId);
    expect(d.ok && d.idoso.contatos.map((c) => c.nome)).toEqual(["João da Silva"]);
  });

  it("ver CPF e telefones por extenso é uma ação própria e fica registrada", async () => {
    const { ator, idosoId } = await cadastrar();
    const r = await revelarDadosSensiveis(servico(), ator, { idosoId });
    expect(r).toMatchObject({ ok: true, cpf: "52998224725" });
    expect(r.ok && r.telefones.map((t) => t.telefone)).toEqual(["11912345678"]);

    const [log] = await sql<{ usuario_id: string }>(
      casaA,
      "SELECT usuario_id FROM auditoria WHERE acao = 'idoso.dados_sensiveis_lidos' AND entidade_id = $1",
      [idosoId],
    );
    expect(log?.usuario_id).toBe(ator.usuarioId);
    expect(await revelarDadosSensiveis(servico(), ator, { idosoId: gerarUuid() })).toMatchObject({
      motivo: "nao_encontrado",
    });
  });
});

describe("pulseira", () => {
  it("o tablet localiza o idoso pelo conteúdo do QR, pelo código agrupado ou em minúsculas", async () => {
    const { idosoId, codigoPulseira } = await cadastrar("Idoso da Pulseira");
    const cuidador = await criarAtorTablet(servico, migrador, casaA);

    for (const leitura of [
      montarPayloadQr("idoso", codigoPulseira),
      codigoLegivel(codigoPulseira),
      codigoLegivel(codigoPulseira).toLowerCase(),
    ]) {
      const r = await localizarPorPulseira(servico(), cuidador, leitura);
      expect(r.ok && r.idoso).toMatchObject({
        id: idosoId,
        nome: "Idoso da Pulseira",
        status: "ativo",
      });
      // O cuidador vê as alergias na hora da leitura, graves primeiro.
      expect(r.ok && r.idoso.alergias[0]?.substancia).toBe("Dipirona");
    }
  });

  it("recusa QR de lote, texto inválido e código que não existe", async () => {
    const cuidador = await criarAtorTablet(servico, migrador, casaA);
    const codigo = gerarCodigoOpaco();
    expect(
      await localizarPorPulseira(servico(), cuidador, montarPayloadQr("lote", codigo)),
    ).toEqual({ ok: false, motivo: "codigo_invalido" });
    expect(await localizarPorPulseira(servico(), cuidador, "qualquer coisa")).toEqual({
      ok: false,
      motivo: "codigo_invalido",
    });
    expect(await localizarPorPulseira(servico(), cuidador, "x".repeat(500))).toEqual({
      ok: false,
      motivo: "codigo_invalido",
    });
    expect(
      await localizarPorPulseira(servico(), cuidador, montarPayloadQr("idoso", codigo)),
    ).toEqual({
      ok: false,
      motivo: "pulseira_desconhecida",
    });
  });

  it("trocar a pulseira aposenta a antiga com aviso próprio e a nova passa a valer", async () => {
    const { ator, idosoId, codigoPulseira } = await cadastrar();
    const cuidador = await criarAtorTablet(servico, migrador, casaA);

    expect(await regenerarPulseira(servico(), ator, { idosoId, motivo: "" })).toMatchObject({
      motivo: "dados_invalidos",
    });
    expect(
      await regenerarPulseira(servico(), ator, { idosoId, motivo: "Perdida no banho" }),
    ).toEqual({ ok: true });

    expect(await localizarPorPulseira(servico(), cuidador, codigoPulseira)).toEqual({
      ok: false,
      motivo: "pulseira_substituida",
    });
    const nova = await emitirPulseira(servico(), ator, { idosoId });
    if (!nova.ok) throw new Error("deveria emitir");
    expect(nova.pulseira.codigo).not.toBe(codigoPulseira);
    expect((await localizarPorPulseira(servico(), cuidador, nova.pulseira.codigo)).ok).toBe(true);

    // A auditoria registra a troca e o motivo, mas nunca os códigos.
    const tudo = JSON.stringify(await sql(casaA, "SELECT to_jsonb(a) AS linha FROM auditoria a"));
    expect(tudo).toContain("Perdida no banho");
    expect(tudo).not.toContain(codigoPulseira);
    expect(tudo).not.toContain(nova.pulseira.codigo);
  });

  it("toda emissão ou reimpressão da pulseira fica registrada", async () => {
    const { ator, idosoId } = await cadastrar();
    await emitirPulseira(servico(), ator, { idosoId });
    await emitirPulseira(servico(), ator, { idosoId });
    const linhas = await sql(
      casaA,
      "SELECT 1 FROM auditoria WHERE acao = 'idoso.pulseira_emitida' AND entidade_id = $1",
      [idosoId],
    );
    expect(linhas).toHaveLength(2);
    expect(await emitirPulseira(servico(), ator, { idosoId: gerarUuid() })).toMatchObject({
      motivo: "nao_encontrado",
    });
  });
});

describe("isolamento entre casas", () => {
  it("a casa B não vê, não edita e não localiza idosos da casa A", async () => {
    const { idosoId, codigoPulseira } = await cadastrar("Idosa Exclusiva da Casa A");
    const gestorB = await criarAtorWeb(servico, migrador, casaB, "gestor");
    const cuidadorB = await criarAtorTablet(servico, migrador, casaB);

    expect(await obterIdoso(servico(), gestorB, idosoId)).toEqual({
      ok: false,
      motivo: "nao_encontrado",
    });
    expect(await editarIdoso(servico(), gestorB, { idosoId, quarto: "invadido" })).toMatchObject({
      motivo: "nao_encontrado",
    });
    expect(
      await mudarStatusDoIdoso(servico(), gestorB, { idosoId, status: "desligado" }),
    ).toMatchObject({ motivo: "nao_encontrado" });
    expect(await revelarDadosSensiveis(servico(), gestorB, { idosoId })).toMatchObject({
      motivo: "nao_encontrado",
    });
    expect(await emitirPulseira(servico(), gestorB, { idosoId })).toMatchObject({
      motivo: "nao_encontrado",
    });
    expect(
      await regenerarPulseira(servico(), gestorB, { idosoId, motivo: "invasão" }),
    ).toMatchObject({ motivo: "nao_encontrado" });
    expect(
      await adicionarAlergia(servico(), gestorB, {
        idosoId,
        substancia: "Veneno",
        gravidade: "grave",
      }),
    ).toMatchObject({ motivo: "nao_encontrado" });
    expect(await localizarPorPulseira(servico(), cuidadorB, codigoPulseira)).toEqual({
      ok: false,
      motivo: "pulseira_desconhecida",
    });
    expect(JSON.stringify(await listarIdosos(servico(), gestorB))).not.toContain("Idosa Exclusiva");

    const [i] = await sql<{ quarto: string; status: string }>(
      casaA,
      "SELECT quarto, status FROM idoso WHERE id = $1",
      [idosoId],
    );
    expect(i).toEqual({ quarto: "12B", status: "ativo" });
  });

  it("o banco impede um filho de apontar para o pai de outra casa", async () => {
    const { idosoId } = await cadastrar();
    // Mesmo com o contexto da casa B, a chave composta (idoso_id, casa_id) não casa com a casa A.
    await expect(
      sql(
        casaB,
        `INSERT INTO alergia (casa_id, idoso_id, substancia, gravidade)
         VALUES (app_casa_id(), $1, 'Teste', 'leve')`,
        [idosoId],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("o banco recusa pulseira com formato inválido ou repetida", async () => {
    const { idosoId, codigoPulseira } = await cadastrar();
    await expect(
      sql(casaA, "UPDATE idoso SET codigo_pulseira = 'ABC' WHERE id = $1", [idosoId]),
    ).rejects.toThrow(/check/i);
    const outro = await cadastrar();
    await expect(
      sql(casaA, "UPDATE idoso SET codigo_pulseira = $2 WHERE id = $1", [
        outro.idosoId,
        codigoPulseira,
      ]),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

function gerarUuid(): string {
  return crypto.randomUUID();
}
