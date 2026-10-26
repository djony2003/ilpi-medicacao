import { randomUUID } from "node:crypto";
import type pg from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarDosesDaCasa } from "@/modules/administracao";
import { registrarEntrada } from "@/modules/estoque";
import type { Servico, SessaoAutenticada } from "@/modules/identidade";
import { adicionarAlergia, cadastrarIdoso } from "@/modules/idosos";
import { cadastrarMedicamento, prescrever, type ConteudoDePrescricao } from "@/modules/prescricoes";
import { criarUsuario, type UsuarioDeTeste } from "./dados";

// Cenário do registro de administração: tudo criado pelas funções reais dos módulos.

let n = 0;
const proximo = () => (n += 1);

export const PIN = "846201";
export const nova = () => randomUUID();
export const qrPulseira = (codigo: string) => `ILPI:I:${codigo}`;
export const qrLote = (codigo: string) => `ILPI:L:${codigo}`;

export async function idosoComPulseira(
  servico: Servico,
  ator: SessaoAutenticada,
  nome?: string,
): Promise<{ id: string; pulseira: string }> {
  const r = await cadastrarIdoso(servico, ator, {
    nome: nome ?? `Residente ${proximo()}`,
    dataNascimento: "1938-01-01",
    alergias: [],
  });
  if (!r.ok) throw new Error(`idoso: ${r.motivo}`);
  return { id: r.idosoId, pulseira: qrPulseira(r.codigoPulseira) };
}

export async function medicamento(
  servico: Servico,
  ator: SessaoAutenticada,
  extra: { principioAtivo?: string; nome?: string } = {},
): Promise<string> {
  const k = proximo();
  const r = await cadastrarMedicamento(servico, ator, {
    nomeComercial: extra.nome ?? `Remedio Adm ${k}`,
    principioAtivo: extra.principioAtivo ?? `SubstanciaAdm${k}x`,
    concentracao: "10 mg",
    forma: "comprimido",
  });
  if (!r.ok) throw new Error(`medicamento: ${r.motivo}`);
  return r.medicamentoId;
}

export async function alergia(
  servico: Servico,
  ator: SessaoAutenticada,
  idosoId: string,
  substancia: string,
): Promise<string> {
  const r = await adicionarAlergia(servico, ator, { idosoId, substancia, gravidade: "grave" });
  if (!r.ok) throw new Error("alergia");
  return r.alergiaId;
}

/** Entrada de lote; devolve o id e o texto do QR da etiqueta. */
export async function lote(
  servico: Servico,
  app: pg.Pool,
  ator: SessaoAutenticada,
  medicamentoId: string,
  quantidade: number,
  extra: { idosoId?: string | null; validade?: string; unidade?: "comprimido" | "ml" } = {},
): Promise<{ id: string; qr: string; codigo: string }> {
  const r = await registrarEntrada(servico, ator, {
    medicamentoId,
    numeroLote: `ADM-${proximo()}`,
    validade: extra.validade ?? "2030-01-31",
    unidade: extra.unidade ?? "comprimido",
    quantidade,
    idosoId: extra.idosoId ?? null,
  });
  if (!r.ok) throw new Error(`lote: ${r.motivo}`);
  const codigo = await comContexto(app, { casaId: ator.casaId }, async (c) => {
    const q = await c.query<{ codigo_qr: string }>(
      "SELECT codigo_qr FROM lote_estoque WHERE id = $1",
      [r.loteId],
    );
    return q.rows[0]?.codigo_qr ?? "";
  });
  return { id: r.loteId, qr: qrLote(codigo), codigo };
}

/** Prescreve, gera as doses e devolve a prescrição e a dose do horário pedido no dia pedido. */
export async function prescreverComDose(
  servico: Servico,
  ator: SessaoAutenticada,
  idosoId: string,
  medicamentoId: string,
  extra: Partial<ConteudoDePrescricao> & {
    hora?: string;
    dia?: string;
    justificativaAlergia?: string;
  } = {},
): Promise<{ prescricaoId: string; doseId: string }> {
  const hora = extra.hora ?? "08:00";
  const dia = extra.dia ?? "2026-03-10";
  const r = await prescrever(servico, ator, {
    idosoId,
    medicamentoId,
    tipo: "regular",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: dia,
    fim: null,
    altoRisco: false,
    horarios: [{ hora }],
    ...extra,
  });
  if (!r.ok) {
    throw new Error(
      `prescrever: ${r.motivo} ${JSON.stringify("problemas" in r ? r.problemas : "")}`,
    );
  }
  await gerarDosesDaCasa(servico, ator.casaId, { dias: 2 });
  const doseId = await doseDe(servico.pool, ator.casaId, r.prescricaoId, dia, hora);
  return { prescricaoId: r.prescricaoId, doseId };
}

export async function doseDe(
  app: pg.Pool,
  casaId: string,
  prescricaoId: string,
  dia: string,
  hora: string,
): Promise<string> {
  return comContexto(app, { casaId }, async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM dose_agendada
        WHERE prescricao_id = $1 AND data_local = $2 AND hora_local = $3 AND cancelada_em IS NULL`,
      [prescricaoId, dia, hora],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error(`dose ${dia} ${hora} não gerada`);
    return id;
  });
}

/** Outra pessoa da casa, com PIN, para segunda validação, exceção ou liberação. */
export async function pessoaComPin(
  migrador: pg.Pool,
  casaId: string,
  perfil: "cuidador" | "enfermeiro" | "gestor",
  nome?: string,
): Promise<UsuarioDeTeste> {
  return criarUsuario(migrador, casaId, { perfil, pin: PIN, nome });
}

export async function linhas<T extends Record<string, unknown>>(
  app: pg.Pool,
  casaId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return comContexto(app, { casaId }, async (c) => (await c.query<T>(sql, params)).rows);
}
