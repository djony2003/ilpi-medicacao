"use client";

import { useState } from "react";

// Teclado numérico grande para o PIN de 6 dígitos. Teclas de 88 px: dá para acertar de luva.
// Os dígitos aparecem como bolinhas; o PIN só sai daqui quando os 6 estão digitados.

const TAMANHO = 6;

export function TecladoPin({
  titulo,
  explicacao,
  erro,
  ocupado = false,
  rotuloConfirmar = "Confirmar",
  aoConfirmar,
  aoCancelar,
}: {
  titulo: string;
  explicacao?: string;
  erro?: string | null;
  ocupado?: boolean;
  rotuloConfirmar?: string;
  aoConfirmar: (pin: string) => void;
  aoCancelar?: () => void;
}) {
  const [pin, setPin] = useState("");

  const tocar = (d: string) => setPin((p) => (p.length < TAMANHO ? p + d : p));
  const apagar = () => setPin((p) => p.slice(0, -1));
  const confirmar = () => {
    if (pin.length !== TAMANHO || ocupado) return;
    aoConfirmar(pin);
    setPin("");
  };

  return (
    <section className="pin" aria-labelledby="pin-titulo">
      <h2 id="pin-titulo" className="pin__titulo">
        {titulo}
      </h2>
      {explicacao && <p className="pin__explicacao">{explicacao}</p>}
      <div className="pin__pontos" aria-label={`${pin.length} de ${TAMANHO} dígitos`}>
        {Array.from({ length: TAMANHO }, (_, i) => (
          <span
            key={i}
            className={i < pin.length ? "pin__ponto pin__ponto--cheio" : "pin__ponto"}
          />
        ))}
      </div>
      {erro && (
        <p className="pin__erro" role="alert">
          {erro}
        </p>
      )}
      <div className="pin__teclas">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className="pin__tecla" onClick={() => tocar(d)}>
            {d}
          </button>
        ))}
        <button
          type="button"
          className="pin__tecla pin__tecla--apagar"
          onClick={apagar}
          aria-label="Apagar"
        >
          ⌫
        </button>
        <button type="button" className="pin__tecla" onClick={() => tocar("0")}>
          0
        </button>
        <button
          type="button"
          className="pin__tecla pin__tecla--ok"
          onClick={confirmar}
          disabled={pin.length !== TAMANHO || ocupado}
          aria-label={rotuloConfirmar}
        >
          ✓
        </button>
      </div>
      <div className="acoes">
        <button
          type="button"
          className="botao botao--principal"
          onClick={confirmar}
          disabled={pin.length !== TAMANHO || ocupado}
        >
          {ocupado ? "Conferindo…" : rotuloConfirmar}
        </button>
        {aoCancelar && (
          <button type="button" className="botao" onClick={aoCancelar}>
            Cancelar
          </button>
        )}
      </div>
    </section>
  );
}
