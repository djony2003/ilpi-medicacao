import { z } from "zod";
import {
  FORMAS,
  TIPOS,
  UNIDADES,
  VIAS,
  TAMANHO_MAXIMO_RECEITA,
  anexarReceita,
  cadastrarMedicamento,
  definirAltoRiscoDoMedicamento,
  desativarMedicamento,
  encerrarPrescricao,
  lerReceita,
  listarMedicamentos,
  listarReceitas,
  novaVersao,
  obterPrescricao,
  prescrever,
  prescricoesDoIdoso,
} from "@/modules/prescricoes";
import { ErroHttp, json, lerCorpo, lerCorpoBinario } from "./http";
import { gerarEscalaAposMudanca } from "./rotas-escala";
import { respostaDeFalha, sessaoDe, texto, uuidDaRota, type Rota } from "./rota";

// Rotas de medicamentos, prescrições e receitas. Todas exigem `prescricao.gerir`, conferida pelo
// despachante antes de ler o corpo e de novo dentro das funções do módulo.

const horario = z
  .object({ hora: z.string().max(5), diasSemana: z.array(z.number().int()).max(7).optional() })
  .strict();

const conteudo = z
  .object({
    medicamentoId: z.string().max(40),
    tipo: z.enum(TIPOS),
    dose: z.number().finite(),
    unidade: z.enum(UNIDADES),
    via: z.enum(VIAS),
    instrucoes: z.string().max(500).nullable().optional(),
    inicio: texto(10),
    fim: z.string().max(10).nullable().optional(),
    altoRisco: z.boolean(),
    horarios: z.array(horario).max(30),
    sos: z
      .object({
        indicacao: z.string().max(200),
        limiteDiario: z.number().int(),
        intervaloMinimoMin: z.number().int(),
      })
      .strict()
      .nullable()
      .optional(),
    prescritor: z.string().max(200).nullable().optional(),
  })
  .strict();

const novaPrescricao = conteudo
  .extend({ justificativaAlergia: z.string().max(500).optional() })
  .strict();

const TIPOS_DE_ARQUIVO = new Set(["image/jpeg", "image/png", "application/pdf"]);

const marcado = (ctx: { request: Request }, nome: string): boolean =>
  new URL(ctx.request.url).searchParams.get(nome) === "1";

export const ROTAS_PRESCRICOES: Rota[] = [
  // ---------------------------------------------------------------- catálogo
  {
    metodo: "GET",
    caminho: "/medicamentos",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const medicamentos = await listarMedicamentos(ctx.servico, sessaoDe(ctx), {
        incluirInativos: marcado(ctx, "inativos"),
      });
      return json({ medicamentos });
    },
  },
  {
    metodo: "POST",
    caminho: "/medicamentos",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z
          .object({
            nomeComercial: texto(200),
            principioAtivo: texto(200),
            concentracao: z.string().max(60).nullable().optional(),
            forma: z.enum(FORMAS),
            altoRisco: z.boolean().optional(),
          })
          .strict(),
      );
      const r = await cadastrarMedicamento(ctx.servico, sessaoDe(ctx), { ...entrada, ip: ctx.ip });
      if (!r.ok) return respostaDeFalha(r);
      return json({ ok: true, medicamentoId: r.medicamentoId, altoRisco: r.altoRisco }, 201);
    },
  },
  {
    metodo: "POST",
    caminho: "/medicamentos/:id/alto-risco",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const { altoRisco } = await lerCorpo(
        ctx.request,
        z.object({ altoRisco: z.boolean() }).strict(),
      );
      const r = await definirAltoRiscoDoMedicamento(ctx.servico, sessaoDe(ctx), {
        medicamentoId: uuidDaRota(ctx, "id"),
        altoRisco,
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/medicamentos/:id/desativar",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const r = await desativarMedicamento(ctx.servico, sessaoDe(ctx), {
        medicamentoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },

  // ---------------------------------------------------------------- prescrições
  {
    metodo: "GET",
    caminho: "/idosos/:id/prescricoes",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const r = await prescricoesDoIdoso(ctx.servico, sessaoDe(ctx), {
        idosoId: uuidDaRota(ctx, "id"),
        incluirInativas: marcado(ctx, "inativas"),
      });
      return r.ok ? json({ prescricoes: r.prescricoes }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/idosos/:id/prescricoes",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(ctx.request, novaPrescricao);
      const r = await prescrever(ctx.servico, sessaoDe(ctx), {
        ...entrada,
        idosoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      await gerarEscalaAposMudanca(ctx);
      return json(
        { ok: true, prescricaoId: r.prescricaoId, conflitosConfirmados: r.conflitosConfirmados },
        201,
      );
    },
  },
  {
    metodo: "GET",
    caminho: "/prescricoes/:id",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const r = await obterPrescricao(ctx.servico, sessaoDe(ctx), uuidDaRota(ctx, "id"));
      return r.ok ? json({ prescricao: r.prescricao, historico: r.historico }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/prescricoes/:id/nova-versao",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z
          .object({
            justificativa: z.string().max(500),
            conteudo,
            justificativaAlergia: z.string().max(500).optional(),
          })
          .strict(),
      );
      const r = await novaVersao(ctx.servico, sessaoDe(ctx), {
        ...entrada,
        prescricaoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      await gerarEscalaAposMudanca(ctx);
      return json(
        {
          ok: true,
          prescricaoId: r.prescricaoId,
          versao: r.versao,
          camposAlterados: r.camposAlterados,
          conflitosConfirmados: r.conflitosConfirmados,
        },
        201,
      );
    },
  },
  {
    metodo: "POST",
    caminho: "/prescricoes/:id/encerrar",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const { motivo } = await lerCorpo(
        ctx.request,
        z.object({ motivo: z.string().max(500) }).strict(),
      );
      const r = await encerrarPrescricao(ctx.servico, sessaoDe(ctx), {
        prescricaoId: uuidDaRota(ctx, "id"),
        motivo,
        ip: ctx.ip,
      });
      return r.ok ? json({ ok: true }) : respostaDeFalha(r);
    },
  },

  // ---------------------------------------------------------------- receitas
  {
    metodo: "GET",
    caminho: "/prescricoes/:id/receitas",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const id = uuidDaRota(ctx, "id");
      const sessao = sessaoDe(ctx);
      // Sem a prescrição não há receitas a mostrar: distingue "vazio" de "não existe".
      const existe = await obterPrescricao(ctx.servico, sessao, id);
      if (!existe.ok) return respostaDeFalha(existe);
      return json({ receitas: await listarReceitas(ctx.servico, sessao, id) });
    },
  },
  {
    // Corpo = o próprio arquivo (imagem ou PDF), não JSON.
    metodo: "POST",
    caminho: "/prescricoes/:id/receitas",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const tipo = (ctx.request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!TIPOS_DE_ARQUIVO.has(tipo)) throw new ErroHttp(415, "tipo_de_conteudo_invalido");
      const bytes = await lerCorpoBinario(ctx.request, TAMANHO_MAXIMO_RECEITA);
      const r = await anexarReceita(ctx.servico, sessaoDe(ctx), {
        prescricaoId: uuidDaRota(ctx, "id"),
        bytes,
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json(
        { ok: true, receitaId: r.receitaId, tipoMime: r.tipoMime, tamanhoBytes: r.tamanhoBytes },
        201,
      );
    },
  },
  {
    // Sem link público: o arquivo passa por aqui, com sessão, permissão e registro na trilha.
    metodo: "GET",
    caminho: "/prescricoes/:id/receitas/:receitaId",
    acesso: "sessao",
    permissao: "prescricao.gerir",
    async tratar(ctx) {
      const r = await lerReceita(ctx.servico, sessaoDe(ctx), {
        prescricaoId: uuidDaRota(ctx, "id"),
        receitaId: uuidDaRota(ctx, "receitaId"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return new Response(new Uint8Array(r.bytes), {
        status: 200,
        headers: {
          "Content-Type": r.tipoMime,
          "Content-Disposition": 'inline; filename="receita"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          // O arquivo nunca executa nada, mesmo que alguém consiga subir algo malicioso.
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    },
  },
];
