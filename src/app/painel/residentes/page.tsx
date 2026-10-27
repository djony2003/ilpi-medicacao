"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { ResumoDeIdoso } from "@/modules/idosos";
import { chamar } from "../../_comum/api";
import { useAoAbrir } from "../../_comum/ao-abrir";
import { usePainel } from "../contexto";

// Residentes da casa: lista, busca pelo nome e cadastro de um novo. A ficha de cada um (alergias,
// contatos, pulseira, exportação) fica em /painel/residentes/[id].

const SITUACAO: Record<ResumoDeIdoso["status"], string> = {
  ativo: "Na casa",
  hospitalizado: "Hospitalizado",
  desligado: "Desligado",
};

export default function PaginaDosResidentes() {
  const { aoPerderSessao } = usePainel();
  const [lista, setLista] = useState<ResumoDeIdoso[] | null>(null);
  const [busca, setBusca] = useState("");
  const [mostrarDesligados, setMostrarDesligados] = useState(false);
  const [novo, setNovo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const r = await chamar<{ idosos: ResumoDeIdoso[] }>("GET", "/idosos");
    if (r.status === 401) return aoPerderSessao();
    if (r.status !== 200) {
      setErro(
        r.semRede ? "Sem conexão com o servidor." : "Não foi possível carregar os residentes.",
      );
      return;
    }
    setErro(null);
    setLista(r.corpo.idosos);
  }, [aoPerderSessao]);

  useAoAbrir(carregar);

  const visiveis = (lista ?? [])
    .filter((i) => mostrarDesligados || i.status !== "desligado")
    .filter((i) =>
      i.nome.toLocaleLowerCase("pt-BR").includes(busca.trim().toLocaleLowerCase("pt-BR")),
    );

  return (
    <section aria-labelledby="residentes-titulo">
      <div className="alertas__topo">
        <h1 id="residentes-titulo" className="tela__titulo">
          Residentes
        </h1>
        <button type="button" className="botao botao--principal" onClick={() => setNovo(true)}>
          Cadastrar residente
        </button>
      </div>

      {novo && (
        <FormularioDeResidente
          aoCancelar={() => setNovo(false)}
          aoPerderSessao={aoPerderSessao}
          aoCadastrar={() => {
            setNovo(false);
            void carregar();
          }}
        />
      )}

      <div className="filtros">
        <label className="campo">
          <span className="campo__rotulo">Buscar pelo nome</span>
          <input
            className="campo__entrada"
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </label>
        <label className="campo campo--marcar">
          <input
            type="checkbox"
            checked={mostrarDesligados}
            onChange={(e) => setMostrarDesligados(e.target.checked)}
          />{" "}
          <span>Mostrar desligados</span>
        </label>
      </div>

      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      {lista === null ? (
        !erro && <p className="tela__texto">Carregando…</p>
      ) : visiveis.length === 0 ? (
        <p className="alertas__vazio">Nenhum residente encontrado.</p>
      ) : (
        <div className="tabela-rolavel">
          <table className="tabela">
            <caption className="so-leitor">Residentes</caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Quarto</th>
                <th scope="col">Situação</th>
                <th scope="col">Alergias</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/painel/residentes/${i.id}`} className="ligacao">
                      {i.nome}
                    </Link>
                  </td>
                  <td>{i.quarto ?? "—"}</td>
                  <td>{SITUACAO[i.status]}</td>
                  <td>
                    {i.alergiasAtivas === 0 ? (
                      "Nenhuma"
                    ) : (
                      <span className={i.alergiasGraves > 0 ? "selo selo--risco" : ""}>
                        {i.alergiasAtivas}
                        {i.alergiasGraves > 0
                          ? ` (${i.alergiasGraves} grave${i.alergiasGraves > 1 ? "s" : ""})`
                          : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FormularioDeResidente({
  aoCancelar,
  aoCadastrar,
  aoPerderSessao,
}: {
  aoCancelar: () => void;
  aoCadastrar: () => void;
  aoPerderSessao: () => void;
}) {
  const [nome, setNome] = useState("");
  const [nascimento, setNascimento] = useState("");
  const [quarto, setQuarto] = useState("");
  const [cpf, setCpf] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    const r = await chamar<{ problemas?: string[] }>("POST", "/idosos", {
      nome,
      dataNascimento: nascimento,
      ...(quarto.trim() ? { quarto: quarto.trim() } : {}),
      ...(cpf.trim() ? { cpf: cpf.trim() } : {}),
    });
    setOcupado(false);
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 201) return aoCadastrar();
    setErro(
      r.corpo.problemas?.join(" ") ??
        (r.semRede ? "Sem conexão com o servidor." : "Não foi possível cadastrar."),
    );
  };

  return (
    <form className="cartao" onSubmit={(e) => void enviar(e)} aria-label="Novo residente">
      <h2 className="cartao__titulo">Novo residente</h2>
      <div className="grade">
        <label className="campo">
          <span className="campo__rotulo">Nome completo</span>
          <input
            className="campo__entrada"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={200}
            required
            autoFocus
          />
        </label>
        <label className="campo campo--curto">
          <span className="campo__rotulo">Data de nascimento</span>
          <input
            className="campo__entrada"
            type="date"
            value={nascimento}
            onChange={(e) => setNascimento(e.target.value)}
            required
          />
        </label>
        <label className="campo campo--curto">
          <span className="campo__rotulo">Quarto (opcional)</span>
          <input
            className="campo__entrada"
            value={quarto}
            onChange={(e) => setQuarto(e.target.value)}
            maxLength={40}
          />
        </label>
        <label className="campo campo--curto">
          <span className="campo__rotulo">CPF (opcional)</span>
          <input
            className="campo__entrada"
            inputMode="numeric"
            value={cpf}
            onChange={(e) => setCpf(e.target.value)}
            maxLength={14}
          />
        </label>
      </div>
      <p className="campo__ajuda">
        Alergias e contatos de emergência entram na ficha, logo depois do cadastro.
      </p>
      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      <div className="acoes">
        <button type="submit" className="botao botao--principal" disabled={ocupado}>
          Cadastrar
        </button>
        <button type="button" className="botao" onClick={aoCancelar}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
