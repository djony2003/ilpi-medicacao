import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import {
  configuracaoDeAlertas,
  problemasDaConfiguracao,
  type ConfiguracaoDeAlertas,
} from "../dominio/configuracao";

// Limites dos alertas da casa (spec 6.4: "padrões configuráveis por casa"). Só o gestor muda, com
// a senha confirmada; a mudança fica na trilha com o antes e o depois.

const contexto = (ator: SessaoAutenticada) => ({ casaId: ator.casaId, usuarioId: ator.usuarioId });

export async function obterConfiguracaoDeAlertas(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<ConfiguracaoDeAlertas> {
  exigirPermissao(ator.perfil, "alertas.ver");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ configuracoes: unknown }>(
      "SELECT configuracoes FROM casa WHERE id = app_casa_id()",
    );
    return configuracaoDeAlertas(r.rows[0]?.configuracoes ?? {});
  });
}

export async function configurarAlertas(
  servico: Servico,
  ator: SessaoAutenticada,
  e: Partial<ConfiguracaoDeAlertas> & { ip?: string | null },
): Promise<{ ok: true; configuracao: ConfiguracaoDeAlertas } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "configuracoes.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);
  const { ip, ...mudancas } = e;
  const problemas = problemasDaConfiguracao(mudancas);
  if (problemas.length > 0) return dadosInvalidos(...problemas);

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ configuracoes: Record<string, unknown> | null }>(
      "SELECT configuracoes FROM casa WHERE id = app_casa_id() FOR UPDATE",
    );
    const atuais = r.rows[0]?.configuracoes ?? {};
    const antes = configuracaoDeAlertas(atuais);
    const depois = configuracaoDeAlertas({ ...atuais, alertas: { ...antes, ...mudancas } });
    // A leitura (configuracaoDeAlertas) ajustaria em silêncio; aqui o gestor precisa saber.
    if (
      (mudancas.estoqueUrgenteDias ?? antes.estoqueUrgenteDias) >
        (mudancas.estoqueAvisoDias ?? antes.estoqueAvisoDias) ||
      (mudancas.validadeUrgenteDias ?? antes.validadeUrgenteDias) >
        (mudancas.validadeAvisoDias ?? antes.validadeAvisoDias)
    ) {
      return dadosInvalidos("O prazo do urgente precisa ser menor ou igual ao do aviso.");
    }
    await c.query(
      `UPDATE casa SET configuracoes = coalesce(configuracoes, '{}'::jsonb) || jsonb_build_object('alertas', $1::jsonb)
        WHERE id = app_casa_id()`,
      [JSON.stringify(depois)],
    );
    await registrarAuditoria(c, {
      acao: "configuracao.alertas_alterados",
      entidade: "casa",
      entidadeId: ator.casaId,
      antes,
      depois,
      dispositivoId: ator.dispositivoId,
      ip,
    });
    return { ok: true, configuracao: depois } as const;
  });
}
