import { z } from "zod";
import { ehUuid } from "@/compartilhado/banco/transacao";
import type { Falha } from "@/compartilhado/resultado";
import type { Acao, Servico, SessaoAutenticada } from "@/modules/identidade";
import { ErroHttp, json } from "./http";

// Tipos e ajudantes comuns às tabelas de rotas (identidade, idosos, ...).

export type Acesso =
  | "publico"
  /** Sessão aberta com a senha, ainda sem o segundo fator. */
  | "sessao_incompleta"
  /** Tablet aprovado (cookie do aparelho), sem usuário logado. */
  | "dispositivo"
  /** Sessão completa. */
  | "sessao";

export type Contexto = {
  request: Request;
  servico: Servico;
  params: Record<string, string>;
  ip: string | null;
  producao: boolean;
  /** Token do cookie de sessão, quando presente (ainda não validado). */
  tokenDeSessao: string | null;
  tokenDoDispositivo: string | null;
  sessao: SessaoAutenticada | null;
  /** Cookies a enviar na resposta. */
  cookies: string[];
  definirSessao(token: string, maxAgeMs: number): void;
  limparSessao(): void;
  definirDispositivo(token: string): void;
};

export type Rota = {
  metodo: "GET" | "POST";
  caminho: string;
  acesso: Acesso;
  /** Permitida mesmo quando a pessoa ainda precisa trocar a senha ou o PIN provisório. */
  permiteComTrocaPendente?: boolean;
  /**
   * Permissão exigida do perfil, conferida pelo despachante ANTES de ler o corpo. As funções do
   * módulo conferem de novo (defesa em duas camadas). Toda rota /admin precisa declarar uma.
   */
  permissao?: Acao;
  tratar(ctx: Contexto): Promise<Response>;
};

export function sessaoDe(ctx: Contexto): SessaoAutenticada {
  if (!ctx.sessao) throw new ErroHttp(401, "nao_autenticado");
  return ctx.sessao;
}

export function idDaRota(ctx: Contexto): string {
  const id = ctx.params.id;
  if (!id || !ehUuid(id)) throw new ErroHttp(404, "nao_encontrado");
  return id;
}

export const texto = (max: number) => z.string().min(1).max(max);
const STATUS_DE_FALHA: Record<string, number> = {
  dados_invalidos: 400,
  codigo_invalido: 400,
  nao_encontrado: 404,
  pulseira_desconhecida: 404,
  sem_mudanca: 409,
  pulseira_substituida: 409,
  ja_cadastrado: 409,
  ja_existe_ativa: 409,
  em_uso: 409,
  nao_ativa: 409,
  medicamento_diferente: 409,
  conflito_alergia: 409,
  alto_risco_obrigatorio: 422,
  medicamento_nao_encontrado: 422,
  idoso_desligado: 422,
  arquivo_invalido: 415,
  arquivo_grande_demais: 413,
};

/** Traduz uma falha de regra de negócio em resposta HTTP. Motivo desconhecido vira 400. */
export function respostaDeFalha(f: Falha | { ok: false; motivo: string }): Response {
  const corpo: Record<string, unknown> = { ...f, erro: f.motivo };
  delete corpo.ok;
  delete corpo.motivo;
  return json(corpo, STATUS_DE_FALHA[f.motivo] ?? 400);
}

/** Identificador na URL: se não for um UUID, o objeto simplesmente não existe. */
export function uuidDaRota(ctx: Contexto, nome: string): string {
  const id = ctx.params[nome];
  if (!id || !ehUuid(id)) throw new ErroHttp(404, "nao_encontrado");
  return id;
}
