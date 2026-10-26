import { comContexto } from "@/compartilhado/banco/transacao";
import { registrarAuditoria } from "@/modules/auditoria";
import { TAMANHO_MAXIMO_SENHA } from "../dominio/senha";
import { gastarTempoDeVerificacao, verificarSenhaHash } from "./hash-senha";
import { relogio, type Servico } from "./servico";
import type { SessaoAutenticada } from "./sessao";
import { carregarUsuarioTravado, estaBloqueado, registrarFalha } from "./tentativas";

// Confirmação de identidade antes de ação sensível: senha numa sessão web, PIN numa do tablet.
// Erros contam no mesmo contador do login. Vale por POLITICA.reautenticacaoMs.

export async function reautenticar(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { segredo: string; ip?: string | null },
): Promise<{ ok: true } | { ok: false }> {
  const { segredo, ip } = entrada;
  if (segredo.length === 0 || segredo.length > TAMANHO_MAXIMO_SENHA) {
    await gastarTempoDeVerificacao(segredo.slice(0, TAMANHO_MAXIMO_SENHA));
    return { ok: false };
  }
  const agora = relogio(servico);

  return comContexto(
    servico.pool,
    { casaId: ator.casaId, usuarioId: ator.usuarioId },
    async (c) => {
      const u = await carregarUsuarioTravado(c, ator.usuarioId);
      const guardado = ator.tipo === "tablet" ? u?.pin_hash : u?.senha_hash;
      if (!u || !u.ativo || !u.casa_ativa || !guardado || estaBloqueado(u, agora)) {
        await gastarTempoDeVerificacao(segredo);
        return { ok: false };
      }

      if (!(await verificarSenhaHash(guardado, segredo))) {
        await registrarFalha(c, u, agora, "reautenticacao.falha", {
          ip,
          dispositivoId: ator.dispositivoId,
        });
        return { ok: false };
      }

      await c.query("UPDATE sessao SET reautenticado_em = $2 WHERE id = $1", [
        ator.sessaoId,
        agora,
      ]);
      await registrarAuditoria(c, {
        acao: "sessao.reautenticada",
        entidade: "sessao",
        entidadeId: ator.sessaoId,
        dispositivoId: ator.dispositivoId,
        ip,
      });
      return { ok: true };
    },
  );
}
