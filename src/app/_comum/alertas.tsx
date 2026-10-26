"use client";

import { useCallback, useEffect, useState } from "react";
import type { AlertaDoPainel } from "@/modules/alertas";
import { chamar } from "./api";
import { hora } from "./formato";

// Lista de alertas (spec 6.4), a mesma no painel do computador e no tablet da enfermagem.
// Urgentes primeiro. Cada pessoa marca o que leu (é o que segura o escalonamento e o reaviso);
// encerrar à mão pede uma frase sobre como foi tratado.

const TIPO: Record<AlertaDoPainel["tipo"], string> = {
  estoque_acabando: "Estoque",
  validade_proxima: "Validade",
  lote_vencido: "Lote vencido",
  dose_atrasada: "Dose atrasada",
  dose_sem_registro: "Dose sem registro",
  prescricao_vencendo: "Prescrição",
  excecoes_do_dia: "Exceções",
  excecoes_repetidas: "Exceções",
  sos_bloqueado: "Dose se necessário",
};

const RESOLUCAO: Record<NonNullable<AlertaDoPainel["resolucao"]>, string> = {
  automatica: "Resolvido sozinho",
  lido: "Ciente",
  manual: "Encerrado",
};

function quando(iso: string, fuso: string): string {
  const d = new Date(iso);
  const hoje = new Date();
  const mesmoDia =
    new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(d) ===
    new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(hoje);
  if (mesmoDia) return `hoje às ${hora(iso, fuso)}`;
  const data = new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    day: "2-digit",
    month: "2-digit",
  }).format(d);
  return `${data} às ${hora(iso, fuso)}`;
}

export function ListaDeAlertas({
  fuso,
  aoPerderSessao,
  aoMudar,
}: {
  fuso: string;
  aoPerderSessao: () => void;
  /** Avisado depois de ler ou encerrar (para atualizar o contador). */
  aoMudar?: () => void;
}) {
  const [estado, setEstado] = useState<"aberto" | "resolvido">("aberto");
  const [alertas, setAlertas] = useState<AlertaDoPainel[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const r = await chamar<{ alertas: AlertaDoPainel[] }>("GET", `/alertas?estado=${estado}`);
    if (r.status === 401) return aoPerderSessao();
    if (r.status !== 200)
      return setErro(
        r.semRede ? "Sem conexão com o servidor." : "Não foi possível carregar os alertas.",
      );
    setErro(null);
    setAlertas(r.corpo.alertas);
  }, [estado, aoPerderSessao]);

  useEffect(() => {
    let ativo = true;
    const tentar = () => {
      if (ativo) void carregar();
    };
    tentar();
    const relogio = window.setInterval(tentar, 60_000);
    return () => {
      ativo = false;
      window.clearInterval(relogio);
    };
  }, [carregar]);

  const depoisDeMudar = async () => {
    await carregar();
    aoMudar?.();
  };

  return (
    <section className="alertas" aria-labelledby="alertas-titulo">
      <div className="alertas__topo">
        <h1 id="alertas-titulo" className="tela__titulo">
          Alertas
        </h1>
        <div className="abas" role="tablist" aria-label="Situação">
          {(
            [
              ["aberto", "Abertos"],
              ["resolvido", "Resolvidos"],
            ] as const
          ).map(([v, t]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={estado === v}
              className={estado === v ? "aba aba--atual" : "aba"}
              onClick={() => {
                setAlertas(null);
                setEstado(v);
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {erro && <p className="aviso aviso--erro">{erro}</p>}
      {alertas === null ? (
        <p className="tela__texto">Carregando…</p>
      ) : alertas.length === 0 ? (
        <p className="alertas__vazio">
          {estado === "aberto"
            ? "Nenhum alerta aberto. Tudo em dia."
            : "Nenhum alerta resolvido recentemente."}
        </p>
      ) : (
        <ul className="alertas__lista">
          {alertas.map((a) => (
            <li key={a.id}>
              <CartaoDeAlerta
                alerta={a}
                fuso={fuso}
                aoMudar={() => void depoisDeMudar()}
                aoPerderSessao={aoPerderSessao}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CartaoDeAlerta({
  alerta: a,
  fuso,
  aoMudar,
  aoPerderSessao,
}: {
  alerta: AlertaDoPainel;
  fuso: string;
  aoMudar: () => void;
  aoPerderSessao: () => void;
}) {
  const [encerrando, setEncerrando] = useState(false);
  const [justificativa, setJustificativa] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const urgente = a.gravidade === "urgente";

  const agir = async (caminho: string, corpo: object) => {
    setOcupado(true);
    const r = await chamar("POST", `/alertas/${a.id}/${caminho}`, corpo);
    setOcupado(false);
    if (r.status === 401) return aoPerderSessao();
    if (r.status !== 200) {
      return setErro(
        r.corpo.erro === "ja_resolvido"
          ? "Alguém já encerrou este alerta."
          : "Não foi possível salvar.",
      );
    }
    setEncerrando(false);
    aoMudar();
  };

  return (
    <article
      className={`alerta ${urgente ? "alerta--urgente" : "alerta--aviso"} ${a.estado === "resolvido" ? "alerta--resolvido" : ""}`}
    >
      <div className="alerta__cabeca">
        <span className={`gravidade ${urgente ? "gravidade--urgente" : "gravidade--aviso"}`}>
          <span aria-hidden="true">{urgente ? "!" : "i"}</span> {urgente ? "Urgente" : "Aviso"}
        </span>
        <span className="alerta__tipo">{TIPO[a.tipo]}</span>
        <span className="alerta__quando">aberto {quando(a.abertoEm, fuso)}</span>
      </div>
      <p className="alerta__titulo">{a.titulo}</p>
      {a.detalhe && <p className="alerta__detalhe">{a.detalhe}</p>}
      <p className="alerta__meta">
        {a.escalado && a.estado === "aberto" && (
          <span className="alerta__escalado">Encaminhado à gestão. </span>
        )}
        {a.leituras.length > 0
          ? `Lido por ${a.leituras.map((l) => `${l.nome} (${hora(l.lidoEm, fuso)})`).join(", ")}.`
          : a.estado === "aberto"
            ? "Ninguém leu ainda."
            : ""}
        {a.estado === "resolvido" && a.resolucao && (
          <>
            {" "}
            {RESOLUCAO[a.resolucao]}
            {a.resolvidoPor ? ` por ${a.resolvidoPor}` : ""}
            {a.resolvidoEm ? ` ${quando(a.resolvidoEm, fuso)}` : ""}
            {a.justificativa ? `: “${a.justificativa}”` : "."}
          </>
        )}
      </p>
      {erro && <p className="aviso aviso--erro">{erro}</p>}
      {a.estado === "aberto" &&
        (encerrando ? (
          <form
            className="alerta__encerrar"
            onSubmit={(e) => {
              e.preventDefault();
              void agir("encerrar", { justificativa });
            }}
          >
            <label className="campo">
              <span className="campo__rotulo">Como foi tratado</span>
              <input
                className="campo__entrada"
                value={justificativa}
                onChange={(e) => setJustificativa(e.target.value)}
                maxLength={500}
                placeholder="Ex.: compra feita, chega amanhã"
                autoFocus
              />
            </label>
            <div className="acoes">
              <button
                type="submit"
                className="botao botao--principal"
                disabled={ocupado || justificativa.trim().length < 5}
              >
                Encerrar alerta
              </button>
              <button type="button" className="botao" onClick={() => setEncerrando(false)}>
                Cancelar
              </button>
            </div>
          </form>
        ) : (
          <div className="acoes">
            {!a.lidoPorMim && (
              <button
                type="button"
                className="botao botao--principal"
                disabled={ocupado}
                onClick={() => void agir("lido", {})}
              >
                {a.informativo ? "Ciente" : "Marcar como lido"}
              </button>
            )}
            {!a.informativo && (
              <button
                type="button"
                className="botao"
                disabled={ocupado}
                onClick={() => setEncerrando(true)}
              >
                Encerrar
              </button>
            )}
          </div>
        ))}
    </article>
  );
}

/** Contador para o menu: abertos não lidos por quem está vendo, e quantos são urgentes. */
export function useResumoDosAlertas(ativo: boolean): {
  resumo: { abertos: number; urgentes: number; naoLidosPorMim: number } | null;
  atualizar: () => void;
} {
  const [resumo, setResumo] = useState<{
    abertos: number;
    urgentes: number;
    naoLidosPorMim: number;
  } | null>(null);
  const [vez, setVez] = useState(0);
  useEffect(() => {
    if (!ativo) return;
    let vivo = true;
    const buscar = async () => {
      const r = await chamar<{
        resumo: { abertos: number; urgentes: number; naoLidosPorMim: number };
      }>("GET", "/alertas/resumo");
      if (vivo && r.status === 200) setResumo(r.corpo.resumo);
    };
    void buscar();
    const relogio = window.setInterval(() => void buscar(), 60_000);
    return () => {
      vivo = false;
      window.clearInterval(relogio);
    };
  }, [ativo, vez]);
  return { resumo: ativo ? resumo : null, atualizar: () => setVez((n) => n + 1) };
}
