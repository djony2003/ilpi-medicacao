"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useResumoDosAlertas } from "../_comum/alertas";
import { chamar } from "../_comum/api";
import { ProvedorDoPainel, type Eu } from "./contexto";

// Estrutura do painel no computador: barra com o menu (o que cada perfil pode abrir) e o contador
// de alertas urgentes. A enfermagem vê alertas e residentes; a gestão vê tudo.

const MENU: Array<{ caminho: string; nome: string; so?: "gestor" }> = [
  { caminho: "/painel", nome: "Alertas" },
  { caminho: "/painel/residentes", nome: "Residentes" },
  { caminho: "/painel/excecoes", nome: "Exceções", so: "gestor" },
  { caminho: "/painel/auditoria", nome: "Auditoria", so: "gestor" },
  { caminho: "/painel/configuracoes", nome: "Configurações", so: "gestor" },
];

export default function LayoutDoPainel({ children }: { children: ReactNode }) {
  const [eu, setEu] = useState<Eu | null>(null);
  const router = useRouter();
  const rota = usePathname();
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

  const atual = (caminho: string) =>
    caminho === "/painel" ? rota === "/painel" : rota.startsWith(caminho);

  return (
    <div className="painel">
      <header className="barra">
        <span className="barra__marca">ILPI Medicação</span>
        {pode && (
          <nav className="menu" aria-label="Seções do painel">
            {MENU.filter((m) => !m.so || m.so === eu.perfil).map((m) => (
              <Link
                key={m.caminho}
                href={m.caminho}
                className={atual(m.caminho) ? "menu__item menu__item--atual" : "menu__item"}
                aria-current={atual(m.caminho) ? "page" : undefined}
              >
                {m.nome}
                {m.caminho === "/painel" && resumo && resumo.urgentes > 0 && (
                  <span className="contador contador--urgente">{resumo.urgentes}</span>
                )}
              </Link>
            ))}
          </nav>
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
          <ProvedorDoPainel
            value={{ eu, aoPerderSessao: irParaEntrada, atualizarAlertas: atualizar }}
          >
            {children}
          </ProvedorDoPainel>
        )}
      </main>
    </div>
  );
}
