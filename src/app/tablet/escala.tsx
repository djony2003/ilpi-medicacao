"use client";

import { useCallback, useEffect, useState } from "react";
import { chamar } from "../_comum/api";
import { hora, quantidade } from "../_comum/formato";
import type { DoseDaEscala, EscalaDoPlantao } from "./tipos";

// Escala do plantão (spec 5.1): o que precisa de atenção no topo (sem registro, atrasadas, na
// janela), depois o que vem, depois o que já foi feito. Estado com ícone e texto, nunca só cor.
// Alergias aparecem em todo cartão.

const ESTADO: Record<DoseDaEscala["estado"], { icone: string; texto: string; classe: string }> = {
  sem_registro: { icone: "⚠", texto: "Sem registro", classe: "estado--sem-registro" },
  atrasada: { icone: "⏰", texto: "Atrasada", classe: "estado--atrasada" },
  em_janela: { icone: "●", texto: "Agora", classe: "estado--agora" },
  a_fazer: { icone: "○", texto: "A fazer", classe: "estado--a-fazer" },
  concluida: { icone: "✓", texto: "Concluída", classe: "estado--concluida" },
  cancelada: { icone: "–", texto: "Cancelada", classe: "estado--cancelada" },
};

const RESULTADO: Record<string, string> = {
  administrada: "Administrada",
  recusada: "Recusada",
  nao_administrada: "Não administrada",
};

const ATUALIZAR_MS = 30_000;

export function Escala({
  online,
  aoAbrirDose,
  aoLancarTardio,
  aoAbrirSos,
  aoPerderSessao,
  aoConhecerFuso,
}: {
  online: boolean;
  aoAbrirDose: (id: string) => void;
  aoLancarTardio: (dose: DoseDaEscala) => void;
  aoAbrirSos: () => void;
  aoPerderSessao: () => void;
  aoConhecerFuso: (fuso: string) => void;
}) {
  const [escala, setEscala] = useState<EscalaDoPlantao | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const r = await chamar<{ escala: EscalaDoPlantao }>("GET", "/escala");
    if (r.status === 401) return aoPerderSessao();
    if (r.semRede) return setErro("Sem conexão com o servidor. A lista pode estar desatualizada.");
    if (r.status !== 200) return setErro("Não foi possível carregar a escala.");
    setErro(null);
    setEscala(r.corpo.escala);
    aoConhecerFuso(r.corpo.escala.fuso);
  }, [aoPerderSessao, aoConhecerFuso]);

  useEffect(() => {
    let ativo = true;
    const tentar = () => {
      if (ativo) void carregar();
    };
    tentar();
    const relogio = window.setInterval(tentar, ATUALIZAR_MS);
    return () => {
      ativo = false;
      window.clearInterval(relogio);
    };
  }, [carregar]);

  if (!escala) {
    return <p className="tela__texto">{erro ?? "Carregando a escala…"}</p>;
  }

  const fuso = escala.fuso;
  const agora = escala.doses.filter((d) =>
    ["sem_registro", "atrasada", "em_janela"].includes(d.estado),
  );
  const proximas = escala.doses.filter((d) => d.estado === "a_fazer");
  const feitas = escala.doses.filter((d) => d.estado === "concluida").reverse();

  return (
    <div className="escala">
      <div className="escala__topo">
        <h1 className="tela__titulo">Escala do plantão</h1>
        <button type="button" className="botao botao--sos" onClick={aoAbrirSos} disabled={!online}>
          Dose se necessário
        </button>
      </div>
      {erro && <p className="aviso aviso--atencao">{erro}</p>}
      <Grupo
        titulo="Precisa de atenção"
        vazio="Nenhuma dose pendente agora."
        doses={agora}
        fuso={fuso}
        online={online}
        aoAbrirDose={aoAbrirDose}
        aoLancarTardio={aoLancarTardio}
      />
      <Grupo
        titulo="Próximas"
        vazio="Nada mais previsto nas próximas horas."
        doses={proximas}
        fuso={fuso}
        online={online}
        aoAbrirDose={aoAbrirDose}
        aoLancarTardio={aoLancarTardio}
      />
      {feitas.length > 0 && (
        <Grupo
          titulo="Feitas neste plantão"
          vazio=""
          doses={feitas}
          fuso={fuso}
          online={online}
          aoAbrirDose={aoAbrirDose}
          aoLancarTardio={aoLancarTardio}
        />
      )}
    </div>
  );
}

function Grupo({
  titulo,
  vazio,
  doses,
  fuso,
  online,
  aoAbrirDose,
  aoLancarTardio,
}: {
  titulo: string;
  vazio: string;
  doses: DoseDaEscala[];
  fuso: string;
  online: boolean;
  aoAbrirDose: (id: string) => void;
  aoLancarTardio: (dose: DoseDaEscala) => void;
}) {
  return (
    <section className="grupo">
      <h2 className="grupo__titulo">
        {titulo} <span className="grupo__conta">{doses.length}</span>
      </h2>
      {doses.length === 0 ? (
        <p className="grupo__vazio">{vazio}</p>
      ) : (
        <ul className="doses">
          {doses.map((d) => (
            <li key={d.id}>
              <CartaoDeDose
                dose={d}
                fuso={fuso}
                online={online}
                aoAbrir={() =>
                  d.estado === "sem_registro" ? aoLancarTardio(d) : aoAbrirDose(d.id)
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CartaoDeDose({
  dose: d,
  fuso,
  online,
  aoAbrir,
}: {
  dose: DoseDaEscala;
  fuso: string;
  online: boolean;
  aoAbrir: () => void;
}) {
  const e = ESTADO[d.estado];
  const concluida = d.estado === "concluida";
  const horaPrevista = d.adiadaPara ? hora(d.adiadaPara, fuso) : d.horaLocal;
  return (
    <button
      type="button"
      className={`dose ${e.classe}`}
      onClick={aoAbrir}
      disabled={!online && !concluida}
      aria-label={`${horaPrevista}, ${d.idosoNome}, ${d.medicamento.nome}, ${e.texto}`}
    >
      <span className="dose__hora">
        {horaPrevista}
        {d.adiadaPara && <span className="dose__adiada">adiada de {d.horaLocal}</span>}
      </span>
      <span className="dose__corpo">
        <span className="dose__nome">
          {d.idosoNome}
          {d.quarto && <span className="dose__quarto">quarto {d.quarto}</span>}
        </span>
        <span className="dose__remedio">
          {d.medicamento.nome}
          {d.medicamento.concentracao ? ` ${d.medicamento.concentracao}` : ""},{" "}
          {quantidade(d.dose, d.unidade)}
          {d.altoRisco && <span className="selo selo--risco">Alto risco</span>}
        </span>
        {d.alergias.length > 0 && (
          <span className="dose__alergias">
            Alergia: {d.alergias.map((a) => a.substancia).join(", ")}
          </span>
        )}
        {d.registro && (
          <span className="dose__registro">
            {RESULTADO[d.registro.resultado]} por {d.registro.usuarioNome} às{" "}
            {hora(d.registro.ocorridaEm, fuso)}
            {d.registro.tardio ? " (registro tardio)" : ""}
          </span>
        )}
      </span>
      <span className={`estado ${e.classe}`}>
        <span aria-hidden="true">{e.icone}</span> {e.texto}
      </span>
    </button>
  );
}
