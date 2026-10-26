"use client";

import { useEffect, useState } from "react";
import { chamar } from "./api";
import { TecladoPin } from "./teclado-pin";
import type { Pessoa, PinDeOutraPessoa } from "./tipos";

// Outra pessoa se identifica no tablet de quem está registrando: escolhe o próprio nome e digita
// o PIN. O PIN não é conferido aqui: vai junto com o registro e o servidor confere na mesma
// transação que grava (assim não existe "PIN aprovado" esperando para ser usado).

const PERFIL: Record<Pessoa["perfil"], string> = {
  cuidador: "Cuidador",
  enfermeiro: "Enfermeiro",
  gestor: "Gestor",
};

export function ConfirmarPessoa({
  titulo,
  explicacao,
  perfis,
  excluir,
  erro,
  aoConfirmar,
  aoCancelar,
}: {
  titulo: string;
  explicacao: string;
  perfis: Array<Pessoa["perfil"]>;
  /** Quem não pode ser escolhido (na segunda validação, quem registra). */
  excluir?: string;
  erro?: string | null;
  aoConfirmar: (p: PinDeOutraPessoa) => void;
  aoCancelar: () => void;
}) {
  const [pessoas, setPessoas] = useState<Pessoa[] | null>(null);
  const [escolhida, setEscolhida] = useState<Pessoa | null>(null);

  useEffect(() => {
    let ativo = true;
    void chamar<{ usuarios: Pessoa[] }>("GET", "/tablet/usuarios").then((r) => {
      if (ativo) setPessoas(r.corpo.usuarios ?? []);
    });
    return () => {
      ativo = false;
    };
  }, []);

  if (escolhida) {
    return (
      <TecladoPin
        titulo={`${escolhida.nome}, digite seu PIN`}
        explicacao={explicacao}
        erro={erro}
        aoConfirmar={(pin) => aoConfirmar({ usuarioId: escolhida.id, pin })}
        aoCancelar={() => setEscolhida(null)}
      />
    );
  }

  const lista = (pessoas ?? []).filter((p) => perfis.includes(p.perfil) && p.id !== excluir);
  return (
    <section className="pessoas">
      <h2 className="tela__titulo">{titulo}</h2>
      <p className="tela__texto">{explicacao}</p>
      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      {pessoas === null ? (
        <p className="tela__texto">Carregando a equipe…</p>
      ) : lista.length === 0 ? (
        <p className="aviso aviso--atencao">
          Ninguém da equipe com esse perfil tem PIN neste tablet. Peça ao gestor para cadastrar.
        </p>
      ) : (
        <ul className="pessoas__lista">
          {lista.map((p) => (
            <li key={p.id}>
              <button type="button" className="pessoa" onClick={() => setEscolhida(p)}>
                <span className="pessoa__nome">{p.nome}</span>
                <span className="pessoa__perfil">{PERFIL[p.perfil]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="acoes">
        <button type="button" className="botao" onClick={aoCancelar}>
          Voltar
        </button>
      </div>
    </section>
  );
}
