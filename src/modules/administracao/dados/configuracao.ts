import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import { janelaDaCasa, type JanelaDaCasa } from "../dominio/estado";
import { contexto } from "./comum";

// Janela de tolerância da casa (spec 5.2), configurável pelo gestor. Mudar a janela muda o que é
// "no horário" para todas as doses dali em diante: pede a senha de novo e fica na auditoria.

export const LIMITES_DA_JANELA = {
  janelaMinutos: { min: 5, max: 120 },
  limiteMaiorMinutos: { min: 15, max: 360 },
} as const;

export async function obterJanela(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<JanelaDaCasa> {
  exigirPermissao(ator.perfil, "escala.ver");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ configuracoes: unknown }>(
      "SELECT configuracoes FROM casa WHERE id = app_casa_id()",
    );
    return janelaDaCasa(r.rows[0]?.configuracoes ?? {});
  });
}

export async function configurarJanela(
  servico: Servico,
  ator: SessaoAutenticada,
  e: { janelaMinutos: number; limiteMaiorMinutos: number; ip?: string | null },
): Promise<{ ok: true; janela: JanelaDaCasa } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "configuracoes.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);
  const problemas: string[] = [];
  const { janelaMinutos: j, limiteMaiorMinutos: l } = e;
  const L = LIMITES_DA_JANELA;
  if (!Number.isInteger(j) || j < L.janelaMinutos.min || j > L.janelaMinutos.max) {
    problemas.push(`A janela vai de ${L.janelaMinutos.min} a ${L.janelaMinutos.max} minutos.`);
  }
  if (!Number.isInteger(l) || l < L.limiteMaiorMinutos.min || l > L.limiteMaiorMinutos.max) {
    problemas.push(
      `O limite maior vai de ${L.limiteMaiorMinutos.min} a ${L.limiteMaiorMinutos.max} minutos.`,
    );
  }
  if (problemas.length === 0 && l <= j) {
    problemas.push("O limite maior precisa ser maior que a janela.");
  }
  if (problemas.length > 0) return dadosInvalidos(...problemas);

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const antes = await c.query<{ configuracoes: unknown }>(
      "SELECT configuracoes FROM casa WHERE id = app_casa_id() FOR UPDATE",
    );
    const anterior = janelaDaCasa(antes.rows[0]?.configuracoes ?? {});
    await c.query(
      `UPDATE casa
          SET configuracoes = coalesce(configuracoes, '{}'::jsonb)
                || jsonb_build_object('janelaMinutos', $1::int, 'limiteMaiorMinutos', $2::int)
        WHERE id = app_casa_id()`,
      [j, l],
    );
    await registrarAuditoria(c, {
      acao: "configuracao.janela_alterada",
      entidade: "casa",
      entidadeId: ator.casaId,
      antes: anterior,
      depois: { janelaMin: j, limiteMaiorMin: l },
      dispositivoId: ator.dispositivoId,
      ip: e.ip,
    });
    return { ok: true, janela: { janelaMin: j, limiteMaiorMin: l } } as const;
  });
}
