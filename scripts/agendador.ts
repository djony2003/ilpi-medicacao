import pg from "pg";
import { INTERVALO_PADRAO_MS, rodarAgendador, type Registro } from "@/agendador/laco";
import { correioSmtp, type Correio } from "@/compartilhado/correio";

// Processo do agendador: `npm run agendador`. Conecta com o papel `ilpi_agendador`.
// Variáveis: AGENDADOR_DATABASE_URL (obrigatória), AGENDADOR_INTERVALO_MIN (padrão 5),
// SMTP_URL e SMTP_REMETENTE (e-mail dos alertas; sem elas, os alertas ficam só no painel) e
// APP_ORIGEM (para o link do painel no e-mail).

const url = process.env.AGENDADOR_DATABASE_URL;
if (!url) {
  console.error("Variável AGENDADOR_DATABASE_URL ausente.");
  process.exit(1);
}
const minutos = Number(process.env.AGENDADOR_INTERVALO_MIN ?? INTERVALO_PADRAO_MS / 60_000);
if (!Number.isFinite(minutos) || minutos < 1 || minutos > 60) {
  console.error("AGENDADOR_INTERVALO_MIN deve estar entre 1 e 60.");
  process.exit(1);
}

const registrar: Registro = (nivel, mensagem, dados) => {
  const linha = JSON.stringify({ em: new Date().toISOString(), nivel, mensagem, ...dados });
  (nivel === "error" ? console.error : console.log)(linha);
};

const pool = new pg.Pool({ connectionString: url, max: 2 });
const controle = new AbortController();
for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, () => controle.abort());
}

registrar("info", "agendador iniciado", { intervaloMin: minutos });
let correio: Correio | undefined;
if (process.env.SMTP_URL && process.env.SMTP_REMETENTE) {
  correio = correioSmtp(process.env.SMTP_URL, process.env.SMTP_REMETENTE);
} else {
  registrar("info", "e-mail não configurado (SMTP_URL e SMTP_REMETENTE): alertas só no painel");
}
const linkDoPainel = `${process.env.APP_ORIGEM ?? "http://localhost:3000"}/painel`;

await rodarAgendador({
  servico: { pool },
  registrar,
  intervaloMs: minutos * 60_000,
  sinal: controle.signal,
  alertas: { correio, linkDoPainel },
});
await pool.end();
registrar("info", "agendador encerrado");
