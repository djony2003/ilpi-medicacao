"use client";

import { useCallback, useState } from "react";
import { chamar } from "../../_comum/api";
import { useAoAbrir } from "../../_comum/ao-abrir";
import { FORMAS, type Medicamento } from "../../_comum/opcoes";
import { usePainel } from "../contexto";

// Catálogo de remédios da casa: cadastrar, marcar alto risco (exige segunda pessoa no tablet) e
// desativar o que não se usa mais.

export default function PaginaDosRemedios() {
  const { aoPerderSessao } = usePainel();
  const [lista, setLista] = useState<Medicamento[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [f, setF] = useState({
    nome: "",
    principio: "",
    conc: "",
    forma: "comprimido",
    risco: false,
  });

  const carregar = useCallback(async () => {
    const r = await chamar<{ medicamentos: Medicamento[] }>("GET", "/medicamentos");
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200) setLista(r.corpo.medicamentos);
    else setErro("Não foi possível carregar os remédios.");
  }, [aoPerderSessao]);
  useAoAbrir(carregar);

  const acao = async (caminho: string, corpo: object) => {
    const r = await chamar<{ problemas?: string[]; erro?: string }>("POST", caminho, corpo);
    if (r.status === 401) return aoPerderSessao();
    if (r.status >= 200 && r.status < 300) {
      setErro(null);
      await carregar();
      return true;
    }
    setErro(r.corpo.problemas?.join(" ") ?? r.corpo.erro ?? "Não foi possível salvar.");
    return false;
  };

  return (
    <section aria-labelledby="remedios-titulo">
      <h1 id="remedios-titulo" className="tela__titulo">
        Remédios
      </h1>
      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      <form
        className="cartao"
        onSubmit={(e) => {
          e.preventDefault();
          void acao("/medicamentos", {
            nomeComercial: f.nome,
            principioAtivo: f.principio,
            ...(f.conc.trim() ? { concentracao: f.conc.trim() } : {}),
            forma: f.forma,
            altoRisco: f.risco,
          }).then(
            (ok) =>
              ok && setF({ nome: "", principio: "", conc: "", forma: "comprimido", risco: false }),
          );
        }}
      >
        <h2 className="cartao__titulo">Cadastrar remédio</h2>
        <div className="grade">
          <label className="campo">
            <span className="campo__rotulo">Nome (como está na caixa)</span>
            <input
              className="campo__entrada"
              value={f.nome}
              required
              maxLength={200}
              onChange={(e) => setF({ ...f, nome: e.target.value })}
            />
          </label>
          <label className="campo">
            <span className="campo__rotulo">Princípio ativo</span>
            <input
              className="campo__entrada"
              value={f.principio}
              required
              maxLength={200}
              onChange={(e) => setF({ ...f, principio: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Concentração</span>
            <input
              className="campo__entrada"
              value={f.conc}
              maxLength={60}
              placeholder="50 mg"
              onChange={(e) => setF({ ...f, conc: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Forma</span>
            <select
              className="campo__entrada"
              value={f.forma}
              onChange={(e) => setF({ ...f, forma: e.target.value })}
            >
              {FORMAS.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="campo campo--marcar">
          <input
            type="checkbox"
            checked={f.risco}
            onChange={(e) => setF({ ...f, risco: e.target.checked })}
          />{" "}
          <span>Alto risco (a dose precisa de uma segunda pessoa no tablet)</span>
        </label>
        <div className="acoes">
          <button type="submit" className="botao botao--principal">
            Cadastrar
          </button>
        </div>
      </form>

      {lista === null ? (
        <p className="tela__texto">Carregando…</p>
      ) : (
        <div className="tabela-rolavel">
          <table className="tabela">
            <caption className="so-leitor">Remédios cadastrados</caption>
            <thead>
              <tr>
                <th>Remédio</th>
                <th>Princípio ativo</th>
                <th>Alto risco</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.nomeComercial}
                    {m.concentracao ? ` ${m.concentracao}` : ""}
                  </td>
                  <td>{m.principioAtivo}</td>
                  <td>
                    {m.altoRisco ? <span className="selo selo--risco">Alto risco</span> : "Não"}
                  </td>
                  <td className="acoes">
                    <button
                      type="button"
                      className="botao botao--discreto"
                      onClick={() =>
                        void acao(`/medicamentos/${m.id}/alto-risco`, { altoRisco: !m.altoRisco })
                      }
                    >
                      {m.altoRisco ? "Tirar alto risco" : "Marcar alto risco"}
                    </button>
                    <button
                      type="button"
                      className="botao botao--discreto"
                      onClick={() => void acao(`/medicamentos/${m.id}/desativar`, {})}
                    >
                      Desativar
                    </button>
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
