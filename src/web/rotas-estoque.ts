import { z } from "zod";
import { ehUuid } from "@/compartilhado/banco/transacao";
import {
  MOTIVOS_DE_SAIDA,
  cancelarInventario,
  concluirInventario,
  emitirEtiqueta,
  fracionarLote,
  gerarPdfDaEtiqueta,
  gerarPdfDaReposicao,
  iniciarInventario,
  lancarSaida,
  listaDeReposicao,
  listarInventarios,
  listarLotes,
  listarSobras,
  obterInventario,
  obterLote,
  registrarContagem,
  registrarEntrada,
  situacaoDoEstoque,
} from "@/modules/estoque";
import { UNIDADES } from "@/modules/prescricoes";
import { ErroHttp, json, lerCorpo } from "./http";
import { respostaDeFalha, sessaoDe, uuidDaRota, type Contexto, type Rota } from "./rota";

// Estoque: lotes, etiquetas, saídas, situação por idoso e medicamento, reposição, sobras e
// inventário. Todas as rotas exigem `estoque.gerir` (enfermeiro e gestor), conferida pelo
// despachante antes de ler o corpo e de novo dentro das funções do módulo.

const uuid = z.string().max(40).refine(ehUuid, "identificador inválido");
const quantidade = z.number().finite();

/** Parâmetro de consulta que, se vier, precisa ser um identificador. */
function filtroUuid(ctx: Contexto, nome: string): string | undefined {
  const v = new URL(ctx.request.url).searchParams.get(nome);
  if (v === null || v === "") return undefined;
  if (!ehUuid(v)) throw new ErroHttp(400, "filtro_invalido");
  return v;
}

function inteiroDaConsulta(ctx: Contexto, nome: string, min: number, max: number) {
  const v = new URL(ctx.request.url).searchParams.get(nome);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroHttp(400, "filtro_invalido");
  return n;
}

const marcado = (ctx: Contexto, nome: string): boolean =>
  new URL(ctx.request.url).searchParams.get(nome) === "1";

function respostaPdf(bytes: Uint8Array, arquivo: string): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${arquivo}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const parametrosDeReposicao = z
  .object({
    coberturaDias: z.number().int().min(1).max(365).optional(),
    diasParaRepor: z.number().int().min(0).max(90).optional(),
  })
  .strict();

export const ROTAS_ESTOQUE: Rota[] = [
  // ---------------------------------------------------------------- lotes
  {
    metodo: "GET",
    caminho: "/estoque/lotes",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const destino = new URL(ctx.request.url).searchParams.get("destino");
      if (destino !== null && destino !== "comum" && destino !== "individual") {
        throw new ErroHttp(400, "filtro_invalido");
      }
      const lotes = await listarLotes(ctx.servico, sessaoDe(ctx), {
        medicamentoId: filtroUuid(ctx, "medicamentoId"),
        idosoId: filtroUuid(ctx, "idosoId"),
        destino: destino ?? undefined,
        incluirZerados: marcado(ctx, "zerados"),
        venceEmDias: inteiroDaConsulta(ctx, "venceEmDias", 0, 3650),
      });
      return json({ lotes });
    },
  },
  {
    metodo: "POST",
    caminho: "/estoque/lotes",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z
          .object({
            medicamentoId: uuid,
            idosoId: uuid.nullable().optional(),
            numeroLote: z.string().max(80),
            validade: z.string().max(10),
            unidade: z.enum(UNIDADES),
            quantidade,
            observacao: z.string().max(400).nullable().optional(),
          })
          .strict(),
      );
      const r = await registrarEntrada(ctx.servico, sessaoDe(ctx), { ...entrada, ip: ctx.ip });
      if (!r.ok) return respostaDeFalha(r);
      return json({ ok: true, loteId: r.loteId }, 201);
    },
  },
  {
    metodo: "GET",
    caminho: "/estoque/lotes/:id",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const r = await obterLote(ctx.servico, sessaoDe(ctx), uuidDaRota(ctx, "id"));
      return r.ok ? json({ lote: r.lote }) : respostaDeFalha(r);
    },
  },
  {
    // POST: cada impressão e reimpressão é uma ação registrada. O PDF é a única saída do código.
    metodo: "POST",
    caminho: "/estoque/lotes/:id/etiqueta",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const { copias } = await lerCorpo(
        ctx.request,
        z.object({ copias: z.number().int().min(1).max(20).optional() }).strict(),
      );
      const r = await emitirEtiqueta(ctx.servico, sessaoDe(ctx), {
        loteId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return respostaPdf(await gerarPdfDaEtiqueta(r.etiqueta, copias ?? 1), "etiqueta-do-lote.pdf");
    },
  },
  {
    metodo: "POST",
    caminho: "/estoque/lotes/:id/fracionar",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            quantidade,
            destinoIdosoId: uuid.nullable().optional(),
            observacao: z.string().max(400).nullable().optional(),
          })
          .strict(),
      );
      const r = await fracionarLote(ctx.servico, sessaoDe(ctx), {
        loteId: uuidDaRota(ctx, "id"),
        ...corpo,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json({ ok: true, loteId: r.loteId }, 201);
    },
  },
  {
    // Perda, descarte, devolução e ajuste: pedem a senha ou o PIN de novo (spec 7.2).
    metodo: "POST",
    caminho: "/estoque/lotes/:id/saidas",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            tipo: z.enum(MOTIVOS_DE_SAIDA),
            quantidade: quantidade.optional(),
            descartarTudo: z.boolean().optional(),
            motivo: z.string().max(600),
          })
          .strict(),
      );
      const r = await lancarSaida(ctx.servico, sessaoDe(ctx), {
        loteId: uuidDaRota(ctx, "id"),
        ...corpo,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json(
        { ok: true, movimentoId: r.movimentoId, quantidade: r.quantidade, saldo: r.saldo },
        201,
      );
    },
  },

  // ---------------------------------------------------------------- situação e reposição
  {
    metodo: "GET",
    caminho: "/estoque/situacao",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const r = await situacaoDoEstoque(ctx.servico, sessaoDe(ctx), {
        idosoId: filtroUuid(ctx, "idosoId"),
        medicamentoId: filtroUuid(ctx, "medicamentoId"),
      });
      return json(r);
    },
  },
  {
    metodo: "GET",
    caminho: "/estoque/sobras",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      return json(await listarSobras(ctx.servico, sessaoDe(ctx)));
    },
  },
  {
    // POST: emitir a lista é uma exportação e fica registrada.
    metodo: "POST",
    caminho: "/estoque/lista-de-reposicao",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(ctx.request, parametrosDeReposicao);
      return json({
        lista: await listaDeReposicao(ctx.servico, sessaoDe(ctx), { ...corpo, ip: ctx.ip }),
      });
    },
  },
  {
    metodo: "POST",
    caminho: "/estoque/lista-de-reposicao/pdf",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(ctx.request, parametrosDeReposicao);
      const lista = await listaDeReposicao(ctx.servico, sessaoDe(ctx), { ...corpo, ip: ctx.ip });
      return respostaPdf(await gerarPdfDaReposicao(lista), "lista-de-reposicao.pdf");
    },
  },

  // ---------------------------------------------------------------- inventário
  {
    metodo: "GET",
    caminho: "/estoque/inventarios",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      return json({ inventarios: await listarInventarios(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/estoque/inventarios",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      await lerCorpo(ctx.request, z.object({}).strict());
      const r = await iniciarInventario(ctx.servico, sessaoDe(ctx), { ip: ctx.ip });
      if (!r.ok) return respostaDeFalha(r);
      return json({ ok: true, inventarioId: r.inventarioId, lotes: r.lotes }, 201);
    },
  },
  {
    metodo: "GET",
    caminho: "/estoque/inventarios/:id",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const r = await obterInventario(ctx.servico, sessaoDe(ctx), uuidDaRota(ctx, "id"));
      return r.ok ? json({ inventario: r.inventario }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/estoque/inventarios/:id/contagens",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z.object({ loteId: uuid, contado: quantidade }).strict(),
      );
      const r = await registrarContagem(ctx.servico, sessaoDe(ctx), {
        inventarioId: uuidDaRota(ctx, "id"),
        ...corpo,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json({
        ok: true,
        esperado: r.esperado,
        contado: r.contado,
        divergencia: r.divergencia,
      });
    },
  },
  {
    // Gera os ajustes de estoque: pede a senha ou o PIN de novo.
    metodo: "POST",
    caminho: "/estoque/inventarios/:id/concluir",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            justificativas: z.record(uuid, z.string().max(600)).default({}),
            aceitarNaoContados: z.boolean().optional(),
          })
          .strict(),
      );
      const r = await concluirInventario(ctx.servico, sessaoDe(ctx), {
        inventarioId: uuidDaRota(ctx, "id"),
        ...corpo,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json({ ok: true, ajustes: r.ajustes, naoContados: r.naoContados });
    },
  },
  {
    metodo: "POST",
    caminho: "/estoque/inventarios/:id/cancelar",
    acesso: "sessao",
    permissao: "estoque.gerir",
    async tratar(ctx) {
      await lerCorpo(ctx.request, z.object({}).strict());
      const r = await cancelarInventario(ctx.servico, sessaoDe(ctx), {
        inventarioId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
];
