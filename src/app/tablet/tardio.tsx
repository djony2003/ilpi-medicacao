"use client";

import { useEffect, useRef, useState } from "react";
import { chamar, novaChave } from "../_comum/api";
import { CartaoDoPaciente, EscolhaDeMotivo, Faixa } from "./comum";
import { ConfirmarPessoa } from "./confirmar-pessoa";
import { instanteNoFuso, numero } from "../_comum/formato";
import { LeitorQr } from "./leitor-qr";
import { sinalDeBloqueio, sinalDeConcluido, sinalDeLeitura } from "./retorno";
import { TecladoPin } from "./teclado-pin";
import type { Bloqueio, ConferenciaDaDose, PinDeOutraPessoa } from "./tipos";

// Registro tardio (spec 5.8): a dose que ficou "sem registro" porque o sistema estava fora e foi
// anotada na folha de contingência. Informa o que aconteceu e a hora real, lê a etiqueta do lote
// usado e confirma com o próprio PIN. Leva a marca "tardio" no registro e na auditoria.

type Resultado = "administrada" | "recusada" | "nao_administrada";
type Tela =
  | { nome: "formulario" }
  | { nome: "lote" }
  | { nome: "pin"; erro?: string }
  | { nome: "pessoa"; erro?: string }
  | { nome: "concluido"; texto: string };

const SUGESTOES = ["Sistema fora do ar: anotado na folha", "Sem internet: anotado na folha"];

export function RegistroTardio({
  doseId,
  fuso,
  usuarioId,
  online,
  aoVoltar,
  aoPerderSessao,
}: {
  doseId: string;
  fuso: string;
  usuarioId: string;
  online: boolean;
  aoVoltar: () => void;
  aoPerderSessao: () => void;
}) {
  const [conf, setConf] = useState<ConferenciaDaDose | null>(null);
  const [tela, setTela] = useState<Tela>({ nome: "formulario" });
  const [resultado, setResultado] = useState<Resultado>("administrada");
  const [horaReal, setHoraReal] = useState("");
  const [motivo, setMotivo] = useState(SUGESTOES[0] ?? "");
  const [lote, setLote] = useState<string | null>(null);
  const [bloqueios, setBloqueios] = useState<Bloqueio[]>([]);
  const [problema, setProblema] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const chave = useRef(novaChave());

  useEffect(() => {
    let ativo = true;
    void chamar<{ conferencia: ConferenciaDaDose }>("GET", `/administracao/doses/${doseId}`).then(
      (r) => {
        if (!ativo) return;
        if (r.status === 401) return aoPerderSessao();
        if (r.status === 200) {
          setConf(r.corpo.conferencia);
          setHoraReal(r.corpo.conferencia.dose.horaLocal);
        } else setProblema("Dose não encontrada.");
      },
    );
    return () => {
      ativo = false;
    };
  }, [doseId, aoPerderSessao]);

  const enviar = async (segundaValidacao?: PinDeOutraPessoa) => {
    if (!conf || enviando) return;
    setEnviando(true);
    setProblema(null);
    const r = await chamar<{
      bloqueios?: Bloqueio[];
      problemas?: string[];
      saldoDoLote?: number | null;
    }>("POST", `/administracao/doses/${doseId}/tardio`, {
      chave: chave.current,
      resultado,
      ocorridaEm: ocorridaEm(conf, horaReal, fuso),
      motivo: motivo.trim(),
      lote: resultado === "administrada" ? (lote ?? undefined) : undefined,
      segundaValidacao,
    });
    setEnviando(false);
    if (r.semRede)
      return setProblema("A conexão caiu. Tente de novo quando a rede voltar: não duplica.");
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200 || r.status === 201) {
      sinalDeConcluido();
      const saldo = r.corpo.saldoDoLote;
      return setTela({
        nome: "concluido",
        texto: `Registro tardio feito.${typeof saldo === "number" ? ` Restam ${numero(saldo)} no lote.` : ""}`,
      });
    }
    const erro = r.corpo.erro;
    if (erro === "reautenticacao_necessaria") return setTela({ nome: "pin" });
    if (erro === "segunda_validacao_necessaria") return setTela({ nome: "pessoa" });
    if (erro === "pin_invalido" || erro === "validador_igual") {
      return setTela({
        nome: "pessoa",
        erro: erro === "pin_invalido" ? "PIN não confere." : "Precisa ser outra pessoa.",
      });
    }
    if (erro === "conferencia_bloqueada") {
      sinalDeBloqueio();
      setBloqueios(r.corpo.bloqueios ?? []);
      return setTela({ nome: "formulario" });
    }
    if (erro === "prazo_do_registro_tardio")
      return setProblema("Passou o prazo de 7 dias: o enfermeiro trata a dose.");
    setProblema(r.corpo.problemas?.join(" ") ?? "Não foi possível registrar.");
    setTela({ nome: "formulario" });
  };

  const confirmarComPin = async (pin: string) => {
    const r = await chamar("POST", "/auth/reautenticar", { segredo: pin });
    if (r.status === 401 && r.corpo.erro === "nao_autenticado") return aoPerderSessao();
    if (r.status !== 200) return setTela({ nome: "pin", erro: "PIN não confere." });
    if (conf?.exigeSegundaValidacao && resultado === "administrada")
      return setTela({ nome: "pessoa" });
    await enviar();
  };

  if (!conf) {
    return (
      <div className="registro">
        <p className="tela__texto">{problema ?? "Carregando a dose…"}</p>
        <button type="button" className="botao" onClick={aoVoltar}>
          Voltar
        </button>
      </div>
    );
  }

  if (tela.nome === "concluido") {
    return (
      <div className="concluido" role="status">
        <span className="concluido__icone" aria-hidden="true">
          ✓
        </span>
        <p className="concluido__titulo">Registrado</p>
        <p className="concluido__texto">
          {conf.dose.idosoNome}: {tela.texto}
        </p>
        <button type="button" className="botao botao--principal botao--largo" onClick={aoVoltar}>
          Voltar para a escala
        </button>
      </div>
    );
  }
  if (tela.nome === "pin") {
    return (
      <div className="registro registro--pessoa">
        <TecladoPin
          titulo="Confirme com o seu PIN"
          explicacao="O registro tardio fica marcado com o seu nome e o horário informado."
          erro={tela.erro}
          rotuloConfirmar="Confirmar o registro"
          aoConfirmar={(pin) => void confirmarComPin(pin)}
          aoCancelar={() => setTela({ nome: "formulario" })}
        />
      </div>
    );
  }
  if (tela.nome === "pessoa") {
    return (
      <div className="registro registro--pessoa">
        <ConfirmarPessoa
          titulo="Segunda validação"
          explicacao="Remédio de alto risco: outra pessoa que acompanhou a dose confirma com o PIN."
          perfis={["cuidador", "enfermeiro", "gestor"]}
          excluir={usuarioId}
          erro={tela.erro}
          aoCancelar={() => setTela({ nome: "formulario" })}
          aoConfirmar={(p) => void enviar(p)}
        />
      </div>
    );
  }

  const pronto =
    /^\d{2}:\d{2}$/.test(horaReal) &&
    motivo.trim().length >= 3 &&
    (resultado !== "administrada" || lote !== null);
  return (
    <div className="registro">
      <div className="registro__topo">
        <button type="button" className="botao botao--discreto" onClick={aoVoltar}>
          ← Escala
        </button>
        <p className="registro__rotulo">Registro tardio (folha de contingência)</p>
      </div>
      <div className="registro__colunas">
        <main className="registro__principal">
          {problema && (
            <p className="aviso aviso--erro" role="alert">
              {problema}
            </p>
          )}
          {bloqueios.length > 0 && (
            <Faixa tipo="bloqueio" titulo="Não registrado" bloqueios={bloqueios} />
          )}
          {tela.nome === "lote" ? (
            <>
              <h1 className="tela__titulo">Leia a etiqueta do lote usado</h1>
              <LeitorQr
                instrucao="Aponte a câmera para o QR da etiqueta"
                rotuloDoCodigo="Código da etiqueta"
                aoLer={(t) => {
                  sinalDeLeitura();
                  setLote(t);
                  setBloqueios([]);
                  setTela({ nome: "formulario" });
                }}
              />
            </>
          ) : (
            <>
              <h1 className="tela__titulo">O que está anotado na folha?</h1>
              <fieldset className="motivo">
                <legend className="motivo__titulo">Resultado</legend>
                <div className="motivo__opcoes">
                  {(
                    [
                      ["administrada", "Dado"],
                      ["recusada", "Recusado"],
                      ["nao_administrada", "Não dado"],
                    ] as const
                  ).map(([v, t]) => (
                    <button
                      key={v}
                      type="button"
                      className={resultado === v ? "opcao opcao--marcada" : "opcao"}
                      aria-pressed={resultado === v}
                      onClick={() => setResultado(v)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="campo campo--curto">
                <span className="campo__rotulo">Hora em que aconteceu</span>
                <input
                  className="campo__entrada"
                  type="time"
                  value={horaReal}
                  onChange={(e) => setHoraReal(e.target.value)}
                />
              </label>
              {resultado === "administrada" && (
                <div className="tardio__lote">
                  {lote ? (
                    <Faixa tipo="ok" titulo="Etiqueta lida" />
                  ) : (
                    <p className="tela__texto">Falta ler a etiqueta do lote usado.</p>
                  )}
                  <button type="button" className="botao" onClick={() => setTela({ nome: "lote" })}>
                    {lote ? "Ler outra etiqueta" : "Ler a etiqueta"}
                  </button>
                </div>
              )}
              <EscolhaDeMotivo
                titulo="Por que o registro é tardio"
                sugestoes={SUGESTOES}
                valor={motivo}
                aoMudar={setMotivo}
              />
              <div className="acoes">
                <button
                  type="button"
                  className="botao botao--principal botao--largo"
                  disabled={!pronto || enviando || !online}
                  onClick={() => setTela({ nome: "pin" })}
                >
                  Continuar
                </button>
              </div>
            </>
          )}
        </main>
        <CartaoDoPaciente conferencia={conf} fuso={fuso} />
      </div>
    </div>
  );
}

/** Hora anotada na folha → instante. Dose das 23:30 dada às 00:10 foi no dia seguinte. */
function ocorridaEm(conf: ConferenciaDaDose, horaReal: string, fuso: string): string {
  const mesmoDia = new Date(instanteNoFuso(conf.dose.dataLocal, horaReal, fuso));
  const prevista = new Date(conf.dose.previstaEm);
  const DOZE_HORAS = 12 * 3_600_000;
  if (prevista.getTime() - mesmoDia.getTime() > DOZE_HORAS) {
    return new Date(mesmoDia.getTime() + 24 * 3_600_000).toISOString();
  }
  return mesmoDia.toISOString();
}
