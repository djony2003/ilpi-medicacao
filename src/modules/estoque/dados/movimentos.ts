import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import type { UnidadeDeDose } from "@/modules/prescricoes";
import { emMilesimos, problemaDeQuantidade, somar } from "../dominio/quantidade";
import { MOTIVOS_DE_SAIDA, problemaDeMotivo, type TipoDeSaidaManual } from "../dominio/validacao";
import { traduzirSaldoInsuficiente } from "./saldo";

// Saídas e correções de estoque lançadas à mão: perda, descarte, devolução e ajuste. O consumo
// por administração NÃO passa por aqui (vem do registro da dose, no M5).
//
// São ações sensíveis: pedem a senha ou o PIN de novo (spec 7.2), exigem motivo e ficam na
// auditoria. O que sai do estoque sem rastro é exatamente o que uma casa precisa conseguir provar.

export type SaidaManual = {
  loteId: string;
  tipo: TipoDeSaidaManual;
  /**
   * Perda, descarte e devolução: quanto SAIU (positivo). Ajuste: a diferença com sinal
   * (positivo acrescenta, negativo retira). Pode faltar no descarte quando `descartarTudo`.
   */
  quantidade?: number;
  /** Só no descarte: tira todo o saldo do lote (lote vencido, frasco inteiro). */
  descartarTudo?: boolean;
  motivo: string;
  ip?: string | null;
};

export type ResultadoDaSaida =
  | { ok: true; movimentoId: string; quantidade: number; saldo: number }
  | Falha<"dados_invalidos" | "nao_encontrado" | "saldo_insuficiente">;

export async function lancarSaida(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: SaidaManual,
): Promise<ResultadoDaSaida> {
  exigirPermissao(ator.perfil, "estoque.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);

  if (!MOTIVOS_DE_SAIDA.includes(entrada.tipo))
    return dadosInvalidos("Tipo de movimento inválido.");
  const problemaMotivo = problemaDeMotivo(entrada.motivo);
  if (problemaMotivo) return dadosInvalidos(problemaMotivo);
  if (entrada.descartarTudo && entrada.tipo !== "descarte") {
    return dadosInvalidos("Só o descarte pode tirar o lote inteiro de uma vez.");
  }
  if (entrada.descartarTudo && entrada.quantidade !== undefined) {
    return dadosInvalidos(
      "Informe a quantidade ou marque o descarte do lote inteiro, não os dois.",
    );
  }
  if (!entrada.descartarTudo && entrada.quantidade === undefined) {
    return dadosInvalidos("Informe a quantidade.");
  }

  return traduzirSaldoInsuficiente(() =>
    comContexto(servico.pool, { casaId: ator.casaId, usuarioId: ator.usuarioId }, async (c) => {
      const r = await c.query<{ unidade: UnidadeDeDose; saldo: string }>(
        `SELECT l.unidade, s.saldo::text AS saldo
           FROM lote_estoque l JOIN saldo_lote s ON s.lote_id = l.id AND s.casa_id = l.casa_id
          WHERE l.id = $1`,
        [entrada.loteId],
      );
      const lote = r.rows[0];
      if (!lote) return falha("nao_encontrado");
      const saldoAntes = Number(lote.saldo);

      const informada = entrada.descartarTudo ? saldoAntes : (entrada.quantidade ?? 0);
      const problema = problemaDeQuantidade(informada, lote.unidade, {
        permitirNegativa: entrada.tipo === "ajuste",
      });
      if (problema) {
        return entrada.descartarTudo
          ? dadosInvalidos("O lote já está sem saldo para descartar.")
          : dadosInvalidos(problema);
      }
      const efeito = entrada.tipo === "ajuste" ? informada : -informada;
      if (emMilesimos(saldoAntes) + emMilesimos(efeito) < 0) return falha("saldo_insuficiente");

      const mov = await c.query<{ id: string }>(
        `INSERT INTO movimento_estoque (casa_id, lote_id, tipo, quantidade, motivo, usuario_id, criado_em)
         VALUES (app_casa_id(), $1, $2, $3, btrim($4), $5, $6) RETURNING id`,
        [entrada.loteId, entrada.tipo, efeito, entrada.motivo, ator.usuarioId, agora],
      );
      const movimentoId = mov.rows[0]?.id ?? "";
      const saldo = somar(saldoAntes, efeito);
      await registrarAuditoria(c, {
        acao: `estoque.${entrada.tipo}`,
        entidade: "lote_estoque",
        entidadeId: entrada.loteId,
        antes: { saldo: saldoAntes },
        depois: { saldo, quantidade: efeito, motivo: entrada.motivo.trim() },
        ip: entrada.ip,
      });
      return { ok: true, movimentoId, quantidade: efeito, saldo } as const;
    }),
  );
}
