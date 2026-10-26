import type pg from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import { registrarEntrada, type EntradaDeLote } from "@/modules/estoque";
import type { Servico, SessaoAutenticada } from "@/modules/identidade";
import { cadastrarIdoso } from "@/modules/idosos";
import { cadastrarMedicamento, prescrever, type ConteudoDePrescricao } from "@/modules/prescricoes";

// Dados de teste do estoque. Tudo passa pelas funções reais dos módulos (nada é inserido por
// fora), então os testes exercitam o mesmo caminho que a aplicação.

let contador = 0;
const proximo = () => (contador += 1);

export async function novoMedicamento(
  servico: Servico,
  ator: SessaoAutenticada,
  extra: { nome?: string; forma?: "comprimido" | "gotas" | "xarope" } = {},
): Promise<string> {
  const n = proximo();
  const r = await cadastrarMedicamento(servico, ator, {
    nomeComercial: extra.nome ?? `Remedio Estoque ${n}`,
    principioAtivo: `SubstanciaEst${n}x`,
    concentracao: "10 mg",
    forma: extra.forma ?? "comprimido",
  });
  if (!r.ok) throw new Error(`medicamento: ${r.motivo}`);
  return r.medicamentoId;
}

export async function novoIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  nome?: string,
): Promise<string> {
  const n = proximo();
  const r = await cadastrarIdoso(servico, ator, {
    nome: nome ?? `Residente Estoque ${n}`,
    dataNascimento: "1940-01-01",
    alergias: [],
  });
  if (!r.ok) throw new Error(`idoso: ${r.motivo}`);
  return r.idosoId;
}

export async function entrarLote(
  servico: Servico,
  ator: SessaoAutenticada,
  medicamentoId: string,
  quantidade: number,
  extra: Partial<EntradaDeLote> = {},
): Promise<string> {
  const r = await registrarEntrada(servico, ator, {
    medicamentoId,
    numeroLote: `L${proximo()}`,
    validade: "2030-01-31",
    unidade: "comprimido",
    quantidade,
    ...extra,
  });
  if (!r.ok)
    throw new Error(`entrada: ${r.motivo} ${JSON.stringify("problemas" in r ? r.problemas : "")}`);
  return r.loteId;
}

export async function prescreverParaEstoque(
  servico: Servico,
  ator: SessaoAutenticada,
  idosoId: string,
  medicamentoId: string,
  horarios: string[],
  extra: Partial<ConteudoDePrescricao> = {},
): Promise<string> {
  const r = await prescrever(servico, ator, {
    idosoId,
    medicamentoId,
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: "2026-03-10",
    fim: null,
    altoRisco: false,
    horarios: horarios.map((hora) => ({ hora })),
    ...extra,
  });
  if (!r.ok)
    throw new Error(
      `prescrever: ${r.motivo} ${JSON.stringify("problemas" in r ? r.problemas : "")}`,
    );
  return r.prescricaoId;
}

export async function saldoDoLote(app: pg.Pool, casaId: string, loteId: string): Promise<number> {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{ saldo: string }>(
      "SELECT saldo::text AS saldo FROM saldo_lote WHERE lote_id = $1",
      [loteId],
    );
    return Number(r.rows[0]?.saldo);
  });
}

export async function movimentosDoLote(app: pg.Pool, casaId: string, loteId: string) {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{
      tipo: string;
      quantidade: string;
      motivo: string | null;
      par_id: string | null;
    }>(
      "SELECT tipo, quantidade::text AS quantidade, motivo, par_id FROM movimento_estoque WHERE lote_id = $1 ORDER BY seq",
      [loteId],
    );
    return r.rows.map((m) => ({
      tipo: m.tipo,
      quantidade: Number(m.quantidade),
      motivo: m.motivo,
      parId: m.par_id,
    }));
  });
}

export async function acoesDeAuditoria(
  app: pg.Pool,
  casaId: string,
  entidadeId: string,
): Promise<string[]> {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{ acao: string }>(
      "SELECT acao FROM auditoria WHERE entidade_id = $1 ORDER BY id",
      [entidadeId],
    );
    return r.rows.map((a) => a.acao);
  });
}

/**
 * Registra um consumo de estoque como uma administração de verdade, sem passar pela conferência
 * (os testes de estoque querem só o efeito no saldo). Cria, se preciso, um residente desligado e
 * uma prescrição SOS já encerrada para o medicamento do lote: nenhum dos dois aparece na demanda
 * de estoque, então as previsões dos testes não mudam.
 */
export async function consumirDoLote(
  app: pg.Pool,
  casaId: string,
  usuarioId: string,
  loteId: string,
  quantidade: number,
): Promise<void> {
  await comContexto(app, { casaId, usuarioId }, async (c) => {
    const l = await c.query<{ medicamento_id: string; idoso_id: string | null; unidade: string }>(
      "SELECT medicamento_id, idoso_id, unidade FROM lote_estoque WHERE id = $1",
      [loteId],
    );
    const lote = l.rows[0];
    if (!lote) throw new Error("lote não encontrado");
    let idosoId = lote.idoso_id;
    if (!idosoId) {
      const i = await c.query<{ id: string }>(
        `INSERT INTO idoso (casa_id, nome, data_nascimento, codigo_pulseira, status, status_alterado_em)
         VALUES (app_casa_id(), 'Consumo de teste', '1930-01-01', $1, 'desligado', now())
         RETURNING id`,
        [gerarCodigoOpaco()],
      );
      idosoId = i.rows[0]?.id ?? null;
    }
    const p = await c.query<{ id: string }>(
      `INSERT INTO prescricao (casa_id, idoso_id, medicamento_id, grupo_id, versao, tipo, dose, unidade,
                               via, inicio, sos_indicacao, sos_limite_diario, sos_intervalo_min,
                               status, encerrada_em, criado_por)
       VALUES (app_casa_id(), $1, $2, gen_random_uuid(), 1, 'sos', 1, $3::unidade_dose, 'oral',
               '2020-01-01', 'teste de estoque', 24, 1, 'encerrada', now(), $4)
       RETURNING id`,
      [idosoId, lote.medicamento_id, lote.unidade, usuarioId],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO administracao (casa_id, chave, prescricao_id, idoso_id, resultado, motivo, lote_id,
                                  quantidade, usuario_id, ocorrida_em, registrada_em, metodo)
       VALUES (app_casa_id(), gen_random_uuid(), $1, $2, 'administrada', 'teste de estoque', $3, $4,
               $5, now(), now(), 'qr')
       RETURNING id`,
      [p.rows[0]?.id, idosoId, loteId, quantidade, usuarioId],
    );
    await c.query(
      `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, usuario_id, administracao_id)
       VALUES (app_casa_id(), $1, 'consumo', $2, $3, $4)`,
      [loteId, -quantidade, usuarioId, a.rows[0]?.id],
    );
  });
}
