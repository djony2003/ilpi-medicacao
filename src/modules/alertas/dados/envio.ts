import { comContexto } from "@/compartilhado/banco/transacao";
import type { Correio } from "@/compartilhado/correio";
import { relogio } from "@/compartilhado/servico";
import { montarEmail } from "../dominio/email";
import { registrarExecucao, type ServicoDeAlertas } from "./verificacao";

// Envio dos e-mails enfileirados (spec 6.5). Novas tentativas com espera crescente; depois da
// última, o envio fica como "falhou" (aparece no painel do sistema, e o alerta continua no
// painel da casa: o e-mail é um aviso a mais, nunca o único caminho).
//
// `FOR UPDATE SKIP LOCKED`: duas cópias do agendador nunca pegam o mesmo envio.

/** Espera antes de cada nova tentativa, em minutos. */
export const ESPERAS_MIN = [1, 5, 15, 60, 180];
export const MAXIMO_DE_TENTATIVAS = ESPERAS_MIN.length + 1;
const LOTE = 50;

export type ResultadoDoEnvio = {
  enviados: number;
  falhas: number;
  desistencias: number;
  descartados: number;
};

export async function enviarAlertasDaCasa(
  servico: ServicoDeAlertas,
  casaId: string,
  correio: Correio,
  linkDoPainel: string,
): Promise<ResultadoDoEnvio> {
  const agora = relogio(servico);
  const inicio = Date.now();
  return comContexto(servico.pool, { casaId }, async (c) => {
    const r: ResultadoDoEnvio = { enviados: 0, falhas: 0, desistencias: 0, descartados: 0 };
    const casa = await c.query<{ nome: string }>("SELECT nome FROM casa WHERE id = app_casa_id()");
    const casaNome = casa.rows[0]?.nome ?? "casa";
    const pendentes = await c.query<{
      id: string;
      motivo: "novo" | "agravado" | "reaviso" | "escalonamento";
      tentativas: number;
      estado_alerta: string;
      gravidade: "aviso" | "urgente";
      email: string | null;
      nome: string;
      ativo: boolean;
    }>(
      `SELECT e.id, e.motivo, e.tentativas, a.estado AS estado_alerta, a.gravidade,
              u.email, u.nome, u.ativo
         FROM envio_alerta e
         JOIN alerta a ON a.id = e.alerta_id
         JOIN usuario u ON u.id = e.usuario_id
        WHERE e.estado = 'pendente' AND e.proxima_em <= $1
        ORDER BY e.seq
        LIMIT ${LOTE}
        FOR UPDATE OF e SKIP LOCKED`,
      [agora],
    );
    for (const p of pendentes.rows) {
      // Alerta já resolvido, ou pessoa que saiu da casa ou não tem e-mail: não envia.
      if (p.estado_alerta !== "aberto" || !p.ativo || !p.email) {
        await c.query("UPDATE envio_alerta SET estado = 'descartado' WHERE id = $1", [p.id]);
        r.descartados += 1;
        continue;
      }
      const m = montarEmail({
        motivo: p.motivo,
        gravidade: p.gravidade,
        casaNome,
        nomeDestinatario: p.nome,
        linkDoPainel,
      });
      try {
        await correio.enviar({ para: p.email, ...m });
        await c.query(
          `UPDATE envio_alerta SET estado = 'enviado', enviado_em = $2, tentativas = tentativas + 1
            WHERE id = $1`,
          [p.id, agora],
        );
        r.enviados += 1;
      } catch (erro) {
        const tentativas = p.tentativas + 1;
        const desistir = tentativas >= MAXIMO_DE_TENTATIVAS;
        const espera = ESPERAS_MIN[Math.min(tentativas - 1, ESPERAS_MIN.length - 1)] ?? 180;
        // Só o tipo do erro: a mensagem do servidor de e-mail pode trazer o endereço.
        const tipo = (erro instanceof Error ? erro.name : "Erro").slice(0, 200);
        await c.query(
          `UPDATE envio_alerta
              SET tentativas = $2, ultimo_erro = $3, estado = $4, proxima_em = $5
            WHERE id = $1`,
          [
            p.id,
            tentativas,
            tipo,
            desistir ? "falhou" : "pendente",
            new Date(agora.getTime() + espera * 60_000),
          ],
        );
        if (desistir) r.desistencias += 1;
        else r.falhas += 1;
      }
    }
    if (pendentes.rows.length > 0) {
      await registrarExecucao(c, "enviar_alertas", agora, Date.now() - inicio, r);
    }
    return r;
  });
}
