"use client";

import { useCallback, useState } from "react";
import type { PrescricaoDetalhada } from "@/modules/prescricoes";
import { chamar } from "../../../_comum/api";
import { useAoAbrir } from "../../../_comum/ao-abrir";
import { UNIDADES, VIAS, type Medicamento } from "../../../_comum/opcoes";

// Prescrições do residente: ver as vigentes, prescrever (regular com horários ou "se necessário")
// e encerrar com motivo. Conflito com alergia pede uma justificativa e nova tentativa.

const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

export function PrescricoesDoResidente({
  idosoId,
  aoPerderSessao,
}: {
  idosoId: string;
  aoPerderSessao: () => void;
}) {
  const [lista, setLista] = useState<PrescricaoDetalhada[] | null>(null);
  const [remedios, setRemedios] = useState<Medicamento[]>([]);
  const [msg, setMsg] = useState<{ texto: string; ok: boolean } | null>(null);
  const [pedeJustificativa, setPedeJustificativa] = useState(false);
  const [f, setF] = useState({
    med: "",
    tipo: "regular",
    dose: "",
    unidade: "comprimido",
    via: "oral",
    horarios: "08:00",
    inicio: hoje(),
    fim: "",
    instrucoes: "",
    indicacao: "",
    limite: "3",
    intervalo: "240",
    prescritor: "",
    justificativa: "",
  });

  const carregar = useCallback(async () => {
    const [p, m] = await Promise.all([
      chamar<{ prescricoes: PrescricaoDetalhada[] }>("GET", `/idosos/${idosoId}/prescricoes`),
      chamar<{ medicamentos: Medicamento[] }>("GET", "/medicamentos"),
    ]);
    if (p.status === 401) return aoPerderSessao();
    if (p.status === 200) setLista(p.corpo.prescricoes);
    if (m.status === 200) setRemedios(m.corpo.medicamentos);
  }, [idosoId, aoPerderSessao]);
  useAoAbrir(carregar);

  const prescrever = async () => {
    const med = remedios.find((m) => m.id === f.med);
    const sos = f.tipo === "sos";
    const corpo = {
      medicamentoId: f.med,
      tipo: f.tipo,
      dose: Number(f.dose.replace(",", ".")),
      unidade: f.unidade,
      via: f.via,
      instrucoes: f.instrucoes.trim() || null,
      inicio: f.inicio,
      fim: f.fim || null,
      altoRisco: med?.altoRisco ?? false,
      horarios: sos
        ? []
        : f.horarios
            .split(/[\s,;]+/)
            .filter(Boolean)
            .map((hora) => ({ hora })),
      sos: sos
        ? {
            indicacao: f.indicacao,
            limiteDiario: Number(f.limite),
            intervaloMinimoMin: Number(f.intervalo),
          }
        : null,
      prescritor: f.prescritor.trim() || null,
      ...(f.justificativa.trim() ? { justificativaAlergia: f.justificativa.trim() } : {}),
    };
    const r = await chamar<{ erro?: string; problemas?: string[] }>(
      "POST",
      `/idosos/${idosoId}/prescricoes`,
      corpo,
    );
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 201) {
      setMsg({ texto: "Prescrição salva e escala gerada.", ok: true });
      setPedeJustificativa(false);
      setF({ ...f, med: "", dose: "", instrucoes: "", justificativa: "" });
      return carregar();
    }
    if (r.corpo.erro === "conflito_alergia") {
      setPedeJustificativa(true);
      setMsg({
        texto:
          "Este remédio conflita com uma alergia do residente. Se mesmo assim for correto, explique abaixo e salve de novo.",
        ok: false,
      });
      return;
    }
    setMsg({
      texto: r.corpo.problemas?.join(" ") ?? r.corpo.erro ?? "Não foi possível salvar.",
      ok: false,
    });
  };

  const encerrar = async (id: string) => {
    const motivo = window.prompt("Motivo do encerramento:");
    if (!motivo?.trim()) return;
    const r = await chamar<{ erro?: string }>("POST", `/prescricoes/${id}/encerrar`, {
      motivo: motivo.trim(),
    });
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200) {
      setMsg({ texto: "Prescrição encerrada.", ok: true });
      return carregar();
    }
    setMsg({ texto: r.corpo.erro ?? "Não foi possível encerrar.", ok: false });
  };

  return (
    <div className="cartao">
      <h2 className="cartao__titulo">Prescrições</h2>
      {msg && (
        <p className={msg.ok ? "aviso aviso--ok" : "aviso aviso--erro"} role="status">
          {msg.texto}
        </p>
      )}
      {lista === null ? (
        <p className="tela__texto">Carregando…</p>
      ) : lista.length === 0 ? (
        <p className="tela__texto">Nenhuma prescrição vigente.</p>
      ) : (
        <ul className="lista-simples">
          {lista.map((p) => (
            <li key={p.id}>
              <span>
                <strong>
                  {p.medicamento.nomeComercial}
                  {p.medicamento.concentracao ? ` ${p.medicamento.concentracao}` : ""}
                </strong>
                {" · "}
                {p.dose} {p.unidade} · {p.via}
                {p.tipo === "sos"
                  ? ` · se necessário (${p.sos?.indicacao ?? ""})`
                  : ` · ${p.horarios.map((h) => h.hora).join(", ")}`}
                {p.altoRisco && " · ALTO RISCO"}
                {p.fim ? ` · até ${p.fim.split("-").reverse().join("/")}` : " · uso contínuo"}
              </span>
              <button
                type="button"
                className="botao botao--discreto"
                onClick={() => void encerrar(p.id)}
              >
                Encerrar
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="grupo"
        onSubmit={(e) => {
          e.preventDefault();
          void prescrever();
        }}
      >
        <h3 className="cartao__titulo">Nova prescrição</h3>
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
                    {m.altoRisco ? " (alto risco)" : ""}
                  </option>
                ))}
            </select>
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Tipo</span>
            <select
              className="campo__entrada"
              value={f.tipo}
              onChange={(e) => setF({ ...f, tipo: e.target.value })}
            >
              <option value="regular">Regular (horários)</option>
              <option value="sos">Se necessário</option>
            </select>
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Dose</span>
            <input
              className="campo__entrada"
              inputMode="decimal"
              required
              value={f.dose}
              onChange={(e) => setF({ ...f, dose: e.target.value })}
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
          <label className="campo campo--curto">
            <span className="campo__rotulo">Via</span>
            <select
              className="campo__entrada"
              value={f.via}
              onChange={(e) => setF({ ...f, via: e.target.value })}
            >
              {VIAS.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          {f.tipo === "regular" ? (
            <label className="campo">
              <span className="campo__rotulo">Horários (ex.: 08:00 20:00)</span>
              <input
                className="campo__entrada"
                required
                value={f.horarios}
                onChange={(e) => setF({ ...f, horarios: e.target.value })}
              />
            </label>
          ) : (
            <>
              <label className="campo">
                <span className="campo__rotulo">Indicação</span>
                <input
                  className="campo__entrada"
                  required
                  maxLength={200}
                  value={f.indicacao}
                  onChange={(e) => setF({ ...f, indicacao: e.target.value })}
                />
              </label>
              <label className="campo campo--curto">
                <span className="campo__rotulo">Máximo por dia</span>
                <input
                  className="campo__entrada"
                  inputMode="numeric"
                  required
                  value={f.limite}
                  onChange={(e) => setF({ ...f, limite: e.target.value })}
                />
              </label>
              <label className="campo campo--curto">
                <span className="campo__rotulo">Intervalo mínimo (min)</span>
                <input
                  className="campo__entrada"
                  inputMode="numeric"
                  required
                  value={f.intervalo}
                  onChange={(e) => setF({ ...f, intervalo: e.target.value })}
                />
              </label>
            </>
          )}
          <label className="campo campo--curto">
            <span className="campo__rotulo">Início</span>
            <input
              className="campo__entrada"
              type="date"
              required
              value={f.inicio}
              onChange={(e) => setF({ ...f, inicio: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Fim (vazio = contínuo)</span>
            <input
              className="campo__entrada"
              type="date"
              value={f.fim}
              onChange={(e) => setF({ ...f, fim: e.target.value })}
            />
          </label>
          <label className="campo">
            <span className="campo__rotulo">Prescritor</span>
            <input
              className="campo__entrada"
              maxLength={200}
              value={f.prescritor}
              onChange={(e) => setF({ ...f, prescritor: e.target.value })}
            />
          </label>
          <label className="campo">
            <span className="campo__rotulo">Instruções</span>
            <input
              className="campo__entrada"
              maxLength={500}
              value={f.instrucoes}
              onChange={(e) => setF({ ...f, instrucoes: e.target.value })}
            />
          </label>
        </div>
        {pedeJustificativa && (
          <label className="campo">
            <span className="campo__rotulo">Justificativa do conflito com alergia</span>
            <input
              className="campo__entrada"
              required
              maxLength={500}
              value={f.justificativa}
              onChange={(e) => setF({ ...f, justificativa: e.target.value })}
            />
          </label>
        )}
        <div className="acoes">
          <button type="submit" className="botao botao--principal">
            Salvar prescrição
          </button>
        </div>
      </form>
    </div>
  );
}
