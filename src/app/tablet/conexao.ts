"use client";

import { useEffect, useState } from "react";
import { chamar } from "./api";

// Estado da conexão (spec 5.8 e T46). O navegador avisa quando perde a rede, mas "conectado ao
// Wi-Fi" não é "o servidor responde": por isso também há uma batida leve a cada 15 segundos.
// Sem conexão, o tablet impede novos registros e manda usar a folha de contingência.
//
// A batida usa uma rota do APARELHO, não da sessão: bater numa rota da sessão a renovaria a cada
// 15 segundos e anularia o bloqueio por inatividade de 2 minutos.

const INTERVALO_MS = 15_000;

export function useConexao(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let ativo = true;
    const conferir = async () => {
      if (!navigator.onLine) {
        if (ativo) setOnline(false);
        return;
      }
      const r = await chamar("GET", "/tablet/usuarios");
      if (ativo) setOnline(!r.semRede && r.status < 500);
    };
    const caiu = () => setOnline(false);
    const voltou = () => void conferir();
    window.addEventListener("offline", caiu);
    window.addEventListener("online", voltou);
    const relogio = window.setInterval(() => void conferir(), INTERVALO_MS);
    void conferir();
    return () => {
      ativo = false;
      window.removeEventListener("offline", caiu);
      window.removeEventListener("online", voltou);
      window.clearInterval(relogio);
    };
  }, []);
  return online;
}
