import { z } from "zod";
import {
  STATUS_IDOSO,
  adicionarAlergia,
  adicionarContato,
  cadastrarIdoso,
  desativarAlergia,
  desativarContato,
  editarIdoso,
  emitirPulseira,
  GRAVIDADES,
  gerarPdfDaPulseira,
  listarIdosos,
  localizarPorPulseira,
  mudarStatusDoIdoso,
  obterIdoso,
  regenerarPulseira,
  revelarDadosSensiveis,
  type StatusIdoso,
} from "@/modules/idosos";
import { ErroHttp, json, lerCorpo } from "./http";
import { respostaDeFalha, sessaoDe, texto, uuidDaRota, type Rota } from "./rota";

// Rotas do cadastro de idosos. Todas exigem sessão completa; a permissão é conferida pelo
// despachante antes de ler o corpo e de novo dentro das funções do módulo.

const alergia = z
  .object({
    substancia: texto(200),
    gravidade: z.enum(GRAVIDADES),
    observacao: z.string().max(500).optional(),
  })
  .strict();

const contato = z
  .object({
    nome: texto(200),
    parentesco: texto(100),
    telefone: texto(40),
    responsavelLegal: z.boolean().optional(),
  })
  .strict();

const novoIdoso = z
  .object({
    nome: texto(200),
    dataNascimento: texto(10),
    cpf: z.string().max(20).optional(),
    quarto: z.string().max(50).optional(),
    alergias: z.array(alergia).max(50).optional(),
    contatos: z.array(contato).max(20).optional(),
  })
  .strict();

const edicao = z
  .object({
    nome: texto(200).optional(),
    dataNascimento: texto(10).optional(),
    cpf: z.string().max(20).nullable().optional(),
    quarto: z.string().max(50).nullable().optional(),
  })
  .strict();

function statusDoFiltro(ctx: { request: Request }): StatusIdoso | undefined {
  const valor = new URL(ctx.request.url).searchParams.get("status");
  if (valor === null) return undefined;
  const status = STATUS_IDOSO.find((s) => s === valor);
  if (!status) throw new ErroHttp(400, "filtro_invalido");
  return status;
}

export const ROTAS_IDOSOS: Rota[] = [
  {
    metodo: "GET",
    caminho: "/idosos",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const idosos = await listarIdosos(ctx.servico, sessaoDe(ctx), {
        status: statusDoFiltro(ctx),
      });
      return json({ idosos });
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(ctx.request, novoIdoso);
      const r = await cadastrarIdoso(ctx.servico, sessaoDe(ctx), { ...entrada, ip: ctx.ip });
      if (!r.ok) return respostaDeFalha(r);
      return json({ ok: true, idosoId: r.idosoId }, 201);
    },
  },
  {
    metodo: "GET",
    caminho: "/idosos/:id",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const r = await obterIdoso(ctx.servico, sessaoDe(ctx), uuidDaRota(ctx, "id"));
      return r.ok ? json({ idoso: r.idoso }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/editar",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(ctx.request, edicao);
      const r = await editarIdoso(ctx.servico, sessaoDe(ctx), {
        ...entrada,
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true, camposAlterados: r.camposAlterados }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/status",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const { status } = await lerCorpo(
        ctx.request,
        z.object({ status: z.enum(STATUS_IDOSO) }).strict(),
      );
      const r = await mudarStatusDoIdoso(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        status,
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
  {
    // POST e não GET: ler o CPF por extenso é uma ação registrada, não uma consulta qualquer.
    metodo: "POST",
    caminho: "/idosos/:id/dados-sensiveis",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const r = await revelarDadosSensiveis(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ cpf: r.cpf, telefones: r.telefones }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/alergias",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(ctx.request, alergia);
      const r = await adicionarAlergia(ctx.servico, sessaoDe(ctx), {
        ...entrada,
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true, alergiaId: r.alergiaId }, 201) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/alergias/:alergiaId/desativar",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const r = await desativarAlergia(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        alergiaId: uuidDaRota(ctx, "alergiaId"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/contatos",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(ctx.request, contato);
      const r = await adicionarContato(ctx.servico, sessaoDe(ctx), {
        ...entrada,
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true, contatoId: r.contatoId }, 201) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/contatos/:contatoId/desativar",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const r = await desativarContato(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        contatoId: uuidDaRota(ctx, "contatoId"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/pulseira/regenerar",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const { motivo } = await lerCorpo(
        ctx.request,
        z.object({ motivo: z.string().max(300) }).strict(),
      );
      const r = await regenerarPulseira(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        motivo,
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
  {
    // POST: cada impressão é uma ação registrada na trilha. O PDF é a única saída do código.
    metodo: "POST",
    caminho: "/idosos/:id/pulseira/emitir",
    acesso: "sessao",
    permissao: "idoso.gerir",
    async tratar(ctx) {
      const r = await emitirPulseira(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      const pdf = await gerarPdfDaPulseira(r.pulseira);
      return new Response(Buffer.from(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="identificacao.pdf"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
  {
    // Leitura da pulseira no tablet: qualquer perfil que veja a escala.
    metodo: "POST",
    caminho: "/pulseira/localizar",
    acesso: "sessao",
    permissao: "escala.ver",
    async tratar(ctx) {
      const { leitura } = await lerCorpo(
        ctx.request,
        z.object({ leitura: z.string().max(200) }).strict(),
      );
      const r = await localizarPorPulseira(ctx.servico, sessaoDe(ctx), leitura);
      return r.ok ? json({ idoso: r.idoso }) : respostaDeFalha(r);
    },
  },
];
