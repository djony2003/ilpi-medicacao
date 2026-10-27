"use client";

import { ListaDeAlertas } from "../_comum/alertas";
import { FUSO_PADRAO } from "../_comum/formato";
import { usePainel } from "./contexto";

// Alertas da casa, para a enfermagem e a gestão (T52).

export default function PaginaDosAlertas() {
  const { aoPerderSessao, atualizarAlertas } = usePainel();
  return (
    <ListaDeAlertas fuso={FUSO_PADRAO} aoPerderSessao={aoPerderSessao} aoMudar={atualizarAlertas} />
  );
}
