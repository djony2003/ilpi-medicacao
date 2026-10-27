import { useEffect } from "react";

/**
 * Roda `carregar` quando a tela abre (e de novo se a função mudar), sem rodar depois que a tela
 * saiu. O desvio por uma função local é o padrão do projeto para carregar dados num efeito.
 */
export function useAoAbrir(carregar: () => Promise<unknown> | void): void {
  useEffect(() => {
    let ativo = true;
    const tentar = () => {
      if (ativo) void carregar();
    };
    tentar();
    return () => {
      ativo = false;
    };
  }, [carregar]);
}
