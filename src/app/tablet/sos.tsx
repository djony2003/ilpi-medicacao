"use client";

import { useRef, useState } from "react";
import { chamar, novaChave } from "../_comum/api";
import { EscolhaDeMotivo, Faixa } from "./comum";
import { ConfirmarPessoa } from "./confirmar-pessoa";
import { hora, numero, quantidade } from "../_comum/formato";
import { LeitorQr } from "./leitor-qr";
import { sinalDeBloqueio, sinalDeConcluido, sinalDeLeitura } from "./retorno";
import type { Bloqueio, PinDeOutraPessoa, SosDoIdoso } from "./tipos";

// Dose "se necessário" (spec 5.7): pulseira → qual remédio SOS → etiqueta → sintoma → confirmar.
// O limite em 24 horas e o intervalo mínimo aparecem antes de ler o remédio, e o servidor
// confere de novo ao gravar.

type Idoso = {
  id: string;
  nome: string;
  quarto: string | null;
  alergias: Array<{ substancia: string; gravidade: string }>;
};
type Tela =
  | { nome: "pulseira"; erro?: string }
  | { nome: "escolher" }
  | { nome: "remedio" }
  | { nome: "sintoma" }
  | { nome: "pessoa"; erro?: string }
  | { nome: "concluido"; texto: string };

const ERRO_DA_PULSEIRA: Record<string, string> = {
  codigo_invalido: "Este código não é de uma pulseira.",
  pulseira_desconhecida: "Pulseira não encontrada nesta casa.",
  pulseira_substituida: "Esta pulseira foi substituída. Use a pulseira nova do paciente.",
};

export function DoseSos({
  usuarioId,
  fuso,
  online,
  aoVoltar,
  aoPerderSessao,
}: {
  usuarioId: string;
  fuso: string;
  online: boolean;
  aoVoltar: () => void;
  aoPerderSessao: () => void;
}) {
  const [tela, setTela] = useState<Tela>({ nome: "pulseira" });
  const [pulseira, setPulseira] = useState<string | null>(null);
  const [idoso, setIdoso] = useState<Idoso | null>(null);
  const [opcoes, setOpcoes] = useState<SosDoIdoso[]>([]);
  const [escolhido, setEscolhido] = useState<SosDoIdoso | null>(null);
  const [lote, setLote] = useState<string | null>(null);
  const [sintoma, setSintoma] = useState("");
  const [bloqueios, setBloqueios] = useState<Bloqueio[]>([]);
  const [problema, setProblema] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [conferindo, setConferindo] = useState(false);
  const [recusada, setRecusada] = useState<string | null>(null);
  const chave = useRef(novaChave());

  const lerPulseira = async (texto: string) => {
    sinalDeLeitura();
    setConferindo(true);
    const r = await chamar<{ idoso: Idoso }>("POST", "/pulseira/localizar", { leitura: texto });
    setConferindo(false);
    if (r.status === 401) return aoPerderSessao();
    if (r.status !== 200) {
      sinalDeBloqueio();
      setRecusada(texto);
      setTela({
        nome: "pulseira",
        erro: ERRO_DA_PULSEIRA[r.corpo.erro ?? ""] ?? "Não foi possível ler a pulseira.",
      });
      return;
    }
    const s = await chamar<{ sos: SosDoIdoso[] }>(
      "GET",
      `/administracao/idosos/${r.corpo.idoso.id}/sos`,
    );
    setPulseira(texto);
    setIdoso(r.corpo.idoso);
    setOpcoes(s.corpo.sos ?? []);
    setTela({ nome: "escolher" });
  };

  const enviar = async (segundaValidacao?: PinDeOutraPessoa) => {
    if (!escolhido || !pulseira || !lote || enviando) return;
    setEnviando(true);
    setProblema(null);
    const r = await chamar<{
      bloqueios?: Bloqueio[];
      mensagem?: string;
      liberaEm?: string;
      etapa?: string;
      saldoDoLote?: number | null;
      problemas?: string[];
    }>("POST", `/administracao/sos/${escolhido.prescricaoId}/registrar`, {
      chave: chave.current,
      pulseira,
      lote,
      sintoma: sintoma.trim(),
      segundaValidacao,
    });
    setEnviando(false);
    if (r.semRede) {
      setProblema(
        "A conexão caiu durante o envio. Confirme de novo quando a rede voltar: não duplica.",
      );
      return;
    }
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200 || r.status === 201) {
      sinalDeConcluido();
      const saldo = r.corpo.saldoDoLote;
      setTela({
        nome: "concluido",
        texto: `Dose SOS registrada.${typeof saldo === "number" ? ` Restam ${numero(saldo)} no lote.` : ""}`,
      });
      return;
    }
    const erro = r.corpo.erro;
    if (erro === "conferencia_bloqueada") {
      sinalDeBloqueio();
      setRecusada(lote);
      setBloqueios(r.corpo.bloqueios ?? []);
      setTela({ nome: "remedio" });
      return;
    }
    if (erro === "limite_sos") {
      sinalDeBloqueio();
      setProblema(
        `${r.corpo.mensagem ?? "Limite atingido."} Libera às ${r.corpo.liberaEm ? hora(r.corpo.liberaEm, fuso) : "?"}.`,
      );
      return;
    }
    if (erro === "segunda_validacao_necessaria") return setTela({ nome: "pessoa" });
    if (erro === "pin_invalido" || erro === "validador_igual") {
      return setTela({
        nome: "pessoa",
        erro:
          erro === "pin_invalido" ? "PIN não confere. Tente de novo." : "Precisa ser outra pessoa.",
      });
    }
    setProblema(r.corpo.problemas?.join(" ") ?? "Não foi possível registrar. Chame o enfermeiro.");
  };

  if (tela.nome === "concluido") {
    return (
      <div className="concluido" role="status">
        <span className="concluido__icone" aria-hidden="true">
          ✓
        </span>
        <p className="concluido__titulo">Registrado</p>
        <p className="concluido__texto">
          {idoso?.nome}: {tela.texto}
        </p>
        <button type="button" className="botao botao--principal botao--largo" onClick={aoVoltar}>
          Voltar para a escala
        </button>
      </div>
    );
  }

  if (tela.nome === "pessoa") {
    return (
      <div className="registro registro--pessoa">
        <ConfirmarPessoa
          titulo="Segunda validação"
          explicacao="Remédio de alto risco: outra pessoa confere e confirma com o próprio PIN."
          perfis={["cuidador", "enfermeiro", "gestor"]}
          excluir={usuarioId}
          erro={tela.erro}
          aoCancelar={() => setTela({ nome: "sintoma" })}
          aoConfirmar={(p) => void enviar(p)}
        />
      </div>
    );
  }

  return (
    <div className="registro">
      <div className="registro__topo">
        <button type="button" className="botao botao--discreto" onClick={aoVoltar}>
          ← Escala
        </button>
        <p className="registro__rotulo">Dose se necessário</p>
      </div>
      <div className="registro__colunas">
        <main className="registro__principal">
          {problema && (
            <p className="aviso aviso--erro" role="alert">
              {problema}
            </p>
          )}

          {tela.nome === "pulseira" && (
            <>
              {tela.erro && <Faixa tipo="bloqueio" titulo={tela.erro} />}
              <h1 className="tela__titulo">Leia a pulseira do paciente</h1>
              <LeitorQr
                key="pulseira"
                instrucao="Aponte a câmera para o QR da pulseira"
                rotuloDoCodigo="Código da pulseira"
                aoLer={(t) => void lerPulseira(t)}
                desativado={!online || conferindo}
                ignorar={[recusada]}
              />
            </>
          )}

          {tela.nome === "escolher" && (
            <>
              <Faixa tipo="ok" titulo={`Paciente: ${idoso?.nome ?? ""}`} />
              <h1 className="tela__titulo">Qual remédio?</h1>
              {opcoes.length === 0 ? (
                <p className="aviso aviso--atencao">
                  Este paciente não tem remédio &quot;se necessário&quot; prescrito.
                </p>
              ) : (
                <ul className="sos">
                  {opcoes.map((o) => {
                    const bloqueado = o.liberaEm !== null;
                    return (
                      <li key={o.prescricaoId}>
                        <button
                          type="button"
                          className="sos__opcao"
                          disabled={bloqueado}
                          onClick={() => {
                            setEscolhido(o);
                            setSintoma(o.indicacao);
                            setTela({ nome: "remedio" });
                          }}
                        >
                          <span className="sos__nome">
                            {o.medicamento.nome}
                            {o.medicamento.concentracao ? ` ${o.medicamento.concentracao}` : ""}
                          </span>
                          <span>
                            {quantidade(o.dose, o.unidade)}, para {o.indicacao.toLowerCase()}
                          </span>
                          <span className="sos__limite">
                            {o.dosesNas24h} de {o.limiteDiario} nas últimas 24 h
                            {o.ultimaEm ? `; última às ${hora(o.ultimaEm, fuso)}` : ""}
                          </span>
                          {bloqueado && o.liberaEm && (
                            <span className="sos__bloqueio">
                              {o.motivoDoBloqueio === "limite_diario"
                                ? "Limite do dia atingido"
                                : "Intervalo mínimo"}
                              : libera às {hora(o.liberaEm, fuso)}. Avise o enfermeiro se for
                              urgente.
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {tela.nome === "remedio" && escolhido && (
            <>
              {bloqueios.length > 0 && (
                <Faixa tipo="bloqueio" titulo="Não dê este remédio" bloqueios={bloqueios} />
              )}
              <h1 className="tela__titulo">Leia a etiqueta de {escolhido.medicamento.nome}</h1>
              <LeitorQr
                key="remedio"
                instrucao="Aponte a câmera para o QR da etiqueta da embalagem"
                rotuloDoCodigo="Código da etiqueta"
                ignorar={[recusada, pulseira]}
                aoLer={(t) => {
                  sinalDeLeitura();
                  setBloqueios([]);
                  setLote(t);
                  setTela({ nome: "sintoma" });
                }}
                desativado={!online}
              />
            </>
          )}

          {tela.nome === "sintoma" && escolhido && (
            <>
              <h1 className="tela__titulo">Por que o paciente precisa agora?</h1>
              <EscolhaDeMotivo
                titulo="Sintoma"
                sugestoes={[escolhido.indicacao]}
                valor={sintoma}
                aoMudar={setSintoma}
              />
              <div className="acoes">
                <button
                  type="button"
                  className="botao botao--principal botao--largo"
                  disabled={sintoma.trim().length < 3 || enviando || !online}
                  onClick={() =>
                    escolhido.altoRisco ? setTela({ nome: "pessoa" }) : void enviar()
                  }
                >
                  {enviando
                    ? "Registrando…"
                    : `Dei ${quantidade(escolhido.dose, escolhido.unidade)}: confirmar`}
                </button>
                <button
                  type="button"
                  className="botao"
                  onClick={() => setTela({ nome: "remedio" })}
                >
                  Ler a etiqueta de novo
                </button>
              </div>
            </>
          )}
        </main>
        {idoso && (
          <aside className="paciente">
            <p className="paciente__nome">{idoso.nome}</p>
            {idoso.quarto && <p className="paciente__quarto">Quarto {idoso.quarto}</p>}
            {idoso.alergias.length > 0 ? (
              <div className="paciente__alergias" role="note">
                <p className="paciente__alergias-titulo">Alergias</p>
                <ul>
                  {idoso.alergias.map((a) => (
                    <li key={a.substancia}>
                      {a.substancia} <span className="paciente__gravidade">({a.gravidade})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="paciente__sem-alergia">Sem alergias cadastradas</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
