// Resultado padrão das operações de negócio: sucesso com dados, ou falha com um motivo estável
// (que a API traduz em status HTTP e a tela traduz em mensagem). Erros de programação e de
// permissão continuam sendo exceções; falha de regra de negócio é valor de retorno.

export type Falha<M extends string = string> = {
  ok: false;
  motivo: M;
  /** Só em `dados_invalidos`: o que corrigir, em português claro. */
  problemas?: string[];
};

export function dadosInvalidos(...problemas: string[]): Falha<"dados_invalidos"> {
  return { ok: false, motivo: "dados_invalidos", problemas };
}

export function falha<M extends string>(motivo: M): Falha<M> {
  return { ok: false, motivo };
}
