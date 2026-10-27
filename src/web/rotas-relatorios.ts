import { z } from "zod";
import {
  consultarAuditoria,
  csvDaAuditoria,
  csvDeExcecoes,
  exportarAuditoria,
  exportarDadosDoIdoso,
  pdfDaAuditoria,
  pdfDeExcecoes,
  relatorioDeExcecoes,
  verificarAuditoria,
  type FiltroDeAuditoria,
} from "@/modules/relatorios";
import { json, lerCorpo } from "./http";
import { respostaDeFalha, sessaoDe, uuidDaRota, type Rota } from "./rota";

// Gestão: trilha de auditoria, relatório de exceções e exportação dos dados de um residente.
// Tudo só do gestor. O que leva dados para fora do sistema (PDF, planilha, arquivo do residente)
// pede a senha de novo e deixa rastro na trilha.

const data = z.string().max(10);
const filtro = z
  .object({
    de: data.optional(),
    ate: data.optional(),
    usuarioId: z.string().max(40).optional(),
    acao: z.string().max(80).optional(),
    entidade: z.string().max(60).optional(),
    entidadeId: z.string().max(80).optional(),
  })
  .strict();

function arquivo(corpo: BodyInit, tipo: string, nome: string): Response {
  return new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": tipo,
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Parâmetros opcionais da URL, sem string vazia. */
function parametro(q: URLSearchParams, nome: string): string | undefined {
  const v = q.get(nome);
  return v === null || v === "" ? undefined : v;
}

export const ROTAS_RELATORIOS: Rota[] = [
  {
    metodo: "GET",
    caminho: "/admin/auditoria",
    acesso: "sessao",
    permissao: "auditoria.ver",
    async tratar(ctx) {
      const q = new URL(ctx.request.url).searchParams;
      const f: FiltroDeAuditoria = {
        de: parametro(q, "de"),
        ate: parametro(q, "ate"),
        usuarioId: parametro(q, "usuarioId"),
        acao: parametro(q, "acao"),
        entidade: parametro(q, "entidade"),
        entidadeId: parametro(q, "entidadeId"),
      };
      const pagina = parametro(q, "antesDeSeq");
      const limite = parametro(q, "limite");
      const r = await consultarAuditoria(ctx.servico, sessaoDe(ctx), {
        ...f,
        antesDeSeq: pagina === undefined ? undefined : Number(pagina),
        limite: limite === undefined ? undefined : Number(limite),
      });
      return r.ok
        ? json({ registros: r.registros, proximaPagina: r.proximaPagina })
        : respostaDeFalha(r);
    },
  },
  {
    metodo: "GET",
    caminho: "/admin/auditoria/verificar",
    acesso: "sessao",
    permissao: "auditoria.ver",
    async tratar(ctx) {
      return json({ verificacao: await verificarAuditoria(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/auditoria/exportar",
    acesso: "sessao",
    permissao: "auditoria.ver",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z.object({ formato: z.enum(["pdf", "csv"]), filtro: filtro.optional() }).strict(),
      );
      const r = await exportarAuditoria(ctx.servico, sessaoDe(ctx), {
        filtro: corpo.filtro,
        formato: corpo.formato,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return corpo.formato === "pdf"
        ? arquivo(
            Buffer.from(await pdfDaAuditoria(r.exportacao)),
            "application/pdf",
            "auditoria.pdf",
          )
        : arquivo(csvDaAuditoria(r.exportacao), "text/csv; charset=utf-8", "auditoria.csv");
    },
  },
  {
    metodo: "GET",
    caminho: "/admin/relatorios/excecoes",
    acesso: "sessao",
    permissao: "relatorio_excecoes.ver",
    async tratar(ctx) {
      const q = new URL(ctx.request.url).searchParams;
      const r = await relatorioDeExcecoes(ctx.servico, sessaoDe(ctx), {
        de: parametro(q, "de"),
        ate: parametro(q, "ate"),
      });
      return r.ok ? json({ relatorio: r.relatorio }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/relatorios/excecoes/exportar",
    acesso: "sessao",
    permissao: "relatorio_excecoes.ver",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({ formato: z.enum(["pdf", "csv"]), de: data.optional(), ate: data.optional() })
          .strict(),
      );
      const r = await relatorioDeExcecoes(ctx.servico, sessaoDe(ctx), {
        de: corpo.de,
        ate: corpo.ate,
        exportacao: { formato: corpo.formato, ip: ctx.ip },
      });
      if (!r.ok) return respostaDeFalha(r);
      return corpo.formato === "pdf"
        ? arquivo(
            Buffer.from(await pdfDeExcecoes(r.relatorio)),
            "application/pdf",
            "excecoes-de-conferencia.pdf",
          )
        : arquivo(
            csvDeExcecoes(r.relatorio),
            "text/csv; charset=utf-8",
            "excecoes-de-conferencia.csv",
          );
    },
  },
  {
    // POST: pede a senha de novo e fica na trilha. O arquivo é JSON, que é o formato de
    // portabilidade (legível por máquina e por gente).
    metodo: "POST",
    caminho: "/admin/idosos/:id/exportacao",
    acesso: "sessao",
    permissao: "lgpd.exportar",
    async tratar(ctx) {
      await lerCorpo(ctx.request, z.object({}).strict());
      const r = await exportarDadosDoIdoso(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return arquivo(
        JSON.stringify(r.exportacao, null, 2),
        "application/json; charset=utf-8",
        "dados-do-residente.json",
      );
    },
  },
];
