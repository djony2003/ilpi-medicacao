import { z } from "zod";
import {
  configurarAlertas,
  encerrarAlerta,
  listarAlertas,
  marcarComoLido,
  obterConfiguracaoDeAlertas,
  resumoDosAlertas,
} from "@/modules/alertas";
import { ErroHttp, json, lerCorpo } from "./http";
import { respostaDeFalha, sessaoDe, uuidDaRota, type Rota } from "./rota";

// Painel de alertas (enfermagem e gestão) e a configuração dos limites (gestão).

export const ROTAS_ALERTAS: Rota[] = [
  {
    metodo: "GET",
    caminho: "/alertas",
    acesso: "sessao",
    permissao: "alertas.ver",
    async tratar(ctx) {
      const q = new URL(ctx.request.url).searchParams;
      const estado = q.get("estado") ?? "aberto";
      if (estado !== "aberto" && estado !== "resolvido") throw new ErroHttp(400, "filtro_invalido");
      return json({ alertas: await listarAlertas(ctx.servico, sessaoDe(ctx), { estado }) });
    },
  },
  {
    metodo: "GET",
    caminho: "/alertas/resumo",
    acesso: "sessao",
    permissao: "alertas.ver",
    async tratar(ctx) {
      return json({ resumo: await resumoDosAlertas(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/alertas/:id/lido",
    acesso: "sessao",
    permissao: "alertas.ver",
    async tratar(ctx) {
      await lerCorpo(ctx.request, z.object({}).strict());
      const r = await marcarComoLido(ctx.servico, sessaoDe(ctx), {
        alertaId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true, fechado: r.fechado }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/alertas/:id/encerrar",
    acesso: "sessao",
    permissao: "alertas.ver",
    async tratar(ctx) {
      const { justificativa } = await lerCorpo(
        ctx.request,
        z.object({ justificativa: z.string().max(600) }).strict(),
      );
      const r = await encerrarAlerta(ctx.servico, sessaoDe(ctx), {
        alertaId: uuidDaRota(ctx, "id"),
        justificativa,
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "GET",
    caminho: "/admin/configuracoes/alertas",
    acesso: "sessao",
    permissao: "configuracoes.gerir",
    async tratar(ctx) {
      return json({ configuracao: await obterConfiguracaoDeAlertas(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/configuracoes/alertas",
    acesso: "sessao",
    permissao: "configuracoes.gerir",
    async tratar(ctx) {
      const inteiro = z.number().int().optional();
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            estoqueAvisoDias: inteiro,
            estoqueUrgenteDias: inteiro,
            prazoReposicaoDias: inteiro,
            validadeAvisoDias: inteiro,
            validadeUrgenteDias: inteiro,
            prescricaoAvisoDias: inteiro,
            escalonamentoHoras: inteiro,
            reavisoUrgenteHoras: inteiro,
            reavisoAvisoHoras: inteiro,
            excecoesRepetidas: inteiro,
            fimDosPlantoes: z.array(z.string().max(5)).max(6).optional(),
            emailParaAvisos: z.boolean().optional(),
          })
          .strict(),
      );
      const r = await configurarAlertas(ctx.servico, sessaoDe(ctx), { ...corpo, ip: ctx.ip });
      return r.ok ? json({ configuracao: r.configuracao }) : respostaDeFalha(r);
    },
  },
];
