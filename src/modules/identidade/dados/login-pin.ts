import { comContexto, ehUuid } from "@/compartilhado/banco/transacao";
import { registrarAuditoria } from "@/modules/auditoria";
import type { Perfil } from "../dominio/permissoes";
import { POLITICA } from "../dominio/politica";
import { TAMANHO_PIN } from "../dominio/pin";
import { localizarDispositivo } from "./dispositivo";
import { gastarTempoDeVerificacao, verificarSenhaHash } from "./hash-senha";
import { relogio, type Servico } from "./servico";
import { criarSessao } from "./sessao";
import { carregarUsuarioTravado, estaBloqueado, registrarFalha } from "./tentativas";

// Login por PIN no tablet aprovado. O que protege não é o PIN (6 dígitos são poucos) e sim:
//   1. só funciona num aparelho que um gestor aprovou e pode revogar a qualquer momento;
//   2. 5 erros bloqueiam a conta (o contador é o mesmo da senha e do segundo fator);
//   3. a sessão do tablet expira em 2 minutos de inatividade;
//   4. toda ação fica auditada com usuário E aparelho.

const NEGADO = { ok: false, motivo: "credenciais_invalidas" } as const;

export type UsuarioDaLista = { id: string; nome: string; perfil: Perfil };

/** Lista quem pode tocar o PIN neste tablet. Exige o token do aparelho. */
export async function listarUsuariosParaPin(
  servico: Servico,
  tokenDoDispositivo: string,
): Promise<UsuarioDaLista[] | null> {
  const dispositivo = await localizarDispositivo(servico, tokenDoDispositivo);
  if (!dispositivo) return null;
  return comContexto(servico.pool, { casaId: dispositivo.casaId }, async (c) => {
    const r = await c.query<UsuarioDaLista>(
      `SELECT id, nome, perfil FROM usuario
        WHERE ativo AND pin_hash IS NOT NULL
        ORDER BY nome`,
    );
    return r.rows;
  });
}

export type ResultadoDoPin =
  | {
      ok: true;
      token: string;
      /** O PIN foi definido por um gestor e precisa ser trocado antes de qualquer outra coisa. */
      pinTrocar: boolean;
      usuario: UsuarioDaLista;
    }
  | typeof NEGADO;

export async function entrarComPin(
  servico: Servico,
  entrada: { tokenDoDispositivo: string; usuarioId: string; pin: string; ip?: string | null },
): Promise<ResultadoDoPin> {
  const { tokenDoDispositivo, usuarioId, pin, ip } = entrada;

  if (!ehUuid(usuarioId) || !new RegExp(`^\\d{${TAMANHO_PIN}}$`).test(pin)) {
    await gastarTempoDeVerificacao(pin.slice(0, 32));
    return NEGADO;
  }
  const dispositivo = await localizarDispositivo(servico, tokenDoDispositivo);
  if (!dispositivo) {
    await gastarTempoDeVerificacao(pin);
    return NEGADO;
  }

  const agora = relogio(servico);
  return comContexto(
    servico.pool,
    { casaId: dispositivo.casaId, usuarioId },
    async (c): Promise<ResultadoDoPin> => {
      // Usuário de outra casa simplesmente não aparece aqui: o RLS esconde a linha.
      const u = await carregarUsuarioTravado(c, usuarioId);
      if (!u || !u.ativo || !u.casa_ativa || u.pin_hash === null) {
        await gastarTempoDeVerificacao(pin);
        if (u) {
          await registrarAuditoria(c, {
            acao: "login.recusado",
            entidade: "usuario",
            entidadeId: u.id,
            depois: { motivo: u.ativo ? "sem_pin" : "usuario_inativo" },
            dispositivoId: dispositivo.id,
            ip,
          });
        }
        return NEGADO;
      }

      if (estaBloqueado(u, agora)) {
        await gastarTempoDeVerificacao(pin);
        await registrarAuditoria(c, {
          acao: "login.bloqueado",
          entidade: "usuario",
          entidadeId: u.id,
          dispositivoId: dispositivo.id,
          ip,
        });
        return NEGADO;
      }

      if (!(await verificarSenhaHash(u.pin_hash, pin))) {
        await registrarFalha(c, u, agora, "login.pin_falha", {
          ip,
          dispositivoId: dispositivo.id,
        });
        return NEGADO;
      }

      await c.query(
        "UPDATE usuario SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1",
        [u.id],
      );
      // Um tablet, uma sessão: quem assume o posto encerra a sessão de quem estava antes.
      await c.query(
        "UPDATE sessao SET revogada_em = $2 WHERE dispositivo_id = $1 AND revogada_em IS NULL",
        [dispositivo.id, agora],
      );
      await c.query("UPDATE dispositivo SET ultimo_uso_em = $2 WHERE id = $1", [
        dispositivo.id,
        agora,
      ]);
      const token = await criarSessao(c, {
        casaId: dispositivo.casaId,
        usuarioId: u.id,
        dispositivoId: dispositivo.id,
        tipo: "tablet",
        // O aparelho aprovado é o "segundo fator" do tablet.
        mfaOk: true,
        duracaoMs: POLITICA.tablet.duracaoMaximaMs,
        inatividadeSegundos: POLITICA.tablet.inatividadeSegundos,
        ip,
        agora,
      });
      await registrarAuditoria(c, {
        acao: "login.pin_sucesso",
        entidade: "usuario",
        entidadeId: u.id,
        dispositivoId: dispositivo.id,
        ip,
      });
      return {
        ok: true,
        token,
        pinTrocar: u.pin_trocar,
        usuario: { id: u.id, nome: u.nome, perfil: u.perfil },
      };
    },
  );
}
