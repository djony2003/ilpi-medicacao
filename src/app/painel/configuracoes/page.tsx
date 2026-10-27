"use client";

import { useEffect, useState } from "react";
import type { ConfiguracaoDeAlertas } from "@/modules/alertas";
import { chamar } from "../../_comum/api";
import { useComSenha } from "../../_comum/pedir-senha";
import { usePainel } from "../contexto";

// Configurações da casa (T55): a janela de horário das doses e os limites dos alertas. Mudar
// qualquer uma pede a senha e fica na trilha, com o valor antes e depois.

// O servidor devolve a janela como janelaMin/limiteMaiorMin e recebe janelaMinutos/limiteMaiorMinutos.
type Janela = { janelaMin: number; limiteMaiorMin: number };

type CampoNumerico = {
  chave: Exclude<keyof ConfiguracaoDeAlertas, "fimDosPlantoes" | "emailParaAvisos">;
  rotulo: string;
  ajuda: string;
  unidade: string;
};

const CAMPOS_DE_ALERTA: Array<{ grupo: string; campos: CampoNumerico[] }> = [
  {
    grupo: "Estoque",
    campos: [
      {
        chave: "estoqueAvisoDias",
        rotulo: "Avisar quando o estoque durar",
        ajuda: "Aviso quando o remédio vai acabar em até esse tempo.",
        unidade: "dias",
      },
      {
        chave: "estoqueUrgenteDias",
        rotulo: "Urgente quando durar",
        ajuda: "Alerta urgente, com e-mail, quando vai acabar em até esse tempo.",
        unidade: "dias",
      },
      {
        chave: "prazoReposicaoDias",
        rotulo: "Prazo da reposição",
        ajuda: "Quanto o fornecedor leva para entregar. O aviso nunca vem depois disso.",
        unidade: "dias",
      },
    ],
  },
  {
    grupo: "Validade",
    campos: [
      {
        chave: "validadeAvisoDias",
        rotulo: "Avisar quando faltar",
        ajuda: "Aviso de lote perto de vencer.",
        unidade: "dias",
      },
      {
        chave: "validadeUrgenteDias",
        rotulo: "Urgente quando faltar",
        ajuda: "Urgente quando o lote em uso está para vencer.",
        unidade: "dias",
      },
    ],
  },
  {
    grupo: "Prescrições e exceções",
    campos: [
      {
        chave: "prescricaoAvisoDias",
        rotulo: "Avisar prescrição que termina em",
        ajuda: "Aviso antes do fim de uma prescrição com data final.",
        unidade: "dias",
      },
      {
        chave: "excecoesRepetidas",
        rotulo: "Exceções da mesma pessoa em 7 dias",
        ajuda: "A partir desse número, vira alerta urgente para a gestão.",
        unidade: "exceções",
      },
    ],
  },
  {
    grupo: "Quem precisa saber",
    campos: [
      {
        chave: "escalonamentoHoras",
        rotulo: "Urgente sem ninguém ler vai à gestão em",
        ajuda: "Se ninguém marcar como lido nesse tempo, o alerta sobe para a gestão.",
        unidade: "horas",
      },
      {
        chave: "reavisoUrgenteHoras",
        rotulo: "Repetir e-mail de urgente a cada",
        ajuda: "Enquanto o alerta urgente continuar aberto e não lido.",
        unidade: "horas",
      },
      {
        chave: "reavisoAvisoHoras",
        rotulo: "Repetir e-mail de aviso a cada",
        ajuda: "Vale quando os avisos também são enviados por e-mail.",
        unidade: "horas",
      },
    ],
  },
];

export default function PaginaDasConfiguracoes() {
  const { aoPerderSessao } = usePainel();
  const { executar, dialogo } = useComSenha();
  const [janela, setJanela] = useState<Janela | null>(null);
  const [alertas, setAlertas] = useState<ConfiguracaoDeAlertas | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recado, setRecado] = useState<{
    onde: "janela" | "alertas";
    texto: string;
    ok: boolean;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const [j, a] = await Promise.all([
        chamar<{ janela: Janela }>("GET", "/admin/configuracoes/janela"),
        chamar<{ configuracao: ConfiguracaoDeAlertas }>("GET", "/admin/configuracoes/alertas"),
      ]);
      if (j.status === 401 || a.status === 401) return aoPerderSessao();
      if (j.status !== 200 || a.status !== 200) {
        setErro("Não foi possível carregar as configurações.");
        return;
      }
      setJanela(j.corpo.janela);
      setAlertas(a.corpo.configuracao);
    })();
  }, [aoPerderSessao]);

  const salvar = async (onde: "janela" | "alertas") => {
    setRecado(null);
    const r = await executar(() =>
      chamar<{ janela?: Janela; configuracao?: ConfiguracaoDeAlertas; problemas?: string[] }>(
        "POST",
        onde === "janela" ? "/admin/configuracoes/janela" : "/admin/configuracoes/alertas",
        onde === "janela"
          ? { janelaMinutos: janela?.janelaMin, limiteMaiorMinutos: janela?.limiteMaiorMin }
          : alertas,
      ),
    );
    if (r === null) return;
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200) {
      if (r.corpo.janela) setJanela(r.corpo.janela);
      if (r.corpo.configuracao) setAlertas(r.corpo.configuracao);
      setRecado({ onde, texto: "Salvo. A mudança ficou registrada na trilha.", ok: true });
    } else {
      const problemas = r.corpo.problemas;
      setRecado({
        onde,
        texto: problemas?.join(" ") ?? "Não foi possível salvar. Confira os valores.",
        ok: false,
      });
    }
  };

  if (erro) {
    return (
      <p className="aviso aviso--erro" role="alert">
        {erro}
      </p>
    );
  }
  if (!janela || !alertas) return <p className="tela__texto">Carregando…</p>;

  const numero = (valor: number, aoMudar: (n: number) => void) => ({
    type: "number" as const,
    inputMode: "numeric" as const,
    value: Number.isFinite(valor) ? valor : "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => aoMudar(Number(e.target.value)),
  });

  return (
    <section aria-labelledby="config-titulo">
      <h1 id="config-titulo" className="tela__titulo">
        Configurações
      </h1>

      <form
        className="cartao"
        onSubmit={(e) => {
          e.preventDefault();
          void salvar("janela");
        }}
      >
        <h2 className="cartao__titulo">Janela de horário das doses</h2>
        <p className="tela__texto">
          Dose dada dentro da janela, para mais ou para menos, é “no horário”. Fora dela, a equipe
          precisa dizer o motivo. Antecipar além do limite maior só com liberação da enfermagem.
        </p>
        <div className="grade">
          <label className="campo campo--curto">
            <span className="campo__rotulo">Janela de tolerância (minutos)</span>
            <input
              className="campo__entrada"
              min={5}
              max={120}
              {...numero(janela.janelaMin, (n) => setJanela({ ...janela, janelaMin: n }))}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Limite maior (minutos)</span>
            <input
              className="campo__entrada"
              min={15}
              max={360}
              {...numero(janela.limiteMaiorMin, (n) => setJanela({ ...janela, limiteMaiorMin: n }))}
            />
          </label>
        </div>
        {recado?.onde === "janela" && (
          <p className={recado.ok ? "aviso aviso--ok" : "aviso aviso--erro"} role="status">
            {recado.texto}
          </p>
        )}
        <div className="acoes">
          <button type="submit" className="botao botao--principal">
            Salvar a janela
          </button>
        </div>
      </form>

      <form
        className="cartao"
        onSubmit={(e) => {
          e.preventDefault();
          void salvar("alertas");
        }}
      >
        <h2 className="cartao__titulo">Alertas</h2>
        {CAMPOS_DE_ALERTA.map((g) => (
          <fieldset key={g.grupo} className="grupo">
            <legend className="grupo__titulo">{g.grupo}</legend>
            <div className="grade">
              {g.campos.map((c) => (
                <label key={c.chave} className="campo">
                  <span className="campo__rotulo">
                    {c.rotulo} ({c.unidade})
                  </span>
                  <input
                    className="campo__entrada campo__entrada--curto"
                    {...numero(alertas[c.chave], (n) => setAlertas({ ...alertas, [c.chave]: n }))}
                  />
                  <span className="campo__ajuda">{c.ajuda}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset className="grupo">
          <legend className="grupo__titulo">Fim dos plantões</legend>
          <label className="campo">
            <span className="campo__rotulo">Horários (separados por vírgula, formato HH:MM)</span>
            <input
              className="campo__entrada"
              value={alertas.fimDosPlantoes.join(", ")}
              onChange={(e) =>
                setAlertas({
                  ...alertas,
                  fimDosPlantoes: e.target.value
                    .split(",")
                    .map((h) => h.trim())
                    .filter(Boolean),
                })
              }
            />
            <span className="campo__ajuda">
              Dose que ficou sem registro no fim do plantão vai para a gestão.
            </span>
          </label>
          <label className="campo campo--marcar">
            <input
              type="checkbox"
              checked={alertas.emailParaAvisos}
              onChange={(e) => setAlertas({ ...alertas, emailParaAvisos: e.target.checked })}
            />{" "}
            <span>Mandar também os avisos por e-mail (por padrão, só os urgentes)</span>
          </label>
        </fieldset>
        {recado?.onde === "alertas" && (
          <p className={recado.ok ? "aviso aviso--ok" : "aviso aviso--erro"} role="status">
            {recado.texto}
          </p>
        )}
        <div className="acoes">
          <button type="submit" className="botao botao--principal">
            Salvar os alertas
          </button>
        </div>
      </form>
      {dialogo}
    </section>
  );
}
