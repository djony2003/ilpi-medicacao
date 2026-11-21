"use client";

import { useCallback, useState } from "react";
import { chamar } from "../../_comum/api";
import { useAoAbrir } from "../../_comum/ao-abrir";
import { useComSenha } from "../../_comum/pedir-senha";
import { usePainel } from "../contexto";

// Equipe e tablets (só a gestão). Criar pessoa, desligar, reativar, desbloquear; criar tablet
// (o código de ativação aparece uma vez) e revogar. Tudo pede a senha e fica na trilha.

type Pessoa = {
  id: string;
  nome: string;
  email: string | null;
  perfil: string;
  ativo: boolean;
  bloqueadoAte: string | null;
  temPin: boolean;
};
type Tablet = { id: string; nome: string; situacao: string; ultimoUsoEm: string | null };

const PERFIL: Record<string, string> = {
  cuidador: "Cuidador(a)",
  enfermeiro: "Enfermagem",
  gestor: "Gestão",
};
const SITUACAO: Record<string, string> = {
  aguardando_ativacao: "Aguardando ativação",
  ativo: "Ativo",
  revogado: "Revogado",
};

export default function PaginaDaEquipe() {
  const { aoPerderSessao } = usePainel();
  const { executar, dialogo } = useComSenha();
  const [pessoas, setPessoas] = useState<Pessoa[] | null>(null);
  const [tablets, setTablets] = useState<Tablet[]>([]);
  const [recado, setRecado] = useState<{ texto: string; ok: boolean } | null>(null);
  const [codigo, setCodigo] = useState<string | null>(null);
  const [nova, setNova] = useState({ nome: "", perfil: "cuidador", email: "", senha: "", pin: "" });
  const [nomeTablet, setNomeTablet] = useState("");

  const carregar = useCallback(async () => {
    const [u, d] = await Promise.all([
      chamar<{ usuarios: Pessoa[] }>("GET", "/admin/usuarios"),
      chamar<{ dispositivos: Tablet[] }>("GET", "/admin/dispositivos"),
    ]);
    if (u.status === 401) return aoPerderSessao();
    if (u.status === 200) setPessoas(u.corpo.usuarios);
    if (d.status === 200) setTablets(d.corpo.dispositivos);
  }, [aoPerderSessao]);
  useAoAbrir(carregar);

  const agir = async (caminho: string, corpo: object, ok: string) => {
    setRecado(null);
    const r = await executar(() =>
      chamar<{ problemas?: string[]; erro?: string; codigo?: string }>("POST", caminho, corpo),
    );
    if (r === null) return false;
    if (r.status === 401) return aoPerderSessao();
    if (r.status >= 200 && r.status < 300) {
      setRecado({ texto: ok, ok: true });
      if (r.corpo.codigo) setCodigo(r.corpo.codigo);
      await carregar();
      return true;
    }
    setRecado({
      texto: r.corpo.problemas?.join(" ") ?? r.corpo.erro ?? "Não foi possível salvar.",
      ok: false,
    });
    return false;
  };

  return (
    <section aria-labelledby="equipe-titulo">
      <h1 id="equipe-titulo" className="tela__titulo">
        Equipe e tablets
      </h1>
      {recado && (
        <p className={recado.ok ? "aviso aviso--ok" : "aviso aviso--erro"} role="status">
          {recado.texto}
        </p>
      )}

      <div className="cartao">
        <h2 className="cartao__titulo">Pessoas</h2>
        {pessoas === null ? (
          <p className="tela__texto">Carregando…</p>
        ) : (
          <div className="tabela-rolavel">
            <table className="tabela">
              <caption className="so-leitor">Equipe</caption>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Perfil</th>
                  <th>Situação</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {pessoas.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.nome}
                      <span className="tabela__codigo">{p.email ?? "só PIN no tablet"}</span>
                    </td>
                    <td>{PERFIL[p.perfil] ?? p.perfil}</td>
                    <td>{p.ativo ? (p.bloqueadoAte ? "Bloqueado" : "Ativo") : "Desligado"}</td>
                    <td className="acoes">
                      {p.ativo ? (
                        <button
                          type="button"
                          className="botao botao--discreto"
                          onClick={() =>
                            void agir(`/admin/usuarios/${p.id}/desativar`, {}, "Pessoa desligada.")
                          }
                        >
                          Desligar
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="botao botao--discreto"
                          onClick={() =>
                            void agir(`/admin/usuarios/${p.id}/reativar`, {}, "Pessoa reativada.")
                          }
                        >
                          Reativar
                        </button>
                      )}
                      {p.bloqueadoAte && (
                        <button
                          type="button"
                          className="botao botao--discreto"
                          onClick={() =>
                            void agir(
                              `/admin/usuarios/${p.id}/desbloquear`,
                              {},
                              "Pessoa desbloqueada.",
                            )
                          }
                        >
                          Desbloquear
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="linha-de-campos"
          onSubmit={(e) => {
            e.preventDefault();
            const corpo = {
              nome: nova.nome,
              perfil: nova.perfil,
              ...(nova.email.trim() ? { email: nova.email.trim() } : {}),
              ...(nova.senha ? { senhaInicial: nova.senha } : {}),
              ...(nova.pin ? { pinInicial: nova.pin } : {}),
            };
            void agir("/admin/usuarios", corpo, "Pessoa cadastrada.").then(
              (ok) =>
                ok && setNova({ nome: "", perfil: "cuidador", email: "", senha: "", pin: "" }),
            );
          }}
        >
          <label className="campo">
            <span className="campo__rotulo">Nome</span>
            <input
              className="campo__entrada"
              value={nova.nome}
              required
              maxLength={200}
              onChange={(e) => setNova({ ...nova, nome: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Perfil</span>
            <select
              className="campo__entrada"
              value={nova.perfil}
              onChange={(e) => setNova({ ...nova, perfil: e.target.value })}
            >
              <option value="cuidador">Cuidador(a)</option>
              <option value="enfermeiro">Enfermagem</option>
              <option value="gestor">Gestão</option>
            </select>
          </label>
          <label className="campo">
            <span className="campo__rotulo">E-mail (quem usa o computador)</span>
            <input
              className="campo__entrada"
              type="email"
              value={nova.email}
              onChange={(e) => setNova({ ...nova, email: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">Senha provisória</span>
            <input
              className="campo__entrada"
              type="text"
              autoComplete="off"
              value={nova.senha}
              onChange={(e) => setNova({ ...nova, senha: e.target.value })}
            />
          </label>
          <label className="campo campo--curto">
            <span className="campo__rotulo">PIN do tablet (6 dígitos)</span>
            <input
              className="campo__entrada"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              value={nova.pin}
              onChange={(e) => setNova({ ...nova, pin: e.target.value })}
            />
          </label>
          <button type="submit" className="botao botao--principal">
            Cadastrar pessoa
          </button>
        </form>
        <p className="campo__ajuda">
          Cuidadores usam só o PIN, no tablet. Enfermagem e gestão podem usar PIN e também e-mail e
          senha no computador; no primeiro acesso a pessoa troca a senha e configura o autenticador.
        </p>
      </div>

      <div className="cartao">
        <h2 className="cartao__titulo">Tablets</h2>
        {codigo && (
          <p className="aviso aviso--atencao" role="status">
            Código de ativação: <strong>{codigo}</strong>. Digite no tablet em /tablet. Vale por
            pouco tempo e não será mostrado de novo.
          </p>
        )}
        <ul className="lista-simples">
          {tablets.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.nome}</strong> ({SITUACAO[t.situacao] ?? t.situacao})
              </span>
              {t.situacao !== "revogado" && (
                <button
                  type="button"
                  className="botao botao--discreto"
                  onClick={() =>
                    void agir(`/admin/dispositivos/${t.id}/revogar`, {}, "Tablet revogado.")
                  }
                >
                  Revogar
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="linha-de-campos"
          onSubmit={(e) => {
            e.preventDefault();
            void agir("/admin/dispositivos", { nome: nomeTablet }, "Tablet criado.").then(
              (ok) => ok && setNomeTablet(""),
            );
          }}
        >
          <label className="campo">
            <span className="campo__rotulo">Nome do tablet</span>
            <input
              className="campo__entrada"
              value={nomeTablet}
              required
              maxLength={200}
              placeholder="Ex.: Tablet do posto"
              onChange={(e) => setNomeTablet(e.target.value)}
            />
          </label>
          <button type="submit" className="botao">
            Criar tablet
          </button>
        </form>
      </div>
      {dialogo}
    </section>
  );
}
