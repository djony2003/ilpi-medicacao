"use client";

import { createContext, useContext, type ReactNode } from "react";

export type Eu = {
  usuarioId: string;
  perfil: "gestor" | "enfermeiro" | "cuidador";
  tipo: string;
};

export type ContextoDoPainel = {
  eu: Eu;
  /** Volta para a tela de entrada (sessão perdida). */
  aoPerderSessao: () => void;
  /** Pede ao menu que recontamos os alertas (depois de ler ou encerrar um). */
  atualizarAlertas: () => void;
};

const Contexto = createContext<ContextoDoPainel | null>(null);
export const ProvedorDoPainel = Contexto.Provider;

export function usePainel(): ContextoDoPainel {
  const c = useContext(Contexto);
  if (!c) throw new Error("usePainel fora do painel");
  return c;
}

/** Tela da gestão: enfermeiro que digita o endereço vê este aviso, não uma tela quebrada. */
export function SoParaGestao({ children }: { children: ReactNode }) {
  const { eu } = usePainel();
  if (eu.perfil !== "gestor") {
    return <p className="aviso aviso--atencao">Esta tela é só da gestão da casa.</p>;
  }
  return <>{children}</>;
}
