import type { PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrar, decifrar } from "@/compartilhado/criptografia";
import { extrairCodigo } from "@/compartilhado/qr";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import {
  mascararCpf,
  mascararTelefone,
  normalizarCpf,
  normalizarTelefone,
  validarAlergia,
  validarContato,
  validarIdoso,
  type EntradaAlergia,
  type EntradaContato,
  type EntradaIdoso,
  type Gravidade,
} from "../dominio/validacao";

// Cadastro de idosos, alergias, contatos e pulseiras.
//
// - Tudo acontece na transação da casa do ator e é auditado na mesma transação.
// - A auditoria guarda identificadores e NOMES DE CAMPOS alterados, não nome, CPF ou telefone:
//   o registro é imutável e dados pessoais não poderiam ser corrigidos ou apagados depois (LGPD).
// - CPF e telefone ficam cifrados no banco. A tela recebe versões mascaradas; ver o dado inteiro
//   é uma ação separada e auditada.

export type StatusIdoso = "ativo" | "hospitalizado" | "desligado";
export const STATUS_IDOSO: readonly StatusIdoso[] = ["ativo", "hospitalizado", "desligado"];

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

const NAO_ENCONTRADO = () => falha("nao_encontrado");

export type NovoIdoso = EntradaIdoso & {
  alergias?: EntradaAlergia[];
  contatos?: EntradaContato[];
};

async function inserirAlergia(
  c: PoolClient,
  ator: SessaoAutenticada,
  idosoId: string,
  a: EntradaAlergia,
  ip: string | null | undefined,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO alergia (casa_id, idoso_id, substancia, gravidade, observacao, criado_por)
     VALUES (app_casa_id(), $1, $2, $3, $4, $5) RETURNING id`,
    [idosoId, a.substancia.trim(), a.gravidade, a.observacao?.trim() || null, ator.usuarioId],
  );
  const id = r.rows[0]?.id ?? "";
  await registrarAuditoria(c, {
    acao: "alergia.adicionada",
    entidade: "alergia",
    entidadeId: id,
    depois: { idosoId, gravidade: a.gravidade },
    ip,
  });
  return id;
}

async function inserirContato(
  c: PoolClient,
  servico: Servico,
  ator: SessaoAutenticada,
  idosoId: string,
  contato: EntradaContato,
  ip: string | null | undefined,
): Promise<string> {
  const telefone = normalizarTelefone(contato.telefone) ?? "";
  const r = await c.query<{ id: string }>(
    `INSERT INTO contato_emergencia
       (casa_id, idoso_id, nome, parentesco, telefone_cifrado, responsavel_legal, criado_por)
     VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      idosoId,
      contato.nome.trim(),
      contato.parentesco.trim(),
      cifrar(telefone, servico.chaveCampos),
      contato.responsavelLegal ?? false,
      ator.usuarioId,
    ],
  );
  const id = r.rows[0]?.id ?? "";
  await registrarAuditoria(c, {
    acao: "contato.adicionado",
    entidade: "contato_emergencia",
    entidadeId: id,
    depois: { idosoId, responsavelLegal: contato.responsavelLegal ?? false },
    ip,
  });
  return id;
}

export async function cadastrarIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: NovoIdoso & { ip?: string | null },
): Promise<{ ok: true; idosoId: string; codigoPulseira: string } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const agora = relogio(servico);

  const problemas = [
    ...validarIdoso(entrada, agora),
    ...(entrada.alergias ?? []).flatMap(validarAlergia),
    ...(entrada.contatos ?? []).flatMap(validarContato),
  ];
  if (problemas.length > 0) return dadosInvalidos(...problemas);

  const codigoPulseira = gerarCodigoOpaco();
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const cpf = entrada.cpf ? normalizarCpf(entrada.cpf) : null;
    const r = await c.query<{ id: string }>(
      `INSERT INTO idoso
         (casa_id, nome, data_nascimento, cpf_cifrado, quarto, codigo_pulseira, criado_por)
       VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        entrada.nome.trim(),
        entrada.dataNascimento,
        cpf ? cifrar(cpf, servico.chaveCampos) : null,
        entrada.quarto?.trim() || null,
        codigoPulseira,
        ator.usuarioId,
      ],
    );
    const idosoId = r.rows[0]?.id ?? "";
    for (const a of entrada.alergias ?? []) await inserirAlergia(c, ator, idosoId, a, entrada.ip);
    for (const contato of entrada.contatos ?? []) {
      await inserirContato(c, servico, ator, idosoId, contato, entrada.ip);
    }
    await registrarAuditoria(c, {
      acao: "idoso.cadastrado",
      entidade: "idoso",
      entidadeId: idosoId,
      depois: {
        comCpf: cpf !== null,
        alergias: entrada.alergias?.length ?? 0,
        contatos: entrada.contatos?.length ?? 0,
      },
      ip: entrada.ip,
    });
    return { ok: true, idosoId, codigoPulseira } as const;
  });
}

export async function editarIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: {
    idosoId: string;
    nome?: string;
    dataNascimento?: string;
    cpf?: string | null;
    quarto?: string | null;
    ip?: string | null;
  },
): Promise<{ ok: true; camposAlterados: string[] } | Falha<"dados_invalidos" | "nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const problemas = validarIdoso(entrada, relogio(servico));
  if (problemas.length > 0) return dadosInvalidos(...problemas);

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const existe = await c.query("SELECT 1 FROM idoso WHERE id = $1 FOR UPDATE", [entrada.idosoId]);
    if (existe.rowCount !== 1) return NAO_ENCONTRADO();

    const sets: string[] = [];
    const valores: unknown[] = [entrada.idosoId];
    const campos: string[] = [];
    const adicionar = (coluna: string, valor: unknown, campo: string) => {
      valores.push(valor);
      sets.push(`${coluna} = $${valores.length}`);
      campos.push(campo);
    };
    if (entrada.nome !== undefined) adicionar("nome", entrada.nome.trim(), "nome");
    if (entrada.dataNascimento !== undefined) {
      adicionar("data_nascimento", entrada.dataNascimento, "dataNascimento");
    }
    if (entrada.cpf !== undefined) {
      adicionar(
        "cpf_cifrado",
        entrada.cpf ? cifrar(normalizarCpf(entrada.cpf), servico.chaveCampos) : null,
        "cpf",
      );
    }
    if (entrada.quarto !== undefined) adicionar("quarto", entrada.quarto?.trim() || null, "quarto");
    if (sets.length === 0) return dadosInvalidos("Nenhum campo para alterar.");

    await c.query(
      `UPDATE idoso SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $1`,
      valores,
    );
    await registrarAuditoria(c, {
      acao: "idoso.editado",
      entidade: "idoso",
      entidadeId: entrada.idosoId,
      depois: { campos },
      ip: entrada.ip,
    });
    return { ok: true, camposAlterados: campos } as const;
  });
}

export async function mudarStatusDoIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; status: StatusIdoso; ip?: string | null },
): Promise<{ ok: true } | Falha<"dados_invalidos" | "nao_encontrado" | "sem_mudanca">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  if (!STATUS_IDOSO.includes(entrada.status)) return dadosInvalidos("Situação desconhecida.");
  const agora = relogio(servico);

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ status: StatusIdoso }>(
      "SELECT status FROM idoso WHERE id = $1 FOR UPDATE",
      [entrada.idosoId],
    );
    const atual = r.rows[0]?.status;
    if (!atual) return NAO_ENCONTRADO();
    if (atual === entrada.status) return falha("sem_mudanca");

    await c.query(
      "UPDATE idoso SET status = $2, status_alterado_em = $3, atualizado_em = now() WHERE id = $1",
      [entrada.idosoId, entrada.status, agora],
    );
    await registrarAuditoria(c, {
      acao: "idoso.status_alterado",
      entidade: "idoso",
      entidadeId: entrada.idosoId,
      antes: { status: atual },
      depois: { status: entrada.status },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export type ResumoDeIdoso = {
  id: string;
  nome: string;
  dataNascimento: string;
  quarto: string | null;
  status: StatusIdoso;
  alergiasAtivas: number;
  alergiasGraves: number;
};

export async function listarIdosos(
  servico: Servico,
  ator: SessaoAutenticada,
  filtro: { status?: StatusIdoso } = {},
): Promise<ResumoDeIdoso[]> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      id: string;
      nome: string;
      data_nascimento: string;
      quarto: string | null;
      status: StatusIdoso;
      alergias_ativas: string;
      alergias_graves: string;
    }>(
      `SELECT i.id, i.nome, i.data_nascimento::text AS data_nascimento, i.quarto, i.status,
              count(a.id)::text AS alergias_ativas,
              count(a.id) FILTER (WHERE a.gravidade = 'grave')::text AS alergias_graves
         FROM idoso i
         LEFT JOIN alergia a ON a.idoso_id = i.id AND a.ativa
        WHERE ($1::status_idoso IS NULL OR i.status = $1::status_idoso)
        GROUP BY i.id
        ORDER BY i.nome`,
      [filtro.status ?? null],
    );
    return r.rows.map((l) => ({
      id: l.id,
      nome: l.nome,
      dataNascimento: l.data_nascimento,
      quarto: l.quarto,
      status: l.status,
      alergiasAtivas: Number(l.alergias_ativas),
      alergiasGraves: Number(l.alergias_graves),
    }));
  });
}

export type AlergiaDoIdoso = {
  id: string;
  substancia: string;
  gravidade: Gravidade;
  observacao: string | null;
};

export type ContatoDoIdoso = {
  id: string;
  nome: string;
  parentesco: string;
  /** Mascarado. O número inteiro só sai por `revelarDadosSensiveis`. */
  telefone: string;
  responsavelLegal: boolean;
};

export type DetalheDoIdoso = Omit<ResumoDeIdoso, "alergiasAtivas" | "alergiasGraves"> & {
  temCpf: boolean;
  cpf: string | null;
  alergias: AlergiaDoIdoso[];
  contatos: ContatoDoIdoso[];
};

export async function listarAlergiasAtivas(
  c: PoolClient,
  idosoId: string,
): Promise<AlergiaDoIdoso[]> {
  const r = await c.query<AlergiaDoIdoso>(
    `SELECT id, substancia, gravidade, observacao FROM alergia
      WHERE idoso_id = $1 AND ativa
      ORDER BY CASE gravidade WHEN 'grave' THEN 0 WHEN 'moderada' THEN 1 ELSE 2 END, substancia`,
    [idosoId],
  );
  return r.rows;
}

export async function obterIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  idosoId: string,
): Promise<{ ok: true; idoso: DetalheDoIdoso } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      id: string;
      nome: string;
      data_nascimento: string;
      quarto: string | null;
      status: StatusIdoso;
      cpf_cifrado: string | null;
    }>(
      `SELECT id, nome, data_nascimento::text AS data_nascimento, quarto, status, cpf_cifrado
         FROM idoso WHERE id = $1`,
      [idosoId],
    );
    const i = r.rows[0];
    if (!i) return NAO_ENCONTRADO();

    const contatos = await c.query<{
      id: string;
      nome: string;
      parentesco: string;
      telefone_cifrado: string;
      responsavel_legal: boolean;
    }>(
      `SELECT id, nome, parentesco, telefone_cifrado, responsavel_legal
         FROM contato_emergencia WHERE idoso_id = $1 AND ativo
        ORDER BY responsavel_legal DESC, nome`,
      [idosoId],
    );
    return {
      ok: true,
      idoso: {
        id: i.id,
        nome: i.nome,
        dataNascimento: i.data_nascimento,
        quarto: i.quarto,
        status: i.status,
        temCpf: i.cpf_cifrado !== null,
        cpf: i.cpf_cifrado ? mascararCpf(decifrar(i.cpf_cifrado, servico.chaveCampos)) : null,
        alergias: await listarAlergiasAtivas(c, idosoId),
        contatos: contatos.rows.map((l) => ({
          id: l.id,
          nome: l.nome,
          parentesco: l.parentesco,
          telefone: mascararTelefone(decifrar(l.telefone_cifrado, servico.chaveCampos)),
          responsavelLegal: l.responsavel_legal,
        })),
      },
    } as const;
  });
}

/** CPF e telefones por extenso. Cada consulta fica registrada, com quem pediu. */
export async function revelarDadosSensiveis(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; ip?: string | null },
): Promise<
  | { ok: true; cpf: string | null; telefones: Array<{ contatoId: string; telefone: string }> }
  | Falha<"nao_encontrado">
> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ cpf_cifrado: string | null }>(
      "SELECT cpf_cifrado FROM idoso WHERE id = $1",
      [entrada.idosoId],
    );
    if (r.rowCount !== 1) return NAO_ENCONTRADO();
    const contatos = await c.query<{ id: string; telefone_cifrado: string }>(
      "SELECT id, telefone_cifrado FROM contato_emergencia WHERE idoso_id = $1 AND ativo",
      [entrada.idosoId],
    );
    await registrarAuditoria(c, {
      acao: "idoso.dados_sensiveis_lidos",
      entidade: "idoso",
      entidadeId: entrada.idosoId,
      ip: entrada.ip,
    });
    const cpf = r.rows[0]?.cpf_cifrado;
    return {
      ok: true,
      cpf: cpf ? decifrar(cpf, servico.chaveCampos) : null,
      telefones: contatos.rows.map((l) => ({
        contatoId: l.id,
        telefone: decifrar(l.telefone_cifrado, servico.chaveCampos),
      })),
    } as const;
  });
}

export async function adicionarAlergia(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: EntradaAlergia & { idosoId: string; ip?: string | null },
): Promise<{ ok: true; alergiaId: string } | Falha<"dados_invalidos" | "nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const problemas = validarAlergia(entrada);
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const existe = await c.query("SELECT 1 FROM idoso WHERE id = $1", [entrada.idosoId]);
    if (existe.rowCount !== 1) return NAO_ENCONTRADO();
    return {
      ok: true,
      alergiaId: await inserirAlergia(c, ator, entrada.idosoId, entrada, entrada.ip),
    } as const;
  });
}

export async function desativarAlergia(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; alergiaId: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query(
      `UPDATE alergia SET ativa = false, desativada_em = $3, desativada_por = $4
        WHERE id = $1 AND idoso_id = $2 AND ativa`,
      [entrada.alergiaId, entrada.idosoId, agora, ator.usuarioId],
    );
    if (r.rowCount !== 1) return NAO_ENCONTRADO();
    await registrarAuditoria(c, {
      acao: "alergia.desativada",
      entidade: "alergia",
      entidadeId: entrada.alergiaId,
      depois: { idosoId: entrada.idosoId },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export async function adicionarContato(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: EntradaContato & { idosoId: string; ip?: string | null },
): Promise<{ ok: true; contatoId: string } | Falha<"dados_invalidos" | "nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const problemas = validarContato(entrada);
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const existe = await c.query("SELECT 1 FROM idoso WHERE id = $1", [entrada.idosoId]);
    if (existe.rowCount !== 1) return NAO_ENCONTRADO();
    return {
      ok: true,
      contatoId: await inserirContato(c, servico, ator, entrada.idosoId, entrada, entrada.ip),
    } as const;
  });
}

export async function desativarContato(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; contatoId: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query(
      `UPDATE contato_emergencia SET ativo = false, desativado_em = $3, desativado_por = $4
        WHERE id = $1 AND idoso_id = $2 AND ativo`,
      [entrada.contatoId, entrada.idosoId, agora, ator.usuarioId],
    );
    if (r.rowCount !== 1) return NAO_ENCONTRADO();
    await registrarAuditoria(c, {
      acao: "contato.desativado",
      entidade: "contato_emergencia",
      entidadeId: entrada.contatoId,
      depois: { idosoId: entrada.idosoId },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

// ------------------------------------------------------------------------------------------
// Pulseira

export type DadosDaPulseira = {
  idosoId: string;
  nome: string;
  dataNascimento: string;
  quarto: string | null;
  codigo: string;
};

/** Dados para imprimir a pulseira. Cada emissão (ou reimpressão) fica registrada. */
export async function emitirPulseira(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; ip?: string | null },
): Promise<{ ok: true; pulseira: DadosDaPulseira } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      nome: string;
      data_nascimento: string;
      quarto: string | null;
      codigo_pulseira: string;
    }>(
      `SELECT nome, data_nascimento::text AS data_nascimento, quarto, codigo_pulseira
         FROM idoso WHERE id = $1`,
      [entrada.idosoId],
    );
    const i = r.rows[0];
    if (!i) return NAO_ENCONTRADO();
    await registrarAuditoria(c, {
      acao: "idoso.pulseira_emitida",
      entidade: "idoso",
      entidadeId: entrada.idosoId,
      ip: entrada.ip,
    });
    return {
      ok: true,
      pulseira: {
        idosoId: entrada.idosoId,
        nome: i.nome,
        dataNascimento: i.data_nascimento,
        quarto: i.quarto,
        codigo: i.codigo_pulseira,
      },
    } as const;
  });
}

/** Pulseira perdida ou comprometida: gera código novo e aposenta o antigo. */
export async function regenerarPulseira(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; motivo: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"dados_invalidos" | "nao_encontrado">> {
  exigirPermissao(ator.perfil, "idoso.gerir");
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3 || motivo.length > 200) {
    return dadosInvalidos("Informe o motivo da troca da pulseira (3 a 200 caracteres).");
  }
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ codigo_pulseira: string }>(
      "SELECT codigo_pulseira FROM idoso WHERE id = $1 FOR UPDATE",
      [entrada.idosoId],
    );
    const antigo = r.rows[0]?.codigo_pulseira;
    if (!antigo) return NAO_ENCONTRADO();

    await c.query(
      `INSERT INTO pulseira_revogada (casa_id, idoso_id, codigo, revogada_em, revogada_por)
       VALUES (app_casa_id(), $1, $2, $3, $4)`,
      [entrada.idosoId, antigo, agora, ator.usuarioId],
    );
    await c.query("UPDATE idoso SET codigo_pulseira = $2, atualizado_em = now() WHERE id = $1", [
      entrada.idosoId,
      gerarCodigoOpaco(),
    ]);
    // Os códigos não entram na auditoria: só o fato e o motivo.
    await registrarAuditoria(c, {
      acao: "idoso.pulseira_regenerada",
      entidade: "idoso",
      entidadeId: entrada.idosoId,
      depois: { motivo },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export type IdosoLocalizado = {
  id: string;
  nome: string;
  status: StatusIdoso;
  quarto: string | null;
  alergias: AlergiaDoIdoso[];
};

/**
 * Leitura da pulseira no tablet. Qualquer perfil que veja a escala pode ler. Aceita o conteúdo
 * do QR ou o código digitado à mão.
 */
export async function localizarPorPulseira(
  servico: Servico,
  ator: SessaoAutenticada,
  leitura: string,
): Promise<
  | { ok: true; idoso: IdosoLocalizado }
  | Falha<"codigo_invalido" | "pulseira_substituida" | "pulseira_desconhecida">
> {
  exigirPermissao(ator.perfil, "escala.ver");
  const codigo = leitura.length <= 100 ? extrairCodigo(leitura, "idoso") : null;
  if (!codigo) return falha("codigo_invalido");

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      id: string;
      nome: string;
      status: StatusIdoso;
      quarto: string | null;
    }>("SELECT id, nome, status, quarto FROM idoso WHERE codigo_pulseira = $1", [codigo]);
    const i = r.rows[0];
    if (i) {
      return {
        ok: true,
        idoso: { ...i, alergias: await listarAlergiasAtivas(c, i.id) },
      } as const;
    }
    const velha = await c.query("SELECT 1 FROM pulseira_revogada WHERE codigo = $1", [codigo]);
    return velha.rowCount === 1 ? falha("pulseira_substituida") : falha("pulseira_desconhecida");
  });
}
