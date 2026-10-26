"use client";

import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { chamar } from "../_comum/api";

// Entrada no computador (gestão e enfermagem, spec 7.2): e-mail e senha, depois o código do
// aplicativo autenticador. No primeiro acesso, a pessoa configura o autenticador lendo um QR; se a
// senha for provisória, troca antes de seguir.

type Etapa =
  | { nome: "senha" }
  | { nome: "codigo" }
  | { nome: "configurar"; qr: string; segredo: string }
  | { nome: "trocar_senha" };

export default function Entrar() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<Etapa>({ nome: "senha" });
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [codigo, setCodigo] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Quem já está com a sessão aberta vai direto para o painel.
  useEffect(() => {
    void chamar<{ tipo: string; senhaTrocar: boolean }>("GET", "/auth/eu").then((r) => {
      if (r.status !== 200 || r.corpo.tipo !== "web") return;
      if (r.corpo.senhaTrocar) setEtapa({ nome: "trocar_senha" });
      else router.replace("/painel");
    });
  }, [router]);

  const seguir = (senhaTrocar: boolean) => {
    if (senhaTrocar) setEtapa({ nome: "trocar_senha" });
    else router.replace("/painel");
  };

  async function enviarSenha(e: React.FormEvent) {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    const r = await chamar<{ etapa: "segundo_fator" | "configurar_segundo_fator" }>(
      "POST",
      "/auth/entrar",
      { email, senha },
    );
    if (r.status !== 200) {
      setOcupado(false);
      return setErro(
        r.semRede
          ? "Sem conexão com o servidor."
          : "E-mail ou senha não conferem. Depois de 5 erros a conta fica bloqueada por um tempo.",
      );
    }
    if (r.corpo.etapa === "configurar_segundo_fator") {
      const t = await chamar<{ uri: string; segredo: string }>("POST", "/auth/totp/iniciar", {});
      setOcupado(false);
      if (t.status !== 200)
        return setErro("Não foi possível iniciar a configuração. Entre de novo.");
      const qr = await QRCode.toDataURL(t.corpo.uri, { margin: 1, width: 240 });
      return setEtapa({ nome: "configurar", qr, segredo: t.corpo.segredo });
    }
    setOcupado(false);
    setEtapa({ nome: "codigo" });
  }

  async function enviarCodigo(e: React.FormEvent) {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    const caminho = etapa.nome === "configurar" ? "/auth/totp/confirmar" : "/auth/segundo-fator";
    const r = await chamar<{ senhaTrocar: boolean }>("POST", caminho, {
      codigo: codigo.replace(/\s/g, ""),
    });
    setOcupado(false);
    if (r.status !== 200) {
      setCodigo("");
      return setErro(
        "Código não confere. Use o código que aparece agora no aplicativo (ele muda a cada 30 segundos).",
      );
    }
    seguir(r.corpo.senhaTrocar);
  }

  async function trocarSenha(e: React.FormEvent) {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    const r = await chamar<{ problemas?: string[] }>("POST", "/auth/trocar-senha", {
      senhaAtual: senha,
      novaSenha,
    });
    setOcupado(false);
    if (r.status === 200) return router.replace("/painel");
    setErro(
      r.corpo.problemas?.join(" ") ?? "Não foi possível trocar a senha. Confira a senha atual.",
    );
  }

  return (
    <main className="entrada">
      <div className="entrada__marca">ILPI Medicação</div>
      <div className="entrada__caixa">
        {etapa.nome === "senha" && (
          <form onSubmit={enviarSenha}>
            <h1 className="tela__titulo">Entrar</h1>
            <p className="tela__texto">
              Para a gestão e a enfermagem. A equipe do plantão usa o tablet do posto.
            </p>
            {erro && (
              <p className="aviso aviso--erro" role="alert">
                {erro}
              </p>
            )}
            <label className="campo">
              <span className="campo__rotulo">E-mail</span>
              <input
                className="campo__entrada"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="campo">
              <span className="campo__rotulo">Senha</span>
              <input
                className="campo__entrada"
                type="password"
                autoComplete="current-password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="botao botao--principal botao--largo"
              disabled={ocupado}
            >
              {ocupado ? "Conferindo…" : "Continuar"}
            </button>
          </form>
        )}

        {(etapa.nome === "codigo" || etapa.nome === "configurar") && (
          <form onSubmit={enviarCodigo}>
            {etapa.nome === "configurar" ? (
              <>
                <h1 className="tela__titulo">Configure o autenticador</h1>
                <p className="tela__texto">
                  No celular, abra o aplicativo autenticador (Google Authenticator, Microsoft
                  Authenticator ou outro), toque em adicionar e leia o QR. Depois digite o código de
                  6 números que aparecer.
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element -- imagem gerada na hora (data URL) */}
                <img
                  className="entrada__qr"
                  src={etapa.qr}
                  alt="QR para configurar o aplicativo autenticador"
                  width={240}
                  height={240}
                />
                <p className="entrada__segredo">
                  Sem câmera? Digite a chave:{" "}
                  <code>{etapa.segredo.match(/.{1,4}/g)?.join(" ")}</code>
                </p>
              </>
            ) : (
              <>
                <h1 className="tela__titulo">Código do autenticador</h1>
                <p className="tela__texto">
                  Abra o aplicativo autenticador no celular e digite o código de 6 números.
                </p>
              </>
            )}
            {erro && (
              <p className="aviso aviso--erro" role="alert">
                {erro}
              </p>
            )}
            <label className="campo campo--curto">
              <span className="campo__rotulo">Código</span>
              <input
                className="campo__entrada campo__entrada--codigo"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                autoFocus
                required
              />
            </label>
            <button
              type="submit"
              className="botao botao--principal botao--largo"
              disabled={ocupado || codigo.replace(/\s/g, "").length !== 6}
            >
              {ocupado ? "Conferindo…" : "Entrar"}
            </button>
          </form>
        )}

        {etapa.nome === "trocar_senha" && (
          <form onSubmit={trocarSenha}>
            <h1 className="tela__titulo">Crie a sua senha</h1>
            <p className="tela__texto">
              A senha atual é provisória. Escolha uma frase longa, só sua (no mínimo 12 caracteres).
            </p>
            {erro && (
              <p className="aviso aviso--erro" role="alert">
                {erro}
              </p>
            )}
            {senha === "" && (
              <label className="campo">
                <span className="campo__rotulo">Senha atual</span>
                <input
                  className="campo__entrada"
                  type="password"
                  autoComplete="current-password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  required
                />
              </label>
            )}
            <label className="campo">
              <span className="campo__rotulo">Nova senha</span>
              <input
                className="campo__entrada"
                type="password"
                autoComplete="new-password"
                value={novaSenha}
                onChange={(e) => setNovaSenha(e.target.value)}
                required
                minLength={12}
              />
            </label>
            <button
              type="submit"
              className="botao botao--principal botao--largo"
              disabled={ocupado}
            >
              Salvar e entrar
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
