"use client";

import { useCallback, useState } from "react";
import type { RelatorioDeExcecoes } from "@/modules/relatorios";
import { baixar, chamar } from "../../_comum/api";
import { useAoAbrir } from "../../_comum/ao-abrir";
import { FUSO_PADRAO } from "../../_comum/formato";
import { useComSenha } from "../../_comum/pedir-senha";
import { usePainel } from "../contexto";

// Relatório de exceções de conferência (spec 6.3 e 7.1): as vezes em que a etiqueta não pôde ser
// lida e a enfermagem liberou a dose mesmo assim. Serve para ver se a exceção virou rotina.

const dia = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO_PADRAO }).format(d);
const quando = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_PADRAO,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));

const MOTIVOS: Record<string, string> = {
  etiqueta_ilegivel: "Etiqueta ilegível",
  etiqueta_danificada: "Etiqueta danificada",
};
const RESULTADOS: Record<string, string> = {
  administrada: "Administrada",
  recusada: "Recusada",
  nao_administrada: "Não administrada",
  adiada: "Adiada",
};

function Contagem({ titulo, itens }: { titulo: string; itens: Array<[string, number]> }) {
  return (
    <div className="resumo__bloco">
      <h2 className="resumo__titulo">{titulo}</h2>
      {itens.length === 0 ? (
        <p className="resumo__vazio">Nenhum.</p>
      ) : (
        <ul className="resumo__lista">
          {itens.slice(0, 5).map(([nome, n]) => (
            <li key={nome}>
              <span>{nome}</span> <strong>{n}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PaginaDasExcecoes() {
  const { aoPerderSessao } = usePainel();
  const { executar, dialogo } = useComSenha();
  const [padrao] = useState(() => ({
    hoje: dia(new Date()),
    de: dia(new Date(Date.now() - 29 * 86_400_000)),
  }));
  const hoje = padrao.hoje;
  const [de, setDe] = useState(padrao.de);
  const [ate, setAte] = useState(padrao.hoje);
  const [relatorio, setRelatorio] = useState<RelatorioDeExcecoes | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(
    async (inicio: string, fim: string) => {
      const r = await chamar<{ relatorio: RelatorioDeExcecoes }>(
        "GET",
        `/admin/relatorios/excecoes?de=${inicio}&ate=${fim}`,
      );
      if (r.status === 401) return aoPerderSessao();
      if (r.status !== 200) {
        setErro(
          r.semRede
            ? "Sem conexão com o servidor."
            : r.status === 400
              ? "Confira o período: a data inicial não pode ser depois da final, e o máximo é um ano."
              : "Não foi possível montar o relatório.",
        );
        return;
      }
      setErro(null);
      setRelatorio(r.corpo.relatorio);
    },
    [aoPerderSessao],
  );

  const abrir = useCallback(() => carregar(padrao.de, padrao.hoje), [carregar, padrao]);
  useAoAbrir(abrir);

  const exportar = async (formato: "pdf" | "csv") => {
    setAviso(null);
    const r = await executar(() =>
      baixar(
        "/admin/relatorios/excecoes/exportar",
        { formato, de, ate },
        `excecoes-de-conferencia.${formato}`,
      ),
    );
    if (r === null) return;
    if (r.status === 401) return aoPerderSessao();
    setAviso(
      r.status === 200
        ? "Arquivo gerado. A exportação ficou registrada na trilha."
        : "Não foi possível gerar o arquivo.",
    );
  };

  const proporcao =
    relatorio && relatorio.totalDeRegistros > 0
      ? ((relatorio.total / relatorio.totalDeRegistros) * 100).toFixed(1).replace(".", ",")
      : null;

  return (
    <section aria-labelledby="excecoes-titulo">
      <h1 id="excecoes-titulo" className="tela__titulo">
        Exceções de conferência
      </h1>
      <p className="tela__texto">
        Doses em que a etiqueta não pôde ser lida e uma pessoa da enfermagem liberou mesmo assim.
        Poucas são normais; muitas apontam etiquetas ruins ou liberação por costume.
      </p>

      <form
        className="filtros"
        onSubmit={(e) => {
          e.preventDefault();
          setRelatorio(null);
          void carregar(de, ate);
        }}
      >
        <label className="campo">
          <span className="campo__rotulo">De</span>
          <input
            className="campo__entrada"
            type="date"
            value={de}
            max={ate}
            onChange={(e) => setDe(e.target.value)}
            required
          />
        </label>
        <label className="campo">
          <span className="campo__rotulo">Até</span>
          <input
            className="campo__entrada"
            type="date"
            value={ate}
            min={de}
            max={hoje}
            onChange={(e) => setAte(e.target.value)}
            required
          />
        </label>
        <button type="submit" className="botao botao--principal">
          Atualizar
        </button>
      </form>

      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      {aviso && (
        <p className="aviso aviso--ok" role="status">
          {aviso}
        </p>
      )}

      {relatorio === null ? (
        !erro && <p className="tela__texto">Carregando…</p>
      ) : (
        <>
          <p className="resumo__destaque">
            <strong>{relatorio.total}</strong> {relatorio.total === 1 ? "exceção" : "exceções"} no
            período
            {proporcao !== null && (
              <span>
                {" "}
                ({proporcao}% de {relatorio.totalDeRegistros} registros de dose)
              </span>
            )}
          </p>
          {relatorio.total > 0 && (
            <div className="resumo">
              <Contagem
                titulo="Por motivo"
                itens={relatorio.porMotivo.map((m) => [
                  MOTIVOS[m.motivo] ?? m.motivo,
                  m.quantidade,
                ])}
              />
              <Contagem
                titulo="Quem liberou"
                itens={relatorio.porLiberador.map((m) => [m.nome, m.quantidade])}
              />
              <Contagem
                titulo="Residentes"
                itens={relatorio.porResidente.map((m) => [m.nome, m.quantidade])}
              />
            </div>
          )}
          <div className="acoes">
            <button type="button" className="botao" onClick={() => void exportar("csv")}>
              Exportar planilha
            </button>
            <button type="button" className="botao" onClick={() => void exportar("pdf")}>
              Exportar PDF
            </button>
          </div>
          {relatorio.itens.length === 0 ? (
            <p className="alertas__vazio">Nenhuma exceção neste período.</p>
          ) : (
            <div className="tabela-rolavel">
              <table className="tabela">
                <caption className="so-leitor">Exceções de conferência no período</caption>
                <thead>
                  <tr>
                    <th scope="col">Quando</th>
                    <th scope="col">Residente</th>
                    <th scope="col">Medicamento</th>
                    <th scope="col">Motivo</th>
                    <th scope="col">Justificativa</th>
                    <th scope="col">Registrou</th>
                    <th scope="col">Liberou</th>
                  </tr>
                </thead>
                <tbody>
                  {relatorio.itens.map((i) => (
                    <tr key={i.administracaoId}>
                      <td>{quando(i.ocorridaEm)}</td>
                      <td>{i.idosoNome}</td>
                      <td>
                        {i.medicamento}
                        <span className="tabela__codigo">
                          {RESULTADOS[i.resultado] ?? i.resultado}
                        </span>
                      </td>
                      <td>{MOTIVOS[i.motivo] ?? i.motivo}</td>
                      <td>{i.justificativa}</td>
                      <td>{i.registradoPor}</td>
                      <td>{i.liberadoPor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {dialogo}
    </section>
  );
}
