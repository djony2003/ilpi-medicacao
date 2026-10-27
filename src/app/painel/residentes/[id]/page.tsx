"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import type { DetalheDoIdoso } from "@/modules/idosos";
import { baixar, chamar } from "../../../_comum/api";
import { useAoAbrir } from "../../../_comum/ao-abrir";
import { useComSenha } from "../../../_comum/pedir-senha";
import { usePainel } from "../../contexto";

// Ficha do residente: dados, alergias, contatos, pulseira e, para a gestão, a exportação dos
// dados (LGPD). CPF e telefones aparecem mascarados; mostrá-los por extenso é uma ação registrada.

const SITUACAO = {
  ativo: "Na casa",
  hospitalizado: "Hospitalizado",
  desligado: "Desligado",
} as const;
const GRAVIDADE = { leve: "leve", moderada: "moderada", grave: "grave" } as const;

type Revelados = { cpf: string | null; telefones: Array<{ contatoId: string; telefone: string }> };

export default function FichaDoResidente() {
  const { id } = useParams<{ id: string }>();
  const { eu, aoPerderSessao } = usePainel();
  const { executar, dialogo } = useComSenha();
  const [idoso, setIdoso] = useState<DetalheDoIdoso | null>(null);
  const [revelados, setRevelados] = useState<Revelados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recado, setRecado] = useState<{ texto: string; ok: boolean } | null>(null);
  const [alergia, setAlergia] = useState({ substancia: "", gravidade: "moderada", observacao: "" });
  const [contato, setContato] = useState({ nome: "", parentesco: "", telefone: "", legal: false });

  const carregar = useCallback(async () => {
    const r = await chamar<{ idoso: DetalheDoIdoso }>("GET", `/idosos/${id}`);
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 404) return setErro("Residente não encontrado.");
    if (r.status !== 200) return setErro("Não foi possível carregar a ficha.");
    setErro(null);
    setIdoso(r.corpo.idoso);
  }, [id, aoPerderSessao]);

  useAoAbrir(carregar);

  const feito = async (
    promessa: Promise<{ status: number; corpo: { erro?: string; problemas?: string[] } }>,
    ok: string,
  ) => {
    const r = await promessa;
    if (r.status === 401) return aoPerderSessao();
    if (r.status >= 200 && r.status < 300) {
      setRecado({ texto: ok, ok: true });
      await carregar();
      return true;
    }
    setRecado({ texto: r.corpo.problemas?.join(" ") ?? "Não foi possível salvar.", ok: false });
    return false;
  };

  const mostrarDados = async () => {
    const r = await chamar<Revelados>("POST", `/idosos/${id}/dados-sensiveis`, {});
    if (r.status === 401) return aoPerderSessao();
    if (r.status === 200) setRevelados(r.corpo);
  };

  const imprimirPulseira = async () => {
    setRecado(null);
    const r = await baixar(`/idosos/${id}/pulseira/emitir`, {}, "pulseira.pdf");
    if (r.status === 401) return aoPerderSessao();
    setRecado(
      r.status === 200
        ? { texto: "Pulseira gerada em PDF. A impressão ficou registrada.", ok: true }
        : { texto: "Não foi possível gerar a pulseira.", ok: false },
    );
  };

  const exportarDados = async () => {
    setRecado(null);
    const r = await executar(() =>
      baixar(`/admin/idosos/${id}/exportacao`, {}, "dados-do-residente.json"),
    );
    if (r === null) return;
    if (r.status === 401) return aoPerderSessao();
    setRecado(
      r.status === 200
        ? { texto: "Arquivo gerado. A exportação ficou registrada na trilha.", ok: true }
        : { texto: "Não foi possível gerar o arquivo.", ok: false },
    );
  };

  if (erro) {
    return (
      <>
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
        <Link href="/painel/residentes" className="ligacao">
          Voltar para os residentes
        </Link>
      </>
    );
  }
  if (!idoso) return <p className="tela__texto">Carregando…</p>;

  const telefoneDe = (contatoId: string, mascarado: string) =>
    revelados?.telefones.find((t) => t.contatoId === contatoId)?.telefone ?? mascarado;

  return (
    <section aria-labelledby="ficha-titulo">
      <p>
        <Link href="/painel/residentes" className="ligacao">
          ← Residentes
        </Link>
      </p>
      <h1 id="ficha-titulo" className="tela__titulo">
        {idoso.nome}
      </h1>
      <dl className="dados">
        <dt>Nascimento</dt>
        <dd>{idoso.dataNascimento.split("-").reverse().join("/")}</dd>
        <dt>Quarto</dt>
        <dd>{idoso.quarto ?? "—"}</dd>
        <dt>Situação</dt>
        <dd>{SITUACAO[idoso.status]}</dd>
        <dt>CPF</dt>
        <dd>
          {idoso.temCpf
            ? revelados
              ? (revelados.cpf ?? "—")
              : (idoso.cpf ?? "informado")
            : "não informado"}
        </dd>
      </dl>
      <div className="acoes">
        <label className="campo campo--curto">
          <span className="campo__rotulo">Situação</span>
          <select
            className="campo__entrada"
            value={idoso.status}
            onChange={(e) =>
              void feito(
                chamar("POST", `/idosos/${id}/status`, { status: e.target.value }),
                "Situação alterada. A escala de doses foi atualizada.",
              )
            }
          >
            <option value="ativo">Na casa</option>
            <option value="hospitalizado">Hospitalizado</option>
            <option value="desligado">Desligado</option>
          </select>
        </label>
      </div>
      {(idoso.temCpf || idoso.contatos.length > 0) && !revelados && (
        <div className="acoes">
          <button type="button" className="botao" onClick={() => void mostrarDados()}>
            Mostrar CPF e telefones por extenso
          </button>
          <span className="campo__ajuda">Cada consulta fica registrada, com o seu nome.</span>
        </div>
      )}

      {recado && (
        <p className={recado.ok ? "aviso aviso--ok" : "aviso aviso--erro"} role="status">
          {recado.texto}
        </p>
      )}

      <div className="cartao">
        <h2 className="cartao__titulo">Alergias</h2>
        {idoso.alergias.length === 0 ? (
          <p className="tela__texto">Nenhuma alergia registrada.</p>
        ) : (
          <ul className="lista-simples">
            {idoso.alergias.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{a.substancia}</strong> ({GRAVIDADE[a.gravidade]})
                  {a.observacao ? `: ${a.observacao}` : ""}
                </span>
                <button
                  type="button"
                  className="botao botao--discreto"
                  onClick={() =>
                    void feito(
                      chamar("POST", `/idosos/${id}/alergias/${a.id}/desativar`, {}),
                      "Alergia retirada da ficha.",
                    )
                  }
                >
                  Retirar
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="linha-de-campos"
          onSubmit={(e) => {
            e.preventDefault();
            void feito(
              chamar("POST", `/idosos/${id}/alergias`, {
                substancia: alergia.substancia,
                gravidade: alergia.gravidade,
                ...(alergia.observacao.trim() ? { observacao: alergia.observacao.trim() } : {}),
              }),
              "Alergia registrada.",
            ).then(
              (ok) => ok && setAlergia({ substancia: "", gravidade: "moderada", observacao: "" }),
            );
          }}
        >
          <label className="campo">
            <span className="campo__rotulo">Substância</span>
            <input
              className="campo__entrada"
              value={alergia.substancia}
              onChange={(e) => setAlergia({ ...alergia, substancia: e.target.value })}
              maxLength={120}
              required
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Gravidade</span>
            <select
              className="campo__entrada"
              value={alergia.gravidade}
              onChange={(e) => setAlergia({ ...alergia, gravidade: e.target.value })}
            >
              <option value="leve">Leve</option>
              <option value="moderada">Moderada</option>
              <option value="grave">Grave</option>
            </select>
          </label>
          <label className="campo">
            <span className="campo__rotulo">Observação (opcional)</span>
            <input
              className="campo__entrada"
              value={alergia.observacao}
              onChange={(e) => setAlergia({ ...alergia, observacao: e.target.value })}
              maxLength={500}
            />
          </label>
          <button type="submit" className="botao">
            Registrar alergia
          </button>
        </form>
      </div>

      <div className="cartao">
        <h2 className="cartao__titulo">Contatos de emergência</h2>
        {idoso.contatos.length === 0 ? (
          <p className="tela__texto">Nenhum contato cadastrado.</p>
        ) : (
          <ul className="lista-simples">
            {idoso.contatos.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.nome}</strong> ({c.parentesco}
                  {c.responsavelLegal ? ", responsável legal" : ""}): {telefoneDe(c.id, c.telefone)}
                </span>
                <button
                  type="button"
                  className="botao botao--discreto"
                  onClick={() =>
                    void feito(
                      chamar("POST", `/idosos/${id}/contatos/${c.id}/desativar`, {}),
                      "Contato retirado da ficha.",
                    )
                  }
                >
                  Retirar
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="linha-de-campos"
          onSubmit={(e) => {
            e.preventDefault();
            void feito(
              chamar("POST", `/idosos/${id}/contatos`, {
                nome: contato.nome,
                parentesco: contato.parentesco,
                telefone: contato.telefone,
                responsavelLegal: contato.legal,
              }),
              "Contato adicionado.",
            ).then(
              (ok) => ok && setContato({ nome: "", parentesco: "", telefone: "", legal: false }),
            );
          }}
        >
          <label className="campo">
            <span className="campo__rotulo">Nome</span>
            <input
              className="campo__entrada"
              value={contato.nome}
              onChange={(e) => setContato({ ...contato, nome: e.target.value })}
              maxLength={200}
              required
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Parentesco</span>
            <input
              className="campo__entrada"
              value={contato.parentesco}
              onChange={(e) => setContato({ ...contato, parentesco: e.target.value })}
              maxLength={60}
              required
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Telefone</span>
            <input
              className="campo__entrada"
              inputMode="tel"
              value={contato.telefone}
              onChange={(e) => setContato({ ...contato, telefone: e.target.value })}
              maxLength={40}
              required
            />
          </label>
          <label className="campo campo--marcar">
            <input
              type="checkbox"
              checked={contato.legal}
              onChange={(e) => setContato({ ...contato, legal: e.target.checked })}
            />{" "}
            <span>Responsável legal</span>
          </label>
          <button type="submit" className="botao">
            Adicionar contato
          </button>
        </form>
      </div>

      <div className="cartao">
        <h2 className="cartao__titulo">Pulseira e dados</h2>
        <div className="acoes">
          <button type="button" className="botao" onClick={() => void imprimirPulseira()}>
            Gerar pulseira (PDF)
          </button>
          {eu.perfil === "gestor" && (
            <button type="button" className="botao" onClick={() => void exportarDados()}>
              Exportar todos os dados deste residente
            </button>
          )}
        </div>
        {eu.perfil === "gestor" && (
          <p className="campo__ajuda">
            O arquivo reúne tudo o que o sistema guarda sobre a pessoa (cadastro, prescrições e
            doses). Serve para atender o pedido do titular ou da família (LGPD). Pede a senha e fica
            registrado.
          </p>
        )}
      </div>
      {dialogo}
    </section>
  );
}
