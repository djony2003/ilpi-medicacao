"use client";

import { dataCurta, hora, quantidade, via } from "../_comum/formato";
import type { Bloqueio, ConferenciaDaDose } from "./tipos";

// Peças visuais repetidas no registro: a faixa de conferência, o cartão do paciente, os passos e
// a escolha de motivo.

/** A faixa que diz, de longe, se confere ou não. É o elemento mais forte da tela. */
export function Faixa({
  tipo,
  titulo,
  bloqueios,
}: {
  tipo: "ok" | "bloqueio" | "atencao";
  titulo: string;
  bloqueios?: Bloqueio[];
}) {
  const icone = tipo === "ok" ? "✓" : tipo === "bloqueio" ? "✕" : "!";
  return (
    <div className={`faixa faixa--${tipo}`} role={tipo === "ok" ? "status" : "alert"}>
      <span className="faixa__icone" aria-hidden="true">
        {icone}
      </span>
      <div className="faixa__texto">
        <p className="faixa__titulo">{titulo}</p>
        {bloqueios && bloqueios.length > 0 && (
          <ul className="faixa__lista">
            {bloqueios.map((b) => (
              <li key={b.codigo}>
                <strong>{b.mensagem}.</strong> {b.acao}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Passos({ atual }: { atual: 1 | 2 | 3 }) {
  const nomes = ["Pulseira", "Remédio", "Resultado"];
  return (
    <ol className="passos" aria-label="Passos do registro">
      {nomes.map((n, i) => {
        const numero = i + 1;
        const classe =
          numero < atual ? "passo passo--feito" : numero === atual ? "passo passo--atual" : "passo";
        return (
          <li key={n} className={classe} aria-current={numero === atual ? "step" : undefined}>
            <span className="passo__numero">{numero < atual ? "✓" : numero}</span>
            {n}
          </li>
        );
      })}
    </ol>
  );
}

/** O paciente e o remédio, sempre à vista durante o registro. Alergias em destaque. */
export function CartaoDoPaciente({
  conferencia: c,
  fuso,
}: {
  conferencia: ConferenciaDaDose;
  fuso: string;
}) {
  const d = c.dose;
  const adiada = d.referenciaEm !== d.previstaEm;
  return (
    <aside className="paciente">
      <p className="paciente__nome">{d.idosoNome}</p>
      {d.quarto && <p className="paciente__quarto">Quarto {d.quarto}</p>}
      {c.alergias.length > 0 ? (
        <div className="paciente__alergias" role="note">
          <p className="paciente__alergias-titulo">Alergias</p>
          <ul>
            {c.alergias.map((a) => (
              <li key={a.substancia}>
                {a.substancia} <span className="paciente__gravidade">({a.gravidade})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="paciente__sem-alergia">Sem alergias cadastradas</p>
      )}
      <dl className="paciente__dose">
        <dt>Remédio</dt>
        <dd className="paciente__remedio">
          {d.medicamento.nome}
          {d.medicamento.concentracao ? ` ${d.medicamento.concentracao}` : ""}
          <span className="paciente__principio">{d.medicamento.principioAtivo}</span>
        </dd>
        <dt>Dose</dt>
        <dd>
          {quantidade(d.dose, d.unidade)}, {via(d.via)}
        </dd>
        <dt>Horário</dt>
        <dd>
          {adiada ? `${hora(d.referenciaEm, fuso)} (adiada de ${d.horaLocal})` : d.horaLocal}
          {d.dataLocal ? `, ${dataCurta(d.dataLocal)}` : ""}
        </dd>
        {d.instrucoes && (
          <>
            <dt>Instruções</dt>
            <dd>{d.instrucoes}</dd>
          </>
        )}
      </dl>
      {d.altoRisco && (
        <p className="selo selo--risco selo--grande">Alto risco: precisa de uma segunda pessoa</p>
      )}
      {c.alergiasConfirmadas.length > 0 && (
        <p className="aviso aviso--atencao">
          Alergia a {c.alergiasConfirmadas.map((a) => a.substancia).join(", ")} conhecida: quem
          prescreveu avaliou e manteve o remédio.
        </p>
      )}
    </aside>
  );
}

/** Motivos prontos (um toque) mais o campo livre. */
export function EscolhaDeMotivo({
  titulo,
  sugestoes,
  valor,
  aoMudar,
}: {
  titulo: string;
  sugestoes: string[];
  valor: string;
  aoMudar: (v: string) => void;
}) {
  return (
    <fieldset className="motivo">
      <legend className="motivo__titulo">{titulo}</legend>
      <div className="motivo__opcoes">
        {sugestoes.map((s) => (
          <button
            key={s}
            type="button"
            className={valor === s ? "opcao opcao--marcada" : "opcao"}
            aria-pressed={valor === s}
            onClick={() => aoMudar(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <label className="campo">
        <span className="campo__rotulo">Outro motivo</span>
        <input
          className="campo__entrada"
          value={sugestoes.includes(valor) ? "" : valor}
          onChange={(e) => aoMudar(e.target.value)}
          maxLength={500}
          placeholder="Escreva o motivo"
        />
      </label>
    </fieldset>
  );
}
