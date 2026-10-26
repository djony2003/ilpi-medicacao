"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListaDeAlertas, useResumoDosAlertas } from "../_comum/alertas";
import { chamar } from "../_comum/api";
import { useConexao } from "./conexao";
import { Escala } from "./escala";
import { FUSO_PADRAO } from "../_comum/formato";
import { RegistroDaDose } from "./registro";
import { prepararSom } from "./retorno";
import { DoseSos } from "./sos";
import { RegistroTardio } from "./tardio";
import { TecladoPin } from "./teclado-pin";
import type { Pessoa } from "./tipos";

// O tablet do posto de enfermagem (spec 5.1 e 5.9). Aparelho aprovado pelo gestor; cada pessoa
// toca o próprio nome e digita o PIN. Dois minutos sem tocar na tela: volta para a lista de
// nomes (o servidor também encerra a sessão por inatividade).

type Tela =
  | { nome: "carregando" }
  | { nome: "ativar"; erro?: string }
  | { nome: "quem" }
  | { nome: "pin"; pessoa: Pessoa; erro?: string }
  | { nome: "trocar_pin"; atual?: string; erro?: string }
  | { nome: "escala" }
  | { nome: "dose"; doseId: string }
  | { nome: "tardio"; doseId: string }
  | { nome: "sos" }
  | { nome: "alertas" };

const INATIVIDADE_MS = 2 * 60_000;

export default function Tablet() {
  const [tela, setTela] = useState<Tela>({ nome: "carregando" });
  const [pessoas, setPessoas] = useState<Pessoa[]>([]);
  const [eu, setEu] = useState<Pessoa | null>(null);
  const [fuso, setFuso] = useState(FUSO_PADRAO);
  const [ocupado, setOcupado] = useState(false);
  const online = useConexao();
  // Alertas: enfermagem e gestão (o cuidador vê a situação das doses na própria escala).
  const veAlertas = eu !== null && eu.perfil !== "cuidador";
  const alertas = useResumoDosAlertas(veAlertas);
  const ultimoToque = useRef(0);

  const irParaLista = useCallback(async () => {
    const r = await chamar<{ usuarios: Pessoa[] }>("GET", "/tablet/usuarios");
    if (r.status === 401) return setTela({ nome: "ativar" });
    setPessoas(r.corpo.usuarios ?? []);
    setEu(null);
    setTela({ nome: "quem" });
  }, []);

  const sair = useCallback(async () => {
    await chamar("POST", "/auth/sair", {});
    await irParaLista();
  }, [irParaLista]);

  const perdeuSessao = useCallback(() => void irParaLista(), [irParaLista]);

  // Retomada: se o tablet já tem uma sessão aberta (recarregou a página), volta para a escala.
  useEffect(() => {
    let ativo = true;
    void (async () => {
      const lista = await chamar<{ usuarios: Pessoa[] }>("GET", "/tablet/usuarios");
      if (!ativo) return;
      if (lista.status === 401) return setTela({ nome: "ativar" });
      setPessoas(lista.corpo.usuarios ?? []);
      const sessao = await chamar<{ usuarioId: string; tipo: string; pinTrocar: boolean }>(
        "GET",
        "/auth/eu",
      );
      if (!ativo) return;
      if (sessao.status === 200 && sessao.corpo.tipo === "tablet") {
        setEu((lista.corpo.usuarios ?? []).find((p) => p.id === sessao.corpo.usuarioId) ?? null);
        setTela(sessao.corpo.pinTrocar ? { nome: "trocar_pin" } : { nome: "escala" });
      } else {
        setTela({ nome: "quem" });
      }
    })();
    return () => {
      ativo = false;
    };
  }, []);

  // Inatividade: conta a partir do último toque; ao vencer, encerra a sessão e mostra os nomes.
  useEffect(() => {
    if (!eu) return;
    ultimoToque.current = Date.now();
    const tocou = () => {
      ultimoToque.current = Date.now();
    };
    window.addEventListener("pointerdown", tocou);
    window.addEventListener("keydown", tocou);
    const relogio = window.setInterval(() => {
      if (Date.now() - ultimoToque.current >= INATIVIDADE_MS) void sair();
    }, 5_000);
    return () => {
      window.removeEventListener("pointerdown", tocou);
      window.removeEventListener("keydown", tocou);
      window.clearInterval(relogio);
    };
  }, [eu, sair]);

  // Tela sempre acesa enquanto alguém está usando (onde o navegador permite).
  useEffect(() => {
    if (!eu) return;
    let trava: { release(): Promise<void> } | null = null;
    const pedir = async () => {
      try {
        trava =
          (await (
            navigator as unknown as {
              wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> };
            }
          ).wakeLock?.request("screen")) ?? null;
      } catch {
        trava = null;
      }
    };
    void pedir();
    return () => {
      void trava?.release();
    };
  }, [eu]);

  const entrar = async (pessoa: Pessoa, pin: string) => {
    setOcupado(true);
    const r = await chamar<{ pinTrocar: boolean; usuario: Pessoa }>("POST", "/tablet/entrar", {
      usuarioId: pessoa.id,
      pin,
    });
    setOcupado(false);
    if (r.status !== 200) {
      return setTela({
        nome: "pin",
        pessoa,
        erro: r.semRede
          ? "Sem conexão com o servidor."
          : "PIN não confere. Depois de 5 erros a conta fica bloqueada.",
      });
    }
    setEu(r.corpo.usuario);
    setTela(r.corpo.pinTrocar ? { nome: "trocar_pin" } : { nome: "escala" });
  };

  const trocarPin = async (atual: string, novo: string) => {
    setOcupado(true);
    const r = await chamar<{ problemas?: string[] }>("POST", "/auth/trocar-pin", {
      pinAtual: atual,
      novoPin: novo,
    });
    setOcupado(false);
    if (r.status === 200) return setTela({ nome: "escala" });
    if (r.status === 401) return perdeuSessao();
    setTela({
      nome: "trocar_pin",
      erro: r.corpo.problemas?.join(" ") ?? "Não foi possível trocar o PIN. Escolha outro.",
    });
  };

  const ativar = async (codigo: string) => {
    setOcupado(true);
    const r = await chamar("POST", "/tablet/ativar", { codigo });
    setOcupado(false);
    if (r.status !== 200)
      return setTela({
        nome: "ativar",
        erro: "Código inválido ou vencido. Peça um novo ao gestor.",
      });
    await irParaLista();
  };

  const telaCheia = () => {
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="tablet" onPointerDown={prepararSom}>
      {!online && (
        <div className="sem-conexao" role="alert">
          <strong>Sem conexão.</strong> Novos registros estão bloqueados. Use a folha de
          contingência e lance depois como registro tardio.
        </div>
      )}
      <header className="barra">
        <span className="barra__marca">ILPI Medicação</span>
        {eu && <span className="barra__pessoa">{eu.nome}</span>}
        <span className="barra__acoes">
          {veAlertas && (
            <button
              type="button"
              className="botao botao--discreto"
              onClick={() => setTela({ nome: "alertas" })}
              aria-label={`Alertas: ${alertas.resumo?.naoLidosPorMim ?? 0} não lidos`}
            >
              Alertas
              {(alertas.resumo?.naoLidosPorMim ?? 0) > 0 && (
                <span
                  className={
                    (alertas.resumo?.urgentes ?? 0) > 0 ? "contador contador--urgente" : "contador"
                  }
                >
                  {alertas.resumo?.naoLidosPorMim}
                </span>
              )}
            </button>
          )}
          <button type="button" className="botao botao--discreto" onClick={telaCheia}>
            Tela cheia
          </button>
          {eu && (
            <button type="button" className="botao botao--discreto" onClick={() => void sair()}>
              Sair
            </button>
          )}
        </span>
      </header>

      <div className="tablet__conteudo">
        {tela.nome === "carregando" && <p className="tela__texto">Abrindo…</p>}

        {tela.nome === "ativar" && (
          <Ativacao erro={tela.erro} ocupado={ocupado} aoAtivar={(c) => void ativar(c)} />
        )}

        {tela.nome === "quem" && (
          <section className="quem">
            <h1 className="tela__titulo">Quem vai usar o tablet?</h1>
            {pessoas.length === 0 ? (
              <p className="aviso aviso--atencao">
                Ninguém tem PIN cadastrado. O gestor cadastra a equipe no computador.
              </p>
            ) : (
              <ul className="pessoas__lista pessoas__lista--grande">
                {pessoas.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="pessoa"
                      onClick={() => setTela({ nome: "pin", pessoa: p })}
                    >
                      <span className="pessoa__nome">{p.nome}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tela.nome === "pin" && (
          <TecladoPin
            titulo={`${tela.pessoa.nome}, digite seu PIN`}
            erro={tela.erro}
            ocupado={ocupado}
            rotuloConfirmar="Entrar"
            aoConfirmar={(pin) => void entrar(tela.pessoa, pin)}
            aoCancelar={() => setTela({ nome: "quem" })}
          />
        )}

        {tela.nome === "trocar_pin" &&
          (tela.atual === undefined ? (
            <TecladoPin
              key="atual"
              titulo="Troque o PIN provisório"
              explicacao="Primeiro, digite o PIN que o gestor passou."
              erro={tela.erro}
              rotuloConfirmar="Continuar"
              aoConfirmar={(pin) => setTela({ nome: "trocar_pin", atual: pin })}
              aoCancelar={() => void sair()}
            />
          ) : (
            <TecladoPin
              key="novo"
              titulo="Agora, o seu PIN novo"
              explicacao="6 números só seus. Evite sequências (123456) e datas."
              ocupado={ocupado}
              rotuloConfirmar="Salvar PIN"
              aoConfirmar={(pin) => void trocarPin(tela.atual ?? "", pin)}
              aoCancelar={() => setTela({ nome: "trocar_pin" })}
            />
          ))}

        {tela.nome === "escala" && (
          <Escala
            online={online}
            aoAbrirDose={(doseId) => setTela({ nome: "dose", doseId })}
            aoLancarTardio={(d) => setTela({ nome: "tardio", doseId: d.id })}
            aoAbrirSos={() => setTela({ nome: "sos" })}
            aoPerderSessao={perdeuSessao}
            aoConhecerFuso={setFuso}
          />
        )}

        {tela.nome === "dose" && eu && (
          <RegistroDaDose
            doseId={tela.doseId}
            fuso={fuso}
            usuarioId={eu.id}
            online={online}
            aoVoltar={() => setTela({ nome: "escala" })}
            aoPerderSessao={perdeuSessao}
          />
        )}

        {tela.nome === "tardio" && eu && (
          <RegistroTardio
            doseId={tela.doseId}
            fuso={fuso}
            usuarioId={eu.id}
            online={online}
            aoVoltar={() => setTela({ nome: "escala" })}
            aoPerderSessao={perdeuSessao}
          />
        )}

        {tela.nome === "alertas" && veAlertas && (
          <>
            <button
              type="button"
              className="botao botao--discreto"
              onClick={() => setTela({ nome: "escala" })}
            >
              ← Escala
            </button>
            <ListaDeAlertas fuso={fuso} aoPerderSessao={perdeuSessao} aoMudar={alertas.atualizar} />
          </>
        )}

        {tela.nome === "sos" && eu && (
          <DoseSos
            usuarioId={eu.id}
            fuso={fuso}
            online={online}
            aoVoltar={() => setTela({ nome: "escala" })}
            aoPerderSessao={perdeuSessao}
          />
        )}
      </div>
    </div>
  );
}

function Ativacao({
  erro,
  ocupado,
  aoAtivar,
}: {
  erro?: string;
  ocupado: boolean;
  aoAtivar: (codigo: string) => void;
}) {
  const [codigo, setCodigo] = useState("");
  return (
    <form
      className="ativacao"
      onSubmit={(e) => {
        e.preventDefault();
        if (codigo.trim()) aoAtivar(codigo.trim());
      }}
    >
      <h1 className="tela__titulo">Ativar este tablet</h1>
      <p className="tela__texto">
        Só tablets aprovados pelo gestor registram medicação. No computador, o gestor cadastra o
        aparelho e recebe um código de ativação. Digite-o aqui.
      </p>
      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      <label className="campo">
        <span className="campo__rotulo">Código de ativação</span>
        <input
          className="campo__entrada campo__entrada--codigo"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.toUpperCase())}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
        />
      </label>
      <button type="submit" className="botao botao--principal" disabled={ocupado || !codigo.trim()}>
        {ocupado ? "Ativando…" : "Ativar"}
      </button>
    </form>
  );
}
