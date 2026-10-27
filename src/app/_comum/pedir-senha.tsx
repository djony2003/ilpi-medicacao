"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { chamar, type Resposta } from "./api";

// Ações que levam dados para fora ou mudam regras pedem a senha de novo (spec 7.2). A tela tenta
// a ação; se o servidor responder "reautenticacao_necessaria", abre este diálogo e, com a senha
// confirmada, tenta uma vez mais. Cancelar devolve null.

export function useComSenha(): {
  executar: <T extends Resposta>(acao: () => Promise<T>) => Promise<T | null>;
  dialogo: ReactNode;
} {
  const [aberto, setAberto] = useState(false);
  const resolver = useRef<((confirmou: boolean) => void) | null>(null);
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const pedir = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setSenha("");
        setErro(null);
        setAberto(true);
      }),
    [],
  );

  const executar = useCallback(
    async <T extends Resposta>(acao: () => Promise<T>): Promise<T | null> => {
      const primeira = await acao();
      if (primeira.status !== 403 || primeira.corpo.erro !== "reautenticacao_necessaria") {
        return primeira;
      }
      if (!(await pedir())) return null;
      return acao();
    },
    [pedir],
  );

  const fechar = (confirmou: boolean) => {
    setAberto(false);
    resolver.current?.(confirmou);
    resolver.current = null;
  };

  const confirmar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    const r = await chamar("POST", "/auth/reautenticar", { segredo: senha });
    setOcupado(false);
    if (r.status === 200) return fechar(true);
    setErro(
      r.semRede
        ? "Sem conexão com o servidor."
        : r.status === 401
          ? "Senha incorreta."
          : "Não foi possível confirmar.",
    );
  };

  const dialogo = aberto ? (
    <div className="janela" role="presentation">
      <form
        className="janela__caixa"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pedir-senha-titulo"
        onSubmit={(e) => void confirmar(e)}
      >
        <h2 id="pedir-senha-titulo" className="tela__titulo">
          Confirme a sua senha
        </h2>
        <p className="tela__texto">
          Esta ação leva dados para fora do sistema ou muda regras da casa. Digite a senha para
          continuar.
        </p>
        <label className="campo">
          <span className="campo__rotulo">Senha</span>
          <input
            className="campo__entrada"
            type="password"
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoFocus
          />
        </label>
        {erro && (
          <p className="aviso aviso--erro" role="alert">
            {erro}
          </p>
        )}
        <div className="acoes">
          <button type="submit" className="botao botao--principal" disabled={ocupado || !senha}>
            Confirmar
          </button>
          <button type="button" className="botao" onClick={() => fechar(false)}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return { executar, dialogo };
}
