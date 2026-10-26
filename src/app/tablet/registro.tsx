"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chamar, novaChave } from "./api";
import { CartaoDoPaciente, EscolhaDeMotivo, Faixa, Passos } from "./comum";
import { ConfirmarPessoa } from "./confirmar-pessoa";
import { dataCurta, hora, numero, quantidade } from "./formato";
import { LeitorQr } from "./leitor-qr";
import { sinalDeBloqueio, sinalDeConcluido, sinalDeLeitura } from "./retorno";
import type { Bloqueio, ConferenciaDaDose, LoteDisponivel, PinDeOutraPessoa } from "./tipos";

// Registro de uma dose agendada (spec 5.3), no ritmo de quem está à beira do leito:
//   1. lê a pulseira  →  2. lê a etiqueta do remédio  →  3. escolhe o resultado e confirma.
// No caminho normal são 4 toques: abrir a dose, (ler), (ler), "Dei o remédio", "Confirmar".
//
// O servidor confere tudo de novo no registro: esta tela só antecipa o que ele vai dizer.

type Resultado = "administrada" | "recusada" | "nao_administrada" | "adiada";
type Etapa = "segunda_validacao" | "excecao" | "liberacao";

type Tela =
  | { nome: "pulseira" }
  | { nome: "remedio" }
  | { nome: "resultado" }
  | { nome: "nao_dado"; resultado: Exclude<Resultado, "administrada"> }
  | { nome: "excecao" }
  | { nome: "pessoa"; etapa: Etapa; erro?: string }
  | { nome: "concluido"; texto: string };

type Excecao = {
  loteId: string;
  motivo: "etiqueta_ilegivel" | "etiqueta_danificada";
  justificativa: string;
  lote: LoteDisponivel;
};

const MOTIVOS = {
  fora_da_janela: ["Ronda atrasada", "Paciente estava dormindo", "Paciente em atendimento"],
  recusada: ["Recusou o remédio", "Cuspiu o remédio", "Vomitou logo depois"],
  nao_administrada: [
    "Paciente fora da casa",
    "Remédio em falta",
    "Orientação do enfermeiro",
    "Paciente em jejum para exame",
  ],
  adiada: ["Paciente dormindo", "Paciente no banho", "Paciente em atendimento"],
};

const ROTULO: Record<Resultado, string> = {
  administrada: "Administrada",
  recusada: "Recusada",
  nao_administrada: "Não administrada",
  adiada: "Adiada",
};

const ERRO_DE_PIN: Record<string, string> = {
  pin_invalido: "PIN não confere (ou a conta está bloqueada). Tente de novo.",
  perfil_nao_autorizado: "Essa pessoa não pode fazer esta liberação. Chame um enfermeiro.",
  validador_igual: "A segunda validação precisa ser de outra pessoa.",
};

const ehDaPulseira = (b: Bloqueio) => b.codigo.startsWith("pulseira");

export function RegistroDaDose({
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
  const [tela, setTela] = useState<Tela>({ nome: "pulseira" });
  const [bloqueios, setBloqueios] = useState<Bloqueio[]>([]);
  const [pulseira, setPulseira] = useState<string | null>(null);
  const [lote, setLote] = useState<string | null>(null);
  const [excecao, setExcecao] = useState<Excecao | null>(null);
  const [liberacao, setLiberacao] = useState<PinDeOutraPessoa | null>(null);
  const [motivo, setMotivo] = useState("");
  const [exigeMotivo, setExigeMotivo] = useState(false);
  const [adiadaPara, setAdiadaPara] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [conferindo, setConferindo] = useState(false);
  const [recusada, setRecusada] = useState<string | null>(null);
  const [problema, setProblema] = useState<string | null>(null);
  // Uma chave por abertura da dose: reenviar depois de uma queda de rede não duplica o registro.
  const chave = useRef(novaChave());
  // O PIN de quem liberou a exceção fica fora do estado da tela: ele só existe até o envio.
  const liberadorDaExcecao = useRef<PinDeOutraPessoa | null>(null);
  const resultadoPendente = useRef<Resultado>("administrada");

  const conferir = useCallback(
    async (leituras: { pulseira?: string; lote?: string }) => {
      // O leitor fica parado enquanto o servidor confere: uma leitura por vez, sem resposta velha
      // chegando depois da nova.
      setConferindo(true);
      const r = await chamar<{ conferencia: ConferenciaDaDose }>(
        "POST",
        `/administracao/doses/${doseId}/conferir`,
        leituras,
      );
      setConferindo(false);
      if (r.status === 401) {
        aoPerderSessao();
        return null;
      }
      if (r.semRede) {
        setProblema("Sem conexão. Use a folha de contingência até a rede voltar.");
        return null;
      }
      if (r.status !== 200) {
        setProblema(
          r.corpo.erro === "dose_cancelada"
            ? "Esta dose foi cancelada."
            : "Não foi possível conferir.",
        );
        return null;
      }
      setProblema(null);
      setConf(r.corpo.conferencia);
      return r.corpo.conferencia;
    },
    [doseId, aoPerderSessao],
  );

  useEffect(() => {
    let ativo = true;
    void chamar<{ conferencia: ConferenciaDaDose }>("GET", `/administracao/doses/${doseId}`).then(
      (r) => {
        if (!ativo) return;
        if (r.status === 401) return aoPerderSessao();
        if (r.status === 200) {
          setConf(r.corpo.conferencia);
          setBloqueios(
            r.corpo.conferencia.bloqueios.filter((b) => b.codigo === "dose_ja_registrada"),
          );
          setExigeMotivo(r.corpo.conferencia.horario.tipo === "exige_motivo");
        } else {
          setProblema(
            r.corpo.erro === "dose_cancelada" ? "Esta dose foi cancelada." : "Dose não encontrada.",
          );
        }
      },
    );
    return () => {
      ativo = false;
    };
  }, [doseId, aoPerderSessao]);

  const lerPulseira = async (texto: string) => {
    sinalDeLeitura();
    const c = await conferir({ pulseira: texto });
    if (!c) return;
    const daPulseira = c.bloqueios.filter(
      (b) =>
        ehDaPulseira(b) ||
        b.codigo === "dose_ja_registrada" ||
        b.codigo === "prescricao_encerrada" ||
        b.codigo === "horario_expirado",
    );
    const antecipada = c.bloqueios.find((b) => b.codigo === "horario_antecipado");
    if (daPulseira.length > 0) {
      sinalDeBloqueio();
      setRecusada(texto);
      setBloqueios(daPulseira);
      return;
    }
    setPulseira(texto);
    setRecusada(null);
    // Alergia ao remédio desta dose aparece já aqui, antes de alguém ir buscar a embalagem.
    const alergia = c.bloqueios.filter((b) => b.codigo === "alergia");
    setBloqueios(antecipada && !liberacao ? [antecipada] : alergia);
    setExigeMotivo(c.horario.tipo === "exige_motivo" || Boolean(antecipada));
    if (!antecipada || liberacao) setTela({ nome: "remedio" });
  };

  const lerRemedio = async (texto: string) => {
    sinalDeLeitura();
    const c = await conferir({ pulseira: pulseira ?? undefined, lote: texto });
    if (!c) return;
    const doRemedio = c.bloqueios.filter(
      (b) => !ehDaPulseira(b) && !(b.codigo === "horario_antecipado" && liberacao),
    );
    if (doRemedio.length > 0) {
      sinalDeBloqueio();
      setRecusada(texto);
      setBloqueios(doRemedio);
      return;
    }
    setBloqueios([]);
    setRecusada(null);
    setLote(texto);
    setExcecao(null);
    setTela({ nome: "resultado" });
  };

  const enviar = async (
    resultado: Resultado,
    extra: { segundaValidacao?: PinDeOutraPessoa; excecao?: Excecao | null } = {},
  ) => {
    if (enviando) return;
    if (!online) {
      setProblema(
        "Sem conexão: o registro não pode ser feito agora. Anote na folha de contingência.",
      );
      return;
    }
    const exc = extra.excecao === undefined ? excecao : extra.excecao;
    setEnviando(true);
    setProblema(null);
    const r = await chamar<{
      ok?: boolean;
      bloqueios?: Bloqueio[];
      etapa?: Etapa;
      problemas?: string[];
      saldoDoLote?: number | null;
      repetido?: boolean;
    }>("POST", `/administracao/doses/${doseId}/registrar`, {
      chave: chave.current,
      resultado,
      pulseira: pulseira ?? undefined,
      lote: resultado === "administrada" && !exc ? (lote ?? undefined) : undefined,
      motivo: motivo.trim() || undefined,
      adiadaPara: resultado === "adiada" ? (adiadaPara ?? undefined) : undefined,
      excecao:
        resultado === "administrada" && exc
          ? {
              loteId: exc.loteId,
              motivo: exc.motivo,
              justificativa: exc.justificativa,
              liberador: liberadorDaExcecao.current ?? { usuarioId: "", pin: "" },
            }
          : undefined,
      segundaValidacao: extra.segundaValidacao,
      liberacao: liberacao ?? undefined,
    });
    setEnviando(false);

    if (r.semRede) {
      setProblema(
        "A conexão caiu durante o envio. Toque em confirmar de novo quando a rede voltar: o registro não será duplicado.",
      );
      return;
    }
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200 || r.status === 201) {
      sinalDeConcluido();
      const saldo = r.corpo.saldoDoLote;
      setTela({
        nome: "concluido",
        texto:
          resultado === "adiada" && adiadaPara
            ? `Dose adiada para ${hora(adiadaPara, fuso)}.`
            : `${ROTULO[resultado]}.${typeof saldo === "number" ? ` Restam ${numero(saldo)} no lote.` : ""}`,
      });
      return;
    }
    const erro = r.corpo.erro;
    if (erro === "conferencia_bloqueada") {
      sinalDeBloqueio();
      setBloqueios(r.corpo.bloqueios ?? []);
      return;
    }
    if (erro === "motivo_obrigatorio") {
      setExigeMotivo(true);
      setProblema("Fora do horário: escolha o motivo.");
      return;
    }
    if (erro === "segunda_validacao_necessaria") {
      setTela({ nome: "pessoa", etapa: "segunda_validacao" });
      return;
    }
    if (erro && erro in ERRO_DE_PIN && r.corpo.etapa) {
      setTela({ nome: "pessoa", etapa: r.corpo.etapa, erro: ERRO_DE_PIN[erro] });
      return;
    }
    if (erro === "saldo_insuficiente") {
      sinalDeBloqueio();
      setBloqueios([
        {
          codigo: "saldo_insuficiente",
          mensagem: "Saldo do lote não confere",
          acao: "O enfermeiro faz o ajuste com justificativa.",
        },
      ]);
      return;
    }
    setProblema(r.corpo.problemas?.join(" ") ?? "Não foi possível registrar. Chame o enfermeiro.");
  };

  const confirmar = (resultado: Resultado) => {
    resultadoPendente.current = resultado;
    if (exigeMotivo && motivo.trim().length < 3 && resultado === "administrada") {
      setProblema("Fora do horário: escolha o motivo antes de confirmar.");
      return;
    }
    if (resultado === "administrada" && conf?.exigeSegundaValidacao) {
      setTela({ nome: "pessoa", etapa: "segunda_validacao" });
      return;
    }
    void enviar(resultado);
  };

  if (!conf) {
    return (
      <div className="registro">
        <p className="tela__texto">{problema ?? "Carregando a dose…"}</p>
        <button type="button" className="botao" onClick={aoVoltar}>
          Voltar para a escala
        </button>
      </div>
    );
  }

  const jaRegistrada = bloqueios.some((b) => b.codigo === "dose_ja_registrada");
  const passo =
    tela.nome === "pulseira" ? 1 : tela.nome === "remedio" || tela.nome === "excecao" ? 2 : 3;

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

  if (tela.nome === "pessoa") {
    const voltar = () =>
      setTela({
        nome:
          tela.etapa === "liberacao"
            ? "pulseira"
            : tela.etapa === "excecao"
              ? "excecao"
              : "resultado",
      });
    const textos: Record<Etapa, { titulo: string; explicacao: string }> = {
      segunda_validacao: {
        titulo: "Segunda validação",
        explicacao:
          "Remédio de alto risco: outra pessoa confere paciente, remédio e dose, e confirma com o próprio PIN.",
      },
      excecao: {
        titulo: "Liberação da exceção",
        explicacao: "A etiqueta não lê. O enfermeiro confere o lote à mão e libera com o PIN.",
      },
      liberacao: {
        titulo: "Liberar dose antecipada",
        explicacao: "Faltam mais de 2 horas para o horário. Só o enfermeiro libera, com o PIN.",
      },
    };
    return (
      <div className="registro registro--pessoa">
        <ConfirmarPessoa
          titulo={textos[tela.etapa].titulo}
          explicacao={textos[tela.etapa].explicacao}
          perfis={
            tela.etapa === "segunda_validacao"
              ? ["cuidador", "enfermeiro", "gestor"]
              : ["enfermeiro", "gestor"]
          }
          excluir={tela.etapa === "segunda_validacao" ? usuarioId : undefined}
          erro={tela.erro}
          aoCancelar={voltar}
          aoConfirmar={(p) => {
            if (tela.etapa === "liberacao") {
              setLiberacao(p);
              setBloqueios([]);
              setExigeMotivo(true);
              setTela({ nome: "remedio" });
            } else if (tela.etapa === "excecao") {
              liberadorDaExcecao.current = p;
              setTela({ nome: "resultado" });
            } else {
              void enviar(resultadoPendente.current, { segundaValidacao: p });
            }
          }}
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
        <Passos atual={passo} />
      </div>
      <div className="registro__colunas">
        <main className="registro__principal">
          {problema && (
            <p className="aviso aviso--erro" role="alert">
              {problema}
            </p>
          )}

          {jaRegistrada && (
            <Faixa tipo="bloqueio" titulo="Não registre de novo" bloqueios={bloqueios} />
          )}

          {!jaRegistrada && tela.nome === "pulseira" && (
            <>
              {bloqueios.length > 0 && (
                <Faixa
                  tipo="bloqueio"
                  titulo={
                    bloqueios[0]?.codigo === "horario_antecipado" ? "Ainda é cedo" : "Não confere"
                  }
                  bloqueios={bloqueios}
                />
              )}
              {bloqueios.some((b) => b.codigo === "horario_antecipado") ? (
                <div className="acoes">
                  <button
                    type="button"
                    className="botao botao--principal"
                    onClick={() => setTela({ nome: "pessoa", etapa: "liberacao" })}
                  >
                    Enfermeiro libera
                  </button>
                  <button type="button" className="botao" onClick={aoVoltar}>
                    Aguardar o horário
                  </button>
                </div>
              ) : (
                <>
                  <h1 className="tela__titulo">Leia a pulseira do paciente</h1>
                  <LeitorQr
                    key="pulseira"
                    instrucao="Aponte a câmera para o QR da pulseira"
                    rotuloDoCodigo="Código da pulseira"
                    aoLer={(t) => void lerPulseira(t)}
                    desativado={!online || conferindo}
                    ignorar={[recusada]}
                  />
                  <button
                    type="button"
                    className="botao botao--discreto"
                    onClick={() => setTela({ nome: "nao_dado", resultado: "nao_administrada" })}
                  >
                    Paciente fora da casa? Registrar como não administrada
                  </button>
                </>
              )}
            </>
          )}

          {!jaRegistrada && tela.nome === "remedio" && (
            <>
              {bloqueios.length > 0 ? (
                <Faixa tipo="bloqueio" titulo="Não dê este remédio" bloqueios={bloqueios} />
              ) : (
                <Faixa tipo="ok" titulo={`Paciente confere: ${conf.dose.idosoNome}`} />
              )}
              <h1 className="tela__titulo">Leia a etiqueta do remédio</h1>
              <LeitorQr
                key="remedio"
                instrucao="Aponte a câmera para o QR da etiqueta da embalagem"
                rotuloDoCodigo="Código da etiqueta"
                aoLer={(t) => void lerRemedio(t)}
                desativado={!online || conferindo}
                ignorar={[recusada, pulseira]}
              />
              <div className="acoes acoes--secundarias">
                <button
                  type="button"
                  className="botao"
                  onClick={() => setTela({ nome: "nao_dado", resultado: "recusada" })}
                >
                  Paciente recusou
                </button>
                <button
                  type="button"
                  className="botao"
                  onClick={() => setTela({ nome: "nao_dado", resultado: "adiada" })}
                >
                  Adiar
                </button>
                <button
                  type="button"
                  className="botao"
                  onClick={() => setTela({ nome: "nao_dado", resultado: "nao_administrada" })}
                >
                  Não será dado
                </button>
                <button
                  type="button"
                  className="botao botao--discreto"
                  onClick={() => setTela({ nome: "excecao" })}
                >
                  A etiqueta não lê
                </button>
              </div>
            </>
          )}

          {!jaRegistrada && tela.nome === "excecao" && (
            <TelaDeExcecao
              doseId={doseId}
              unidade={conf.dose.unidade}
              inicial={excecao}
              aoCancelar={() => setTela({ nome: "remedio" })}
              aoContinuar={(e) => {
                setExcecao(e);
                setLote(null);
                setTela({ nome: "pessoa", etapa: "excecao" });
              }}
            />
          )}

          {!jaRegistrada && tela.nome === "resultado" && (
            <>
              {bloqueios.length > 0 ? (
                <Faixa tipo="bloqueio" titulo="Não registrado" bloqueios={bloqueios} />
              ) : (
                <Faixa
                  tipo={excecao ? "atencao" : "ok"}
                  titulo={
                    excecao
                      ? `Exceção: lote ${excecao.lote.numeroLote} conferido à mão`
                      : `Remédio confere${conf.lote ? `: lote ${conf.lote.numeroLote}, validade ${dataCurta(conf.lote.validade)}` : ""}`
                  }
                />
              )}
              <h1 className="tela__titulo">
                Dê {quantidade(conf.dose.dose, conf.dose.unidade)} de {conf.dose.medicamento.nome}
              </h1>
              {exigeMotivo && (
                <EscolhaDeMotivo
                  titulo="Fora do horário: por quê?"
                  sugestoes={MOTIVOS.fora_da_janela}
                  valor={motivo}
                  aoMudar={setMotivo}
                />
              )}
              <div className="acoes">
                <button
                  type="button"
                  className="botao botao--principal botao--largo"
                  onClick={() => confirmar("administrada")}
                  disabled={enviando || !online || bloqueios.length > 0}
                >
                  {enviando ? "Registrando…" : "Dei o remédio: confirmar"}
                </button>
                <button
                  type="button"
                  className="botao"
                  onClick={() => setTela({ nome: "nao_dado", resultado: "recusada" })}
                >
                  Paciente recusou
                </button>
              </div>
            </>
          )}

          {!jaRegistrada && tela.nome === "nao_dado" && (
            <TelaNaoDado
              resultado={tela.resultado}
              conf={conf}
              fuso={fuso}
              motivo={motivo}
              aoMudarMotivo={setMotivo}
              adiadaPara={adiadaPara}
              aoMudarAdiamento={setAdiadaPara}
              enviando={enviando}
              online={online}
              bloqueios={bloqueios}
              precisaPulseira={tela.resultado !== "nao_administrada" && !pulseira}
              aoConfirmar={() => void enviar(tela.resultado)}
              aoVoltar={() => {
                setBloqueios([]);
                setTela({ nome: pulseira ? "remedio" : "pulseira" });
              }}
            />
          )}
        </main>
        <CartaoDoPaciente conferencia={conf} fuso={fuso} />
      </div>
    </div>
  );
}

function TelaNaoDado({
  resultado,
  conf,
  fuso,
  motivo,
  aoMudarMotivo,
  adiadaPara,
  aoMudarAdiamento,
  enviando,
  online,
  bloqueios,
  precisaPulseira,
  aoConfirmar,
  aoVoltar,
}: {
  resultado: "recusada" | "nao_administrada" | "adiada";
  conf: ConferenciaDaDose;
  fuso: string;
  motivo: string;
  aoMudarMotivo: (m: string) => void;
  adiadaPara: string | null;
  aoMudarAdiamento: (iso: string) => void;
  enviando: boolean;
  online: boolean;
  bloqueios: Bloqueio[];
  precisaPulseira: boolean;
  aoConfirmar: () => void;
  aoVoltar: () => void;
}) {
  const titulo = {
    recusada: "Paciente recusou",
    nao_administrada: "Remédio não será dado",
    adiada: "Adiar a dose",
  }[resultado];
  // O instante em que a tela abriu, arredondado para 5 minutos: horários redondos são mais fáceis
  // de anotar e conferir.
  const [abertaEm] = useState(() => Math.ceil(Date.now() / 300_000) * 300_000);
  const limite = new Date(conf.adiarAte).getTime();
  const opcoesDeAdiamento = [15, 30, 60, 90]
    .map((m) => new Date(abertaEm + m * 60_000))
    .filter((d) => d.getTime() <= limite)
    .map((d) => d.toISOString());
  const pronto =
    motivo.trim().length >= 3 &&
    (resultado !== "adiada" || adiadaPara !== null) &&
    !precisaPulseira;

  return (
    <>
      {bloqueios.length > 0 && (
        <Faixa tipo="bloqueio" titulo="Não registrado" bloqueios={bloqueios} />
      )}
      <h1 className="tela__titulo">{titulo}</h1>
      {precisaPulseira && (
        <p className="aviso aviso--atencao">
          Leia a pulseira primeiro: a recusa e o adiamento são registrados à beira do leito.
        </p>
      )}
      {resultado === "adiada" && (
        <fieldset className="motivo">
          <legend className="motivo__titulo">Para quando?</legend>
          {opcoesDeAdiamento.length === 0 ? (
            <p className="aviso aviso--atencao">
              Não dá mais para adiar: o limite de horário desta dose está perto.
            </p>
          ) : (
            <div className="motivo__opcoes">
              {opcoesDeAdiamento.map((iso) => (
                <button
                  key={iso}
                  type="button"
                  className={adiadaPara === iso ? "opcao opcao--marcada" : "opcao"}
                  aria-pressed={adiadaPara === iso}
                  onClick={() => aoMudarAdiamento(iso)}
                >
                  {hora(iso, fuso)}
                </button>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <EscolhaDeMotivo
        titulo="Motivo"
        sugestoes={MOTIVOS[resultado]}
        valor={motivo}
        aoMudar={aoMudarMotivo}
      />
      <div className="acoes">
        <button
          type="button"
          className="botao botao--principal botao--largo"
          onClick={aoConfirmar}
          disabled={!pronto || enviando || !online}
        >
          {enviando ? "Registrando…" : `Registrar: ${titulo.toLowerCase()}`}
        </button>
        <button type="button" className="botao" onClick={aoVoltar}>
          Voltar
        </button>
      </div>
    </>
  );
}

function TelaDeExcecao({
  doseId,
  unidade,
  inicial,
  aoCancelar,
  aoContinuar,
}: {
  doseId: string;
  unidade: string;
  inicial: Excecao | null;
  aoCancelar: () => void;
  aoContinuar: (e: Excecao) => void;
}) {
  const [lotes, setLotes] = useState<LoteDisponivel[] | null>(null);
  const [escolhido, setEscolhido] = useState<LoteDisponivel | null>(inicial?.lote ?? null);
  const [motivo, setMotivo] = useState<Excecao["motivo"]>(inicial?.motivo ?? "etiqueta_ilegivel");
  const [justificativa, setJustificativa] = useState(inicial?.justificativa ?? "");

  useEffect(() => {
    let ativo = true;
    void chamar<{ lotes: LoteDisponivel[] }>("GET", `/administracao/doses/${doseId}/lotes`).then(
      (r) => {
        if (ativo) setLotes(r.corpo.lotes ?? []);
      },
    );
    return () => {
      ativo = false;
    };
  }, [doseId]);

  const pronto = escolhido !== null && justificativa.trim().length >= 10;
  return (
    <section className="excecao">
      <Faixa
        tipo="atencao"
        titulo="Exceção de conferência: só para etiqueta ilegível ou danificada. Fica registrada para a gestão."
      />
      <h1 className="tela__titulo">Qual é o lote na mão?</h1>
      {lotes === null ? (
        <p className="tela__texto">Carregando os lotes…</p>
      ) : lotes.length === 0 ? (
        <p className="aviso aviso--erro">
          Não há lote deste remédio com saldo. Chame o enfermeiro.
        </p>
      ) : (
        <ul className="lotes">
          {lotes.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className={escolhido?.id === l.id ? "lote lote--marcado" : "lote"}
                aria-pressed={escolhido?.id === l.id}
                disabled={l.vencido}
                onClick={() => setEscolhido(l)}
              >
                <span className="lote__numero">Lote {l.numeroLote}</span>
                <span>
                  Validade {dataCurta(l.validade)}
                  {l.vencido ? " (vencido)" : ""}
                </span>
                <span>
                  {quantidade(l.saldo, unidade)},{" "}
                  {l.destino === "comum" ? "estoque comum" : "estoque do paciente"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="motivo">
        <legend className="motivo__titulo">O que houve com a etiqueta?</legend>
        <div className="motivo__opcoes">
          {(
            [
              ["etiqueta_ilegivel", "Ilegível"],
              ["etiqueta_danificada", "Danificada"],
            ] as const
          ).map(([v, t]) => (
            <button
              key={v}
              type="button"
              className={motivo === v ? "opcao opcao--marcada" : "opcao"}
              aria-pressed={motivo === v}
              onClick={() => setMotivo(v)}
            >
              {t}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="campo">
        <span className="campo__rotulo">Como o lote foi conferido</span>
        <textarea
          className="campo__entrada campo__entrada--area"
          value={justificativa}
          onChange={(e) => setJustificativa(e.target.value)}
          maxLength={500}
          placeholder="Ex.: conferi número do lote e validade na caixa"
        />
      </label>
      <div className="acoes">
        <button
          type="button"
          className="botao botao--principal"
          disabled={!pronto}
          onClick={() =>
            escolhido &&
            aoContinuar({
              loteId: escolhido.id,
              motivo,
              justificativa: justificativa.trim(),
              lote: escolhido,
            })
          }
        >
          Chamar o enfermeiro para liberar
        </button>
        <button type="button" className="botao" onClick={aoCancelar}>
          Voltar para a câmera
        </button>
      </div>
    </section>
  );
}
