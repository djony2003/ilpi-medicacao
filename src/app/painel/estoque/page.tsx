"use client";

import { useCallback, useState } from "react";
import { baixar, chamar } from "../../_comum/api";
import { useAoAbrir } from "../../_comum/ao-abrir";
import { UNIDADES, type Medicamento } from "../../_comum/opcoes";
import { usePainel } from "../contexto";

// Estoque: situação por reserva (comum da casa ou individual), entrada de lote e impressão da
// etiqueta (QR) e da lista de reposição.

type Reserva = {
  chave: string;
  dono: "individual" | "comum";
  idosoNome: string | null;
  medicamento: { nome: string; concentracao: string | null };
  unidade: string;
  lotes: Array<{
    id: string;
    numeroLote: string;
    validade: string;
    situacaoDeValidade: string;
    saldo: number;
  }>;
  saldoDisponivel: number;
  saldoVencido: number;
  previsao: { situacao: string; diasRestantes: number | null; esgotaEm: string | null } | null;
  semPrevisao: string | null;
  situacao: "ok" | "aviso" | "urgente" | null;
};
type Idoso = { id: string; nome: string };

const SELO = { ok: "Em dia", aviso: "Atenção", urgente: "Urgente" } as const;
const VALIDADE: Record<string, string> = {
  ok: "",
  aviso: " (vence logo)",
  urgente: " (vence em breve)",
  vencido: " (vencido)",
};

export default function PaginaDoEstoque() {
  const { aoPerderSessao } = usePainel();
  const [reservas, setReservas] = useState<Reserva[] | null>(null);
  const [remedios, setRemedios] = useState<Medicamento[]>([]);
  const [idosos, setIdosos] = useState<Idoso[]>([]);
  const [recado, setRecado] = useState<{ texto: string; ok: boolean } | null>(null);
  const [f, setF] = useState({
    med: "",
    idoso: "",
    lote: "",
    validade: "",
    unidade: "comprimido",
    qtd: "",
  });

  const carregar = useCallback(async () => {
    const [s, m, i] = await Promise.all([
      chamar<{ reservas: Reserva[] }>("GET", "/estoque/situacao"),
      chamar<{ medicamentos: Medicamento[] }>("GET", "/medicamentos"),
      chamar<{ idosos: Idoso[] }>("GET", "/idosos"),
    ]);
    if (s.status === 401) return aoPerderSessao();
    if (s.status === 200) setReservas(s.corpo.reservas);
    if (m.status === 200) setRemedios(m.corpo.medicamentos);
    if (i.status === 200) setIdosos(i.corpo.idosos);
  }, [aoPerderSessao]);
  useAoAbrir(carregar);

  const etiqueta = async (loteId: string) => {
    const r = await baixar(`/estoque/lotes/${loteId}/etiqueta`, {}, "etiqueta.pdf");
    if (r.status >= 400) setRecado({ texto: "Não foi possível gerar a etiqueta.", ok: false });
  };
  const reposicao = async () => {
    const r = await baixar("/estoque/lista-de-reposicao/pdf", {}, "lista-de-reposicao.pdf");
    if (r.status >= 400) setRecado({ texto: "Não foi possível gerar a lista.", ok: false });
  };

  return (
    <section aria-labelledby="estoque-titulo">
      <h1 id="estoque-titulo" className="tela__titulo">
        Estoque
      </h1>
      {recado && (
        <p className={recado.ok ? "aviso aviso--ok" : "aviso aviso--erro"} role="status">
          {recado.texto}
        </p>
      )}

      <form
        className="cartao"
        onSubmit={(e) => {
          e.preventDefault();
          setRecado(null);
          void chamar<{ loteId?: string; problemas?: string[]; erro?: string }>(
            "POST",
            "/estoque/lotes",
            {
              medicamentoId: f.med,
              idosoId: f.idoso || null,
              numeroLote: f.lote,
              validade: f.validade,
              unidade: f.unidade,
              quantidade: Number(f.qtd.replace(",", ".")),
            },
          ).then(async (r) => {
            if (r.status === 401) return aoPerderSessao();
            if (r.status === 201) {
              setRecado({
                texto: "Lote registrado. Imprima a etiqueta e cole na embalagem.",
                ok: true,
              });
              setF({ ...f, lote: "", validade: "", qtd: "" });
              await carregar();
              if (r.corpo.loteId) await etiqueta(r.corpo.loteId);
            } else {
              setRecado({
                texto:
                  r.corpo.problemas?.join(" ") ?? r.corpo.erro ?? "Não foi possível registrar.",
                ok: false,
              });
            }
          });
        }}
      >
        <h2 className="cartao__titulo">Registrar entrada de lote</h2>
        <div className="grade">
          <label className="campo">
            <span className="campo__rotulo">Remédio</span>
            <select
              className="campo__entrada"
              required
              value={f.med}
              onChange={(e) => setF({ ...f, med: e.target.value })}
            >
              <option value="">Escolha…</option>
              {remedios
                .filter((m) => m.ativo)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nomeComercial}
                    {m.concentracao ? ` ${m.concentracao}` : ""}
                  </option>
                ))}
            </select>
          </label>
          <label className="campo">
            <span className="campo__rotulo">De quem é</span>
            <select
              className="campo__entrada"
              value={f.idoso}
              onChange={(e) => setF({ ...f, idoso: e.target.value })}
            >
              <option value="">Estoque comum da casa</option>
              {idosos.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Número do lote</span>
            <input
              className="campo__entrada"
              required
              maxLength={80}
              value={f.lote}
              onChange={(e) => setF({ ...f, lote: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Validade</span>
            <input
              className="campo__entrada"
              type="date"
              required
              value={f.validade}
              onChange={(e) => setF({ ...f, validade: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Quantidade</span>
            <input
              className="campo__entrada"
              inputMode="decimal"
              required
              value={f.qtd}
              onChange={(e) => setF({ ...f, qtd: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Unidade</span>
            <select
              className="campo__entrada"
              value={f.unidade}
              onChange={(e) => setF({ ...f, unidade: e.target.value })}
            >
              {UNIDADES.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="acoes">
          <button type="submit" className="botao botao--principal">
            Registrar e imprimir etiqueta
          </button>
        </div>
      </form>

      <div className="acoes">
        <button type="button" className="botao" onClick={() => void reposicao()}>
          Lista de reposição (PDF)
        </button>
      </div>

      {reservas === null ? (
        <p className="tela__texto">Carregando…</p>
      ) : reservas.length === 0 ? (
        <p className="tela__texto">Nenhum lote registrado ainda.</p>
      ) : (
        reservas.map((r) => (
          <div className="cartao" key={r.chave}>
            <h2 className="cartao__titulo">
              {r.medicamento.nome}
              {r.medicamento.concentracao ? ` ${r.medicamento.concentracao}` : ""}
              {" · "}
              {r.dono === "comum" ? "estoque comum" : r.idosoNome}
            </h2>
            <p className="tela__texto">
              Saldo: <strong>{r.saldoDisponivel}</strong> {r.unidade}
              {r.saldoVencido > 0 && ` (mais ${r.saldoVencido} vencidos)`}
              {" · "}
              {r.situacao ? SELO[r.situacao] : "sem previsão"}
              {r.previsao?.situacao === "acaba" &&
                r.previsao.diasRestantes !== null &&
                ` · acaba em ${r.previsao.diasRestantes} dia(s)`}
              {r.semPrevisao === "unidade_diferente" &&
                " · unidade da receita é diferente da do estoque"}
            </p>
            <ul className="lista-simples">
              {r.lotes.map((l) => (
                <li key={l.id}>
                  <span>
                    Lote {l.numeroLote} · validade {l.validade.split("-").reverse().join("/")}
                    {VALIDADE[l.situacaoDeValidade] ?? ""} · saldo {l.saldo}
                  </span>
                  <button
                    type="button"
                    className="botao botao--discreto"
                    onClick={() => void etiqueta(l.id)}
                  >
                    Etiqueta
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
