import Link from "next/link";

export default function PaginaInicial() {
  return (
    <main className="entrada">
      <div className="entrada__marca">ILPI Medicação</div>
      <div className="entrada__caixa">
        <h1 className="tela__titulo">Medicação segura na casa</h1>
        <p className="tela__texto">
          Gestão e enfermagem entram pelo computador. A equipe do plantão usa o tablet do posto.
        </p>
        <div className="acoes">
          <Link className="botao botao--principal" href="/entrar">
            Entrar no painel
          </Link>
          <Link className="botao" href="/tablet">
            Abrir o tablet do posto
          </Link>
        </div>
      </div>
    </main>
  );
}
