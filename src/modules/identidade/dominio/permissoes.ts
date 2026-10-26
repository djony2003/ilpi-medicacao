// Matriz de permissões da spec (seção 7.1). É o único lugar que compara perfis: telas e ações do
// servidor perguntam "este perfil pode esta ação?" e nunca comparam o perfil diretamente.

export const PERFIS = ["gestor", "enfermeiro", "cuidador"] as const;
export type Perfil = (typeof PERFIS)[number];

const TODOS: readonly Perfil[] = ["cuidador", "enfermeiro", "gestor"];
const ENFERMAGEM_E_GESTAO: readonly Perfil[] = ["enfermeiro", "gestor"];
const SO_GESTAO: readonly Perfil[] = ["gestor"];

const PERMISSOES = {
  // Todos os perfis
  "escala.ver": TODOS,
  "administracao.registrar": TODOS,
  "administracao.segunda_validacao": TODOS,
  // Enfermeiro e gestor
  "prescricao.gerir": ENFERMAGEM_E_GESTAO,
  "conferencia.liberar_excecao": ENFERMAGEM_E_GESTAO,
  "estoque.gerir": ENFERMAGEM_E_GESTAO,
  "idoso.gerir": ENFERMAGEM_E_GESTAO,
  // Só o gestor
  "usuarios.gerir": SO_GESTAO,
  "configuracoes.gerir": SO_GESTAO,
  "dispositivos.gerir": SO_GESTAO,
  "auditoria.ver": SO_GESTAO,
  "relatorio_excecoes.ver": SO_GESTAO,
} as const satisfies Record<string, readonly Perfil[]>;

export type Acao = keyof typeof PERMISSOES;
export const ACOES = Object.keys(PERMISSOES) as Acao[];

export class ErroDePermissao extends Error {
  constructor(
    public readonly perfil: Perfil,
    public readonly acao: Acao,
  ) {
    super(`O perfil "${perfil}" não tem permissão para "${acao}".`);
    this.name = "ErroDePermissao";
  }
}

export function podeExecutar(perfil: Perfil, acao: Acao): boolean {
  return (PERMISSOES[acao] as readonly Perfil[]).includes(perfil);
}

export function exigirPermissao(perfil: Perfil, acao: Acao): void {
  if (!podeExecutar(perfil, acao)) throw new ErroDePermissao(perfil, acao);
}
