"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ListaDeAlertas, useResumoDosAlertas } from "../_comum/alertas";
import { chamar } from "../_comum/api";
import { FUSO_PADRAO } from "../_comum/formato";

// Painel no computador (T52): os alertas da casa, para a enfermagem e a gestão.

type Eu = { usuarioId: string; perfil: "gestor" | "enfermeiro" | "cuidador"; tipo: string };

export default function Painel() {
  const [eu, setEu] = useState<Eu | null>(null);
  const router = useRouter();
  const irParaEntrada = useCallback(() => router.replace("/entrar"), [router]);
  const pode = eu !== null && eu.perfil !== "cuidador";
  const { resumo, atualizar } = useResumoDosAlertas(pode);

  useEffect(() => {
    void chamar<Eu & { senhaTrocar: boolean }>("GET", "/auth/eu").then((r) => {
      if (r.status !== 200 || r.corpo.senhaTrocar) return irParaEntrada();
      setEu(r.corpo);
    });
  }, [irParaEntrada]);

  const sair = async () => {
    await chamar("POST", "/auth/sair", {});
    irParaEntrada();
  };

  return (
    <div className="painel">
      <header className="barra">
        <span className="barra__marca">ILPI Medicação</span>
        {resumo && (
          <span className="barra__pessoa">
            {resumo.urgentes > 0
              ? `${resumo.urgentes} ${resumo.urgentes === 1 ? "alerta urgente" : "alertas urgentes"}`
              : "Nenhum alerta urgente"}
          </span>
        )}
        <span className="barra__acoes">
          <button type="button" className="botao botao--discreto" onClick={() => void sair()}>
            Sair
          </button>
        </span>
      </header>
      <main className="painel__conteudo">
        {eu === null ? (
          <p className="tela__texto">Abrindo…</p>
        ) : !pode ? (
          <p className="aviso aviso--atencao">
            O painel é da enfermagem e da gestão. A equipe do plantão usa o tablet do posto.
          </p>
        ) : (
          <ListaDeAlertas fuso={FUSO_PADRAO} aoPerderSessao={irParaEntrada} aoMudar={atualizar} />
        )}
      </main>
    </div>
  );
}
