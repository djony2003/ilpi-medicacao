import type { PoolClient } from "pg";
import { extrairCodigo } from "@/compartilhado/qr";
import { falha, type Falha } from "@/compartilhado/resultado";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  consumirParaAdministracao,
  lerLote,
  loteParaConferencia,
  type LoteNaConferencia,
} from "@/modules/estoque";
import {
  confirmarPinDeOutraPessoa,
  type Acao,
  type PessoaConfirmada,
  type SessaoAutenticada,
} from "@/modules/identidade";
import type { AlergiaParaConferir } from "@/modules/prescricoes";
import type {
  Bloqueio,
  LeituraDaPulseira,
  LeituraDoLote,
  ResultadoDaAdministracao,
} from "../dominio/conferencia";
import { janelaDaCasa, type JanelaDaCasa } from "../dominio/estado";
import { dataLocalDe } from "../dominio/tempo";

// Peças comuns ao registro da dose agendada, da dose SOS e do registro tardio. Tudo aqui roda
// dentro da transação de quem chama.

export const contexto = (ator: SessaoAutenticada) => ({
  casaId: ator.casaId,
  usuarioId: ator.usuarioId,
});

export type PinDeOutraPessoa = { usuarioId: string; pin: string };

export type MotivoDaExcecao = "etiqueta_ilegivel" | "etiqueta_danificada";
export const MOTIVOS_DE_EXCECAO: readonly MotivoDaExcecao[] = [
  "etiqueta_ilegivel",
  "etiqueta_danificada",
];

/** Etiqueta ilegível: o lote é escolhido à mão e um enfermeiro libera com o PIN. */
export type ExcecaoDeConferencia = {
  loteId: string;
  motivo: MotivoDaExcecao;
  justificativa: string;
  liberador: PinDeOutraPessoa;
};

export type CasaDoRegistro = { fuso: string; janela: JanelaDaCasa; hoje: string };

export async function casaDoRegistro(c: PoolClient, agora: Date): Promise<CasaDoRegistro> {
  const r = await c.query<{ fuso: string; configuracoes: unknown }>(
    "SELECT fuso_horario AS fuso, configuracoes FROM casa WHERE id = app_casa_id()",
  );
  const { fuso, configuracoes } = r.rows[0] ?? { fuso: "America/Sao_Paulo", configuracoes: {} };
  return { fuso, janela: janelaDaCasa(configuracoes), hoje: dataLocalDe(agora, fuso) };
}

export async function alergiasDoIdoso(
  c: PoolClient,
  idosoId: string,
): Promise<AlergiaParaConferir[]> {
  const r = await c.query<AlergiaParaConferir>(
    "SELECT id, substancia, gravidade FROM alergia WHERE idoso_id = $1 AND ativa",
    [idosoId],
  );
  return r.rows;
}

/** A pulseira lida: de quem é (nesta casa), substituída, desconhecida ou nem é uma pulseira. */
export async function lerPulseira(c: PoolClient, leitura: string): Promise<LeituraDaPulseira> {
  const codigo = leitura.length <= 100 ? extrairCodigo(leitura, "idoso") : null;
  if (!codigo) return { situacao: "invalida" };
  const r = await c.query<{ id: string }>("SELECT id FROM idoso WHERE codigo_pulseira = $1", [
    codigo,
  ]);
  const i = r.rows[0];
  if (i) return { situacao: "lida", idosoId: i.id };
  const velha = await c.query("SELECT 1 FROM pulseira_revogada WHERE codigo = $1", [codigo]);
  return { situacao: velha.rowCount === 1 ? "substituida" : "desconhecida" };
}

/** O lote do registro: lido da etiqueta ou, na exceção, escolhido à mão. */
export async function lerLoteDoRegistro(
  c: PoolClient,
  e: { lote?: string; loteEscolhido?: string },
): Promise<{ leitura: LeituraDoLote | null; lote: LoteNaConferencia | null }> {
  if (e.loteEscolhido) {
    const lote = await loteParaConferencia(c, e.loteEscolhido);
    return lote
      ? { leitura: { situacao: "lida", lote }, lote }
      : { leitura: { situacao: "desconhecida" }, lote: null };
  }
  if (e.lote === undefined) return { leitura: null, lote: null };
  const lido = await lerLote(c, e.lote);
  return { leitura: lido, lote: lido.situacao === "lida" ? lido.lote : null };
}

export type FalhaDeConfirmacao = Falha<
  "pin_invalido" | "perfil_nao_autorizado" | "validador_igual"
> & {
  etapa: Etapa;
};
type Etapa = "segunda_validacao" | "excecao" | "liberacao";

const ACAO_DA_ETAPA: Record<Etapa, Acao> = {
  segunda_validacao: "administracao.segunda_validacao",
  excecao: "conferencia.liberar_excecao",
  liberacao: "conferencia.liberar_excecao",
};

/** Confirma a identidade de quem valida, libera ou autoriza a exceção. */
export async function confirmarEtapa(
  c: PoolClient,
  ator: SessaoAutenticada,
  etapa: Etapa,
  pin: PinDeOutraPessoa,
  agora: Date,
  ip: string | null | undefined,
): Promise<{ ok: true; pessoa: PessoaConfirmada } | FalhaDeConfirmacao> {
  // A segunda validação é de OUTRA pessoa; não adianta nem conferir o PIN de quem registra.
  if (etapa === "segunda_validacao" && pin.usuarioId === ator.usuarioId) {
    return { ...falha("validador_igual"), etapa };
  }
  const r = await confirmarPinDeOutraPessoa(c, {
    usuarioId: pin.usuarioId,
    pin: pin.pin,
    acao: ACAO_DA_ETAPA[etapa],
    agora,
    dispositivoId: ator.dispositivoId,
    ip,
  });
  return r.ok ? r : { ...falha(r.motivo), etapa };
}

export type NovaAdministracao = {
  chave: string;
  doseId: string | null;
  prescricaoId: string;
  idosoId: string;
  resultado: ResultadoDaAdministracao;
  motivo: string | null;
  adiadaPara: Date | null;
  lote: LoteNaConferencia | null;
  quantidade: number | null;
  ocorridaEm: Date;
  registradaEm: Date;
  metodo: "qr" | "excecao" | "tardio";
  foraDaJanela: "atrasado" | "adiantado" | null;
  liberadaPor: string | null;
  excecao: { motivo: MotivoDaExcecao; justificativa: string; liberadaPor: string } | null;
  validadorId: string | null;
};

/** Grava a administração, a baixa do estoque, a exceção, a segunda validação e a auditoria. */
export async function gravarAdministracao(
  c: PoolClient,
  ator: SessaoAutenticada,
  n: NovaAdministracao,
  ip: string | null | undefined,
): Promise<{ id: string; saldoDoLote: number | null }> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO administracao
       (casa_id, chave, dose_agendada_id, prescricao_id, idoso_id, resultado, motivo, adiada_para,
        lote_id, quantidade, usuario_id, dispositivo_id, ocorrida_em, registrada_em, metodo,
        fora_da_janela, liberada_por)
     VALUES (app_casa_id(), $1, $2, $3, $4, $5, nullif(btrim($6), ''), $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16)
     RETURNING id`,
    [
      n.chave,
      n.doseId,
      n.prescricaoId,
      n.idosoId,
      n.resultado,
      n.motivo ?? "",
      n.adiadaPara,
      n.lote?.id ?? null,
      n.quantidade,
      ator.usuarioId,
      ator.dispositivoId,
      n.ocorridaEm,
      n.registradaEm,
      n.metodo,
      n.foraDaJanela,
      n.liberadaPor,
    ],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("INSERT de administração não devolveu a linha.");

  let saldoDoLote: number | null = null;
  if (n.resultado === "administrada" && n.lote && n.quantidade !== null) {
    await consumirParaAdministracao(c, {
      loteId: n.lote.id,
      quantidade: n.quantidade,
      administracaoId: id,
      usuarioId: ator.usuarioId,
      em: n.registradaEm,
    });
    const s = await c.query<{ saldo: string }>(
      "SELECT saldo::text AS saldo FROM saldo_lote WHERE lote_id = $1",
      [n.lote.id],
    );
    saldoDoLote = Number(s.rows[0]?.saldo ?? 0);
  }
  if (n.excecao) {
    await c.query(
      `INSERT INTO excecao_conferencia (casa_id, administracao_id, motivo, liberada_por, justificativa, criada_em)
       VALUES (app_casa_id(), $1, $2, $3, btrim($4), $5)`,
      [id, n.excecao.motivo, n.excecao.liberadaPor, n.excecao.justificativa, n.registradaEm],
    );
  }
  if (n.validadorId) {
    await c.query(
      `INSERT INTO segunda_validacao (casa_id, administracao_id, validador_id, validada_em)
       VALUES (app_casa_id(), $1, $2, $3)`,
      [id, n.validadorId, n.registradaEm],
    );
  }
  await registrarAuditoria(c, {
    acao: n.metodo === "tardio" ? "administracao.registro_tardio" : "administracao.registrada",
    entidade: "administracao",
    entidadeId: id,
    depois: {
      doseId: n.doseId,
      prescricaoId: n.prescricaoId,
      idosoId: n.idosoId,
      resultado: n.resultado,
      metodo: n.metodo,
      loteId: n.lote?.id ?? null,
      quantidade: n.quantidade,
      ocorridaEm: n.ocorridaEm.toISOString(),
      foraDaJanela: n.foraDaJanela,
      liberadaPor: n.liberadaPor,
      excecaoLiberadaPor: n.excecao?.liberadaPor ?? null,
      validadorId: n.validadorId,
    },
    dispositivoId: ator.dispositivoId,
    ip,
  });
  return { id, saldoDoLote };
}

/** Bloqueio na conferência fica na trilha: idoso ou remédio errado é um quase-erro a estudar. */
export async function auditarBloqueio(
  c: PoolClient,
  ator: SessaoAutenticada,
  alvo: { entidade: "dose_agendada" | "prescricao"; id: string },
  bloqueios: Bloqueio[],
  ip: string | null | undefined,
): Promise<void> {
  await registrarAuditoria(c, {
    acao: "administracao.bloqueada",
    entidade: alvo.entidade,
    entidadeId: alvo.id,
    depois: { codigos: bloqueios.map((b) => b.codigo) },
    dispositivoId: ator.dispositivoId,
    ip,
  });
}

/** Administração já gravada com a mesma chave (reenvio da mesma tentativa). */
export async function registroDaChave(
  c: PoolClient,
  chave: string,
): Promise<{ id: string; doseId: string | null; prescricaoId: string; resultado: string } | null> {
  const r = await c.query<{
    id: string;
    dose_agendada_id: string | null;
    prescricao_id: string;
    resultado: string;
  }>("SELECT id, dose_agendada_id, prescricao_id, resultado FROM administracao WHERE chave = $1", [
    chave,
  ]);
  const a = r.rows[0];
  return a
    ? {
        id: a.id,
        doseId: a.dose_agendada_id,
        prescricaoId: a.prescricao_id,
        resultado: a.resultado,
      }
    : null;
}

export function ehViolacaoDaDoseUnica(erro: unknown): boolean {
  const e = erro as { code?: string; constraint?: string } | null;
  return e?.code === "23505" && e.constraint === "administracao_final_unica";
}
