import { z } from "zod";
import { log } from "@/compartilhado/log";
import {
  dadosDaFolhaDeContingencia,
  escalaDoPlantao,
  gerarDosesDaCasa,
  gerarPdfDaFolha,
  type PeriodoDaEscala,
} from "@/modules/administracao";
import { ErroHttp, json, lerCorpo } from "./http";
import { respostaDeFalha, sessaoDe, type Contexto, type Rota } from "./rota";

// Escala do plantão (tablet) e folha de contingência. Qualquer perfil com sessão completa vê.

const instante = z.iso.datetime({ offset: true });

function data(valor: string | null): Date | undefined {
  if (valor === null) return undefined;
  const r = instante.safeParse(valor);
  if (!r.success) throw new ErroHttp(400, "filtro_invalido");
  return new Date(r.data);
}

function periodoDaConsulta(request: Request): PeriodoDaEscala {
  const q = new URL(request.url).searchParams;
  return { de: data(q.get("de")), ate: data(q.get("ate")) };
}

/**
 * Depois de mudar uma prescrição ou voltar um idoso ao status ativo, gera as doses logo, sem
 * esperar a próxima rodada do agendador. A mudança já foi gravada; se a geração falhar, o
 * agendador completa na rodada seguinte, então a falha aqui não pode virar erro para quem prescreveu.
 */
export async function gerarEscalaAposMudanca(ctx: Contexto): Promise<void> {
  try {
    await gerarDosesDaCasa(ctx.servico, sessaoDe(ctx).casaId);
  } catch (erro) {
    log.error("geração imediata de doses falhou", {
      tipo: erro instanceof Error ? erro.name : "Erro",
    });
  }
}

export const ROTAS_ESCALA: Rota[] = [
  {
    metodo: "GET",
    caminho: "/escala",
    acesso: "sessao",
    permissao: "escala.ver",
    async tratar(ctx) {
      const r = await escalaDoPlantao(ctx.servico, sessaoDe(ctx), periodoDaConsulta(ctx.request));
      return r.ok ? json({ escala: r.escala }) : respostaDeFalha(r);
    },
  },
  {
    // POST: cada folha impressa é uma ação registrada na trilha. O PDF é a única saída.
    metodo: "POST",
    caminho: "/escala/folha-de-contingencia",
    acesso: "sessao",
    permissao: "escala.ver",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z.object({ de: instante.optional(), ate: instante.optional() }).strict(),
      );
      const r = await dadosDaFolhaDeContingencia(ctx.servico, sessaoDe(ctx), {
        de: corpo.de ? new Date(corpo.de) : undefined,
        ate: corpo.ate ? new Date(corpo.ate) : undefined,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      const pdf = await gerarPdfDaFolha(r.folha);
      return new Response(Buffer.from(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="folha-de-contingencia.pdf"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
];
