import { z } from "zod";
import {
  MOTIVOS_DE_EXCECAO,
  RESULTADOS,
  configurarJanela,
  conferirDoseAgendada,
  listarSosDoIdoso,
  lotesDaDose,
  obterJanela,
  registrarDose,
  registrarSos,
  registrarTardio,
} from "@/modules/administracao";
import { json, lerCorpo } from "./http";
import { respostaDeFalha, sessaoDe, uuidDaRota, type Rota } from "./rota";

// Registro da administração (tablet). O tablet manda, a cada passo, tudo o que já leu; o servidor
// confere de novo a cada chamada e, no registro, dentro da transação que grava.

const leitura = z.string().min(1).max(100);
const pinDeOutraPessoa = z
  .object({ usuarioId: z.string().max(40), pin: z.string().max(12) })
  .strict();
const instante = z.iso.datetime({ offset: true });
const texto = (max: number) => z.string().max(max);

const excecao = z
  .object({
    loteId: z.string().max(40),
    motivo: z.enum(MOTIVOS_DE_EXCECAO),
    justificativa: texto(500),
    liberador: pinDeOutraPessoa,
  })
  .strict();

export const ROTAS_ADMINISTRACAO: Rota[] = [
  {
    metodo: "GET",
    caminho: "/administracao/doses/:id",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const r = await conferirDoseAgendada(ctx.servico, sessaoDe(ctx), {
        doseId: uuidDaRota(ctx, "id"),
      });
      return r.ok ? json({ conferencia: r.conferencia }) : respostaDeFalha(r);
    },
  },
  {
    // POST: a leitura de pulseira e etiqueta deixa rastro quando bloqueia.
    metodo: "POST",
    caminho: "/administracao/doses/:id/conferir",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z.object({ pulseira: leitura.optional(), lote: leitura.optional() }).strict(),
      );
      const r = await conferirDoseAgendada(ctx.servico, sessaoDe(ctx), {
        doseId: uuidDaRota(ctx, "id"),
        ...corpo,
        ip: ctx.ip,
      });
      return r.ok ? json({ conferencia: r.conferencia }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "GET",
    caminho: "/administracao/doses/:id/lotes",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const r = await lotesDaDose(ctx.servico, sessaoDe(ctx), uuidDaRota(ctx, "id"));
      return r.ok ? json({ lotes: r.lotes }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/administracao/doses/:id/registrar",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            chave: z.string().max(40),
            resultado: z.enum(RESULTADOS),
            pulseira: leitura.optional(),
            lote: leitura.optional(),
            motivo: texto(600).optional(),
            adiadaPara: instante.optional(),
            excecao: excecao.optional(),
            segundaValidacao: pinDeOutraPessoa.optional(),
            liberacao: pinDeOutraPessoa.optional(),
          })
          .strict(),
      );
      const r = await registrarDose(ctx.servico, sessaoDe(ctx), {
        ...corpo,
        doseId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json(r, r.repetido ? 200 : 201);
    },
  },
  {
    // Registro tardio: o que foi anotado na folha de contingência. Pede a senha ou o PIN de novo.
    metodo: "POST",
    caminho: "/administracao/doses/:id/tardio",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            chave: z.string().max(40),
            resultado: z.enum(["administrada", "recusada", "nao_administrada"]),
            ocorridaEm: instante,
            motivo: texto(600),
            lote: leitura.optional(),
            segundaValidacao: pinDeOutraPessoa.optional(),
          })
          .strict(),
      );
      const r = await registrarTardio(ctx.servico, sessaoDe(ctx), {
        ...corpo,
        doseId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json(r, r.repetido ? 200 : 201);
    },
  },
  {
    metodo: "GET",
    caminho: "/administracao/idosos/:id/sos",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const r = await listarSosDoIdoso(ctx.servico, sessaoDe(ctx), uuidDaRota(ctx, "id"));
      return r.ok ? json({ sos: r.sos }) : respostaDeFalha(r);
    },
  },
  {
    metodo: "POST",
    caminho: "/administracao/sos/:id/registrar",
    acesso: "sessao",
    permissao: "administracao.registrar",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({
            chave: z.string().max(40),
            pulseira: leitura,
            lote: leitura.optional(),
            sintoma: texto(600),
            excecao: excecao.optional(),
            segundaValidacao: pinDeOutraPessoa.optional(),
          })
          .strict(),
      );
      const r = await registrarSos(ctx.servico, sessaoDe(ctx), {
        ...corpo,
        prescricaoId: uuidDaRota(ctx, "id"),
        ip: ctx.ip,
      });
      if (!r.ok) return respostaDeFalha(r);
      return json(r, r.repetido ? 200 : 201);
    },
  },
  {
    metodo: "GET",
    caminho: "/admin/configuracoes/janela",
    acesso: "sessao",
    permissao: "configuracoes.gerir",
    async tratar(ctx) {
      return json({ janela: await obterJanela(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/configuracoes/janela",
    acesso: "sessao",
    permissao: "configuracoes.gerir",
    async tratar(ctx) {
      const corpo = await lerCorpo(
        ctx.request,
        z
          .object({ janelaMinutos: z.number().int(), limiteMaiorMinutos: z.number().int() })
          .strict(),
      );
      const r = await configurarJanela(ctx.servico, sessaoDe(ctx), { ...corpo, ip: ctx.ip });
      return r.ok ? json({ janela: r.janela }) : respostaDeFalha(r);
    },
  },
];
