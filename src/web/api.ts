import { z } from "zod";
import { log } from "@/compartilhado/log";
import {
  ErroDePermissao,
  ErroDeReautenticacao,
  PERFIS,
  exigirPermissao,
  POLITICA,
  ativarDispositivo,
  autenticarSessao,
  confirmarConfiguracaoTotp,
  criarDispositivo,
  criarUsuario,
  desativarUsuario,
  desbloquearUsuario,
  entrar,
  entrarComPin,
  iniciarConfiguracaoTotp,
  listarDispositivos,
  listarUsuarios,
  listarUsuariosParaPin,
  reautenticar,
  reativarUsuario,
  redefinirPin,
  redefinirSegundoFator,
  redefinirSenha,
  revogarDispositivo,
  sair,
  trocarMeuPin,
  trocarMinhaSenha,
  verificarSegundoFator,
  type Acao,
  type Rejeicao,
  type Servico,
} from "@/modules/identidade";
import {
  ErroHttp,
  ipDe,
  json,
  lerCookie,
  lerCorpo,
  mesmaOrigem,
  montarCookie,
  nomeDoCookie,
} from "./http";
import { ROTAS_IDOSOS } from "./rotas-idosos";
import { idDaRota, sessaoDe, texto, type Acesso, type Contexto, type Rota } from "./rota";

// API de identidade e administração. Um único despachante recebe Request e devolve Response.
// Cada rota declara o tipo de acesso que exige, e o despachante aplica as regras comuns antes de
// chamar o tratador: origem (CSRF), sessão, troca obrigatória de credencial e tratamento de erro.

const NEGADO = (): Response => json({ erro: "credenciais_invalidas" }, 401);

const STATUS_DE_REJEICAO: Record<Rejeicao["motivo"], number> = {
  dados_invalidos: 400,
  email_em_uso: 409,
  usuario_nao_encontrado: 404,
  proprio_usuario: 409,
  ultimo_gestor: 409,
  credencial_atual_incorreta: 403,
  sem_credencial: 403,
};

function resposta(r: { ok: true } | Rejeicao, extra: Record<string, unknown> = {}): Response {
  if (r.ok) return json({ ok: true, ...extra });
  const corpo: Record<string, unknown> = { erro: r.motivo };
  if (r.motivo === "dados_invalidos") corpo.problemas = r.problemas;
  return json(corpo, STATUS_DE_REJEICAO[r.motivo]);
}

const codigoTotp = z.object({ codigo: z.string().max(10) }).strict();

const ROTAS: Rota[] = [
  // ---------------------------------------------------------------- login na web
  {
    metodo: "POST",
    caminho: "/auth/entrar",
    acesso: "publico",
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z.object({ email: z.string().max(300), senha: z.string().max(300) }).strict(),
      );
      const r = await entrar(ctx.servico, { ...entrada, ip: ctx.ip });
      if (!r.ok) return NEGADO();
      ctx.definirSessao(r.token, POLITICA.web.segundoFatorMs);
      return json({ etapa: r.etapa, senhaTrocar: r.senhaTrocar });
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/segundo-fator",
    acesso: "sessao_incompleta",
    async tratar(ctx) {
      const { codigo } = await lerCorpo(ctx.request, codigoTotp);
      const r = await verificarSegundoFator(ctx.servico, {
        token: ctx.tokenDeSessao ?? "",
        codigo,
        ip: ctx.ip,
      });
      if (!r.ok) return NEGADO();
      ctx.definirSessao(r.token, POLITICA.web.duracaoMaximaMs);
      return json({ ok: true, senhaTrocar: r.senhaTrocar });
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/totp/iniciar",
    acesso: "sessao_incompleta",
    async tratar(ctx) {
      const r = await iniciarConfiguracaoTotp(ctx.servico, {
        token: ctx.tokenDeSessao ?? "",
        ip: ctx.ip,
      });
      if ("ok" in r) return NEGADO();
      return json({ segredo: r.segredo, uri: r.uri });
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/totp/confirmar",
    acesso: "sessao_incompleta",
    async tratar(ctx) {
      const { codigo } = await lerCorpo(ctx.request, codigoTotp);
      const r = await confirmarConfiguracaoTotp(ctx.servico, {
        token: ctx.tokenDeSessao ?? "",
        codigo,
        ip: ctx.ip,
      });
      if (!r.ok) return NEGADO();
      ctx.definirSessao(r.token, POLITICA.web.duracaoMaximaMs);
      return json({ ok: true, senhaTrocar: r.senhaTrocar });
    },
  },

  // ---------------------------------------------------------------- sessão
  {
    metodo: "GET",
    caminho: "/auth/eu",
    acesso: "sessao",
    permiteComTrocaPendente: true,
    async tratar(ctx) {
      const s = sessaoDe(ctx);
      return json({
        usuarioId: s.usuarioId,
        perfil: s.perfil,
        tipo: s.tipo,
        senhaTrocar: s.senhaTrocar,
        pinTrocar: s.pinTrocar,
      });
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/sair",
    acesso: "publico",
    async tratar(ctx) {
      if (ctx.tokenDeSessao) await sair(ctx.servico, ctx.tokenDeSessao, ctx.ip);
      ctx.limparSessao();
      return json({ ok: true });
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/reautenticar",
    acesso: "sessao",
    permiteComTrocaPendente: true,
    async tratar(ctx) {
      const { segredo } = await lerCorpo(
        ctx.request,
        z.object({ segredo: z.string().max(300) }).strict(),
      );
      const r = await reautenticar(ctx.servico, sessaoDe(ctx), { segredo, ip: ctx.ip });
      return r.ok ? json({ ok: true }) : NEGADO();
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/trocar-senha",
    acesso: "sessao",
    permiteComTrocaPendente: true,
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z.object({ senhaAtual: z.string().max(300), novaSenha: z.string().max(300) }).strict(),
      );
      return resposta(
        await trocarMinhaSenha(ctx.servico, sessaoDe(ctx), { ...entrada, ip: ctx.ip }),
      );
    },
  },
  {
    metodo: "POST",
    caminho: "/auth/trocar-pin",
    acesso: "sessao",
    permiteComTrocaPendente: true,
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z.object({ pinAtual: z.string().max(20), novoPin: z.string().max(20) }).strict(),
      );
      return resposta(await trocarMeuPin(ctx.servico, sessaoDe(ctx), { ...entrada, ip: ctx.ip }));
    },
  },

  // ---------------------------------------------------------------- tablet
  {
    metodo: "POST",
    caminho: "/tablet/ativar",
    acesso: "publico",
    async tratar(ctx) {
      const { codigo } = await lerCorpo(
        ctx.request,
        z.object({ codigo: z.string().max(40) }).strict(),
      );
      const r = await ativarDispositivo(ctx.servico, { codigo, ip: ctx.ip });
      if (!r.ok) return json({ erro: r.motivo }, 400);
      ctx.definirDispositivo(r.token);
      return json({ ok: true, nome: r.nome });
    },
  },
  {
    metodo: "GET",
    caminho: "/tablet/usuarios",
    acesso: "dispositivo",
    async tratar(ctx) {
      const lista = await listarUsuariosParaPin(ctx.servico, ctx.tokenDoDispositivo ?? "");
      if (!lista) throw new ErroHttp(401, "dispositivo_nao_autorizado");
      return json({ usuarios: lista });
    },
  },
  {
    metodo: "POST",
    caminho: "/tablet/entrar",
    acesso: "dispositivo",
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z.object({ usuarioId: z.string().max(60), pin: z.string().max(20) }).strict(),
      );
      const r = await entrarComPin(ctx.servico, {
        tokenDoDispositivo: ctx.tokenDoDispositivo ?? "",
        ...entrada,
        ip: ctx.ip,
      });
      if (!r.ok) return NEGADO();
      ctx.definirSessao(r.token, POLITICA.tablet.duracaoMaximaMs);
      return json({ ok: true, pinTrocar: r.pinTrocar, usuario: r.usuario });
    },
  },

  // ---------------------------------------------------------------- administração
  {
    metodo: "GET",
    caminho: "/admin/usuarios",
    acesso: "sessao",
    permissao: "usuarios.gerir",
    async tratar(ctx) {
      return json({ usuarios: await listarUsuarios(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/usuarios",
    acesso: "sessao",
    permissao: "usuarios.gerir",
    async tratar(ctx) {
      const entrada = await lerCorpo(
        ctx.request,
        z
          .object({
            nome: texto(200),
            perfil: z.enum(PERFIS),
            email: z.string().max(300).optional(),
            registroProfissional: z.string().max(100).optional(),
            senhaInicial: z.string().max(300).optional(),
            pinInicial: z.string().max(20).optional(),
          })
          .strict(),
      );
      const r = await criarUsuario(ctx.servico, sessaoDe(ctx), { ...entrada, ip: ctx.ip });
      if (!r.ok) return resposta(r);
      return json({ ok: true, usuarioId: r.usuarioId }, 201);
    },
  },
  ...(
    [
      ["desativar", desativarUsuario],
      ["reativar", reativarUsuario],
      ["desbloquear", desbloquearUsuario],
      ["redefinir-segundo-fator", redefinirSegundoFator],
    ] as const
  ).map(([acao, funcao]): Rota => ({
    metodo: "POST",
    caminho: `/admin/usuarios/:id/${acao}`,
    acesso: "sessao",
    permissao: "usuarios.gerir",
    async tratar(ctx) {
      return resposta(
        await funcao(ctx.servico, sessaoDe(ctx), { usuarioId: idDaRota(ctx), ip: ctx.ip }),
      );
    },
  })),
  {
    metodo: "POST",
    caminho: "/admin/usuarios/:id/redefinir-senha",
    acesso: "sessao",
    permissao: "usuarios.gerir",
    async tratar(ctx) {
      const { novaSenha } = await lerCorpo(
        ctx.request,
        z.object({ novaSenha: z.string().max(300) }).strict(),
      );
      return resposta(
        await redefinirSenha(ctx.servico, sessaoDe(ctx), {
          usuarioId: idDaRota(ctx),
          novaSenha,
          ip: ctx.ip,
        }),
      );
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/usuarios/:id/redefinir-pin",
    acesso: "sessao",
    permissao: "usuarios.gerir",
    async tratar(ctx) {
      const { novoPin } = await lerCorpo(
        ctx.request,
        z.object({ novoPin: z.string().max(20) }).strict(),
      );
      return resposta(
        await redefinirPin(ctx.servico, sessaoDe(ctx), {
          usuarioId: idDaRota(ctx),
          novoPin,
          ip: ctx.ip,
        }),
      );
    },
  },
  {
    metodo: "GET",
    caminho: "/admin/dispositivos",
    acesso: "sessao",
    permissao: "dispositivos.gerir",
    async tratar(ctx) {
      return json({ dispositivos: await listarDispositivos(ctx.servico, sessaoDe(ctx)) });
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/dispositivos",
    acesso: "sessao",
    permissao: "dispositivos.gerir",
    async tratar(ctx) {
      const { nome } = await lerCorpo(ctx.request, z.object({ nome: texto(200) }).strict());
      const r = await criarDispositivo(ctx.servico, sessaoDe(ctx), { nome, ip: ctx.ip });
      return json(
        { dispositivoId: r.dispositivoId, codigo: r.codigo, expiraEm: r.expiraEm.toISOString() },
        201,
      );
    },
  },
  {
    metodo: "POST",
    caminho: "/admin/dispositivos/:id/revogar",
    acesso: "sessao",
    permissao: "dispositivos.gerir",
    async tratar(ctx) {
      const revogado = await revogarDispositivo(ctx.servico, sessaoDe(ctx), {
        dispositivoId: idDaRota(ctx),
        ip: ctx.ip,
      });
      return revogado ? json({ ok: true }) : json({ erro: "nao_encontrado" }, 404);
    },
  },

  // ---------------------------------------------------------------- idosos
  ...ROTAS_IDOSOS,
];

export type DescricaoDeRota = {
  metodo: "GET" | "POST";
  caminho: string;
  acesso: Acesso;
  permiteComTrocaPendente: boolean;
  permissao: Acao | null;
};

/**
 * Inventário das rotas, para os testes percorrerem TODAS automaticamente: toda rota nova entra
 * na malha de testes de acesso e de isolamento entre casas sem ninguém precisar lembrar.
 */
export function listarRotas(): DescricaoDeRota[] {
  return ROTAS.map((r) => ({
    metodo: r.metodo,
    caminho: r.caminho,
    acesso: r.acesso,
    permiteComTrocaPendente: r.permiteComTrocaPendente ?? false,
    permissao: r.permissao ?? null,
  }));
}

function casarCaminho(caminho: string, segmentos: string[]): Record<string, string> | null {
  const padrao = caminho.split("/").filter(Boolean);
  if (padrao.length !== segmentos.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < padrao.length; i += 1) {
    const p = padrao[i] ?? "";
    const s = segmentos[i] ?? "";
    if (p.startsWith(":")) params[p.slice(1)] = s;
    else if (p !== s) return null;
  }
  return params;
}

export type OpcoesDaApi = {
  servico: () => Servico;
  producao: boolean;
  /** Origem pública do site (ex.: https://app.casa.exemplo). Padrão: a origem da requisição. */
  origemEsperada?: string;
  /** Prefixo da API na URL. Padrão: /api. */
  prefixo?: string;
};

export function criarApi(opcoes: OpcoesDaApi): (request: Request) => Promise<Response> {
  const prefixo = opcoes.prefixo ?? "/api";
  const cookieSessao = nomeDoCookie("ilpi_sessao", opcoes.producao);
  const cookieDispositivo = nomeDoCookie("ilpi_dispositivo", opcoes.producao);
  const UM_ANO_SEGUNDOS = 365 * 24 * 3600;

  return async function tratar(request: Request): Promise<Response> {
    const cookies: string[] = [];
    const finalizar = (r: Response): Response => {
      for (const c of cookies) r.headers.append("Set-Cookie", c);
      return r;
    };

    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${prefixo}/`)) throw new ErroHttp(404, "nao_encontrado");
      const segmentos = url.pathname.slice(prefixo.length).split("/").filter(Boolean);

      const candidatas = ROTAS.flatMap((r) => {
        const p = casarCaminho(r.caminho, segmentos);
        return p ? [{ rota: r, params: p }] : [];
      });
      const escolhida = candidatas.find((c) => c.rota.metodo === request.method);
      if (!escolhida) {
        throw candidatas.length > 0
          ? new ErroHttp(405, "metodo_nao_permitido")
          : new ErroHttp(404, "nao_encontrado");
      }
      const { rota, params } = escolhida;

      if (rota.metodo !== "GET" && !mesmaOrigem(request, opcoes.origemEsperada)) {
        throw new ErroHttp(403, "origem_invalida");
      }

      const ctx: Contexto = {
        request,
        servico: opcoes.servico(),
        params,
        ip: ipDe(request),
        producao: opcoes.producao,
        tokenDeSessao: lerCookie(request, cookieSessao),
        tokenDoDispositivo: lerCookie(request, cookieDispositivo),
        sessao: null,
        cookies,
        definirSessao: (token, maxAgeMs) =>
          cookies.push(
            montarCookie(cookieSessao, token, {
              producao: opcoes.producao,
              maxAgeSegundos: maxAgeMs / 1000,
            }),
          ),
        limparSessao: () =>
          cookies.push(
            montarCookie(cookieSessao, "", { producao: opcoes.producao, maxAgeSegundos: 0 }),
          ),
        definirDispositivo: (token) =>
          cookies.push(
            montarCookie(cookieDispositivo, token, {
              producao: opcoes.producao,
              maxAgeSegundos: UM_ANO_SEGUNDOS,
            }),
          ),
      };

      if (rota.acesso === "sessao_incompleta" && !ctx.tokenDeSessao) {
        throw new ErroHttp(401, "nao_autenticado");
      }
      if (rota.acesso === "dispositivo" && !ctx.tokenDoDispositivo) {
        throw new ErroHttp(401, "dispositivo_nao_autorizado");
      }
      if (rota.acesso === "sessao") {
        const sessao = ctx.tokenDeSessao
          ? await autenticarSessao(ctx.servico, ctx.tokenDeSessao)
          : null;
        // Não apaga o cookie aqui: a tela do segundo fator consulta esta rota com a sessão ainda
        // incompleta, e apagá-la obrigaria a pessoa a digitar a senha de novo.
        if (!sessao) throw new ErroHttp(401, "nao_autenticado");
        if ((sessao.senhaTrocar || sessao.pinTrocar) && !rota.permiteComTrocaPendente) {
          throw new ErroHttp(403, "troca_obrigatoria");
        }
        ctx.sessao = sessao;
        if (rota.permissao) exigirPermissao(sessao.perfil, rota.permissao);
      }

      return finalizar(await rota.tratar(ctx));
    } catch (erro) {
      return finalizar(erroParaResposta(erro));
    }
  };
}

function erroParaResposta(erro: unknown): Response {
  if (erro instanceof ErroHttp) return json({ erro: erro.codigo }, erro.status);
  if (erro instanceof ErroDePermissao) return json({ erro: "sem_permissao" }, 403);
  if (erro instanceof ErroDeReautenticacao) return json({ erro: "reautenticacao_necessaria" }, 403);
  // Só o tipo do erro e o código do Postgres: a mensagem pode conter dados pessoais.
  const codigo = (erro as { code?: unknown } | null)?.code;
  log.error("falha não tratada na API", {
    tipo: erro instanceof Error ? erro.name : typeof erro,
    codigoPg: typeof codigo === "string" ? codigo : undefined,
  });
  return json({ erro: "erro_interno" }, 500);
}
