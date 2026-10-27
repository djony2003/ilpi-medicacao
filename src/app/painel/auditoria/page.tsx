"use client";

import { useCallback, useState } from "react";
import type { RegistroDeAuditoria } from "@/modules/relatorios";
import { baixar, chamar } from "../../_comum/api";
import { useAoAbrir } from "../../_comum/ao-abrir";
import { FUSO_PADRAO } from "../../_comum/formato";
import { useComSenha } from "../../_comum/pedir-senha";
import { GRUPOS_DE_ACAO, nomeDaAcao } from "../../_comum/rotulos";
import { usePainel } from "../contexto";

// Trilha de auditoria (spec 7.6): quem fez o quê e quando, com filtros. Só a gestão. A trilha
// não se edita nem se apaga; aqui só se consulta, se exporta (PDF ou planilha, com a senha) e se
// confere a integridade da cadeia de registros.

type Pessoa = { id: string; nome: string };
type Filtro = Record<string, string>;
type Verificacao = { integra: boolean; problema: { seq: number; problema: string } | null };

const dia = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO_PADRAO }).format(d);
const quando = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_PADRAO,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));

export default function PaginaDaAuditoria() {
  const { aoPerderSessao } = usePainel();
  const { executar, dialogo } = useComSenha();
  const [padrao] = useState(() => ({
    hoje: dia(new Date()),
    de: dia(new Date(Date.now() - 6 * 86_400_000)),
  }));
  const hoje = padrao.hoje;
  const [de, setDe] = useState(padrao.de);
  const [ate, setAte] = useState(padrao.hoje);
  const [grupo, setGrupo] = useState("");
  const [usuarioId, setUsuarioId] = useState("");
  const [pessoas, setPessoas] = useState<Pessoa[]>([]);
  const [registros, setRegistros] = useState<RegistroDeAuditoria[] | null>(null);
  // O filtro da lista que está na tela: "carregar mais" continua dela, mesmo que o formulário
  // já tenha sido mexido.
  const [aplicado, setAplicado] = useState<Filtro | null>(null);
  const [proxima, setProxima] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [verificacao, setVerificacao] = useState<Verificacao | null>(null);

  const filtro = (): Filtro => ({
    de,
    ate,
    ...(grupo ? { acao: grupo } : {}),
    ...(usuarioId ? { usuarioId } : {}),
  });

  const buscar = useCallback(
    async (f: Filtro, depoisDe?: number) => {
      const q = new URLSearchParams(f);
      if (depoisDe !== undefined) q.set("antesDeSeq", String(depoisDe));
      const r = await chamar<{ registros: RegistroDeAuditoria[]; proximaPagina: number | null }>(
        "GET",
        `/admin/auditoria?${q}`,
      );
      if (r.status === 401) return aoPerderSessao();
      if (r.status !== 200) {
        setErro(
          r.semRede
            ? "Sem conexão com o servidor."
            : r.status === 400
              ? "Confira as datas: a inicial não pode ser depois da final."
              : "Não foi possível consultar a trilha.",
        );
        return;
      }
      setErro(null);
      setAplicado(f);
      setRegistros((antes) =>
        depoisDe === undefined ? r.corpo.registros : [...(antes ?? []), ...r.corpo.registros],
      );
      setProxima(r.corpo.proximaPagina);
    },
    [aoPerderSessao],
  );

  const abrir = useCallback(async () => {
    const [p] = await Promise.all([
      chamar<{ usuarios: Array<{ id: string; nome: string }> }>("GET", "/admin/usuarios"),
      buscar({ de: padrao.de, ate: padrao.hoje }),
    ]);
    if (p.status === 200) setPessoas(p.corpo.usuarios.map((u) => ({ id: u.id, nome: u.nome })));
  }, [buscar, padrao]);
  useAoAbrir(abrir);

  const consultar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setRegistros(null);
    await buscar(filtro());
    setOcupado(false);
  };

  const exportar = async (formato: "pdf" | "csv") => {
    setAviso(null);
    const r = await executar(() =>
      baixar("/admin/auditoria/exportar", { formato, filtro: filtro() }, `auditoria.${formato}`),
    );
    if (r === null) return;
    if (r.status === 401) return aoPerderSessao();
    setAviso(
      r.status === 200
        ? "Arquivo gerado. A exportação ficou registrada na trilha."
        : "Não foi possível gerar o arquivo.",
    );
  };

  const verificar = async () => {
    const r = await chamar<{ verificacao: Verificacao }>("GET", "/admin/auditoria/verificar");
    if (r.status === 200) setVerificacao(r.corpo.verificacao);
    else setErro("Não foi possível verificar a integridade.");
  };

  return (
    <section aria-labelledby="auditoria-titulo">
      <h1 id="auditoria-titulo" className="tela__titulo">
        Auditoria
      </h1>
      <p className="tela__texto">
        Todo registro importante do sistema fica aqui, sem poder ser alterado ou apagado.
      </p>

      <form className="filtros" onSubmit={(e) => void consultar(e)}>
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
        <label className="campo">
          <span className="campo__rotulo">Assunto</span>
          <select
            className="campo__entrada"
            value={grupo}
            onChange={(e) => setGrupo(e.target.value)}
          >
            <option value="">Todos</option>
            {GRUPOS_DE_ACAO.map((g) => (
              <option key={g.prefixo} value={g.prefixo}>
                {g.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span className="campo__rotulo">Pessoa</span>
          <select
            className="campo__entrada"
            value={usuarioId}
            onChange={(e) => setUsuarioId(e.target.value)}
          >
            <option value="">Todas</option>
            {pessoas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="botao botao--principal" disabled={ocupado}>
          Consultar
        </button>
      </form>

      <div className="acoes">
        <button type="button" className="botao" onClick={() => void exportar("csv")}>
          Exportar planilha
        </button>
        <button type="button" className="botao" onClick={() => void exportar("pdf")}>
          Exportar PDF
        </button>
        <button type="button" className="botao" onClick={() => void verificar()}>
          Verificar integridade
        </button>
      </div>

      {verificacao && (
        <p
          className={verificacao.integra ? "aviso aviso--ok" : "aviso aviso--erro"}
          role={verificacao.integra ? "status" : "alert"}
        >
          {verificacao.integra
            ? "A cadeia de registros está íntegra: nada foi alterado nem removido do meio."
            : `Problema na cadeia a partir do registro nº ${verificacao.problema?.seq}. Avise o suporte.`}
        </p>
      )}
      {aviso && (
        <p className="aviso aviso--ok" role="status">
          {aviso}
        </p>
      )}
      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}

      {registros === null ? (
        <p className="tela__texto">Carregando…</p>
      ) : registros.length === 0 ? (
        <p className="alertas__vazio">Nenhum registro com esses filtros.</p>
      ) : (
        <div className="tabela-rolavel">
          <table className="tabela">
            <caption className="so-leitor">Registros da trilha de auditoria</caption>
            <thead>
              <tr>
                <th scope="col">Nº</th>
                <th scope="col">Quando</th>
                <th scope="col">Pessoa</th>
                <th scope="col">O que aconteceu</th>
                <th scope="col">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {registros.map((r) => (
                <tr key={r.seq}>
                  <td>{r.seq}</td>
                  <td>{quando(r.ocorridoEm)}</td>
                  <td>{r.usuarioNome ?? "Sistema"}</td>
                  <td>
                    {nomeDaAcao(r.acao)}
                    <span className="tabela__codigo">{r.acao}</span>
                  </td>
                  <td>
                    {r.antes === null && r.depois === null ? (
                      "—"
                    ) : (
                      <details>
                        <summary>Ver</summary>
                        {r.antes !== null && (
                          <pre className="tabela__json">
                            Antes: {JSON.stringify(r.antes, null, 1)}
                          </pre>
                        )}
                        {r.depois !== null && (
                          <pre className="tabela__json">
                            Depois: {JSON.stringify(r.depois, null, 1)}
                          </pre>
                        )}
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {proxima !== null && (
        <div className="acoes">
          <button
            type="button"
            className="botao"
            onClick={() => aplicado && void buscar(aplicado, proxima)}
          >
            Carregar mais
          </button>
        </div>
      )}
      {dialogo}
    </section>
  );
}
