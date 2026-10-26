import type { PoolClient } from "pg";
import { ehUuid } from "@/compartilhado/banco/transacao";
import { registrarAuditoria } from "@/modules/auditoria";
import { podeExecutar, type Acao, type Perfil } from "../dominio/permissoes";
import { TAMANHO_PIN } from "../dominio/pin";
import { gastarTempoDeVerificacao, verificarSenhaHash } from "./hash-senha";
import { carregarUsuarioTravado, estaBloqueado, registrarFalha } from "./tentativas";

// Uma segunda pessoa se identifica com o próprio PIN no aparelho de quem está registrando: a
// segunda validação de alto risco, a exceção de conferência e a liberação de dose antecipada.
//
// Roda DENTRO da transação de quem chama, para que a identidade confirmada e o registro que ela
// autoriza sejam gravados juntos. Na falha, quem chama deve devolver a falha sem gravar mais
// nada: o contador de erros (o mesmo do login) é gravado no COMMIT, e é isso que impede chutar o
// PIN de um colega pelo tablet.

export type PessoaConfirmada = { usuarioId: string; nome: string; perfil: Perfil };

export type ResultadoDaConfirmacao =
  | { ok: true; pessoa: PessoaConfirmada }
  /** PIN errado, pessoa inexistente, inativa, de outra casa ou bloqueada: tudo igual por fora. */
  | { ok: false; motivo: "pin_invalido" }
  /** A pessoa existe e o PIN confere, mas o perfil dela não pode fazer esta ação. */
  | { ok: false; motivo: "perfil_nao_autorizado" };

export async function confirmarPinDeOutraPessoa(
  c: PoolClient,
  entrada: {
    usuarioId: string;
    pin: string;
    acao: Acao;
    agora: Date;
    dispositivoId?: string | null;
    ip?: string | null;
  },
): Promise<ResultadoDaConfirmacao> {
  const { usuarioId, pin, acao, agora } = entrada;
  const extra = { dispositivoId: entrada.dispositivoId ?? null, ip: entrada.ip ?? null };
  if (!ehUuid(usuarioId) || !new RegExp(`^\\d{${TAMANHO_PIN}}$`).test(pin)) {
    await gastarTempoDeVerificacao(pin.slice(0, 32));
    return { ok: false, motivo: "pin_invalido" };
  }
  // O RLS da transação esconde gente de outra casa: ela simplesmente não existe aqui.
  const u = await carregarUsuarioTravado(c, usuarioId);
  if (!u || !u.ativo || !u.casa_ativa || u.pin_hash === null || estaBloqueado(u, agora)) {
    await gastarTempoDeVerificacao(pin);
    return { ok: false, motivo: "pin_invalido" };
  }
  if (!(await verificarSenhaHash(u.pin_hash, pin))) {
    await registrarFalha(c, u, agora, "confirmacao.pin_falha", extra);
    return { ok: false, motivo: "pin_invalido" };
  }
  await c.query(
    "UPDATE usuario SET tentativas_falhas = 0 WHERE id = $1 AND tentativas_falhas > 0",
    [u.id],
  );
  if (!podeExecutar(u.perfil, acao)) {
    await registrarAuditoria(c, {
      acao: "confirmacao.perfil_recusado",
      entidade: "usuario",
      entidadeId: u.id,
      depois: { acao },
      ...extra,
    });
    return { ok: false, motivo: "perfil_nao_autorizado" };
  }
  return { ok: true, pessoa: { usuarioId: u.id, nome: u.nome, perfil: u.perfil } };
}
