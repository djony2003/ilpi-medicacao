import pg from "pg";
import { INTERVALO_PADRAO_MS, rodarAgendador, type Registro } from "@/agendador/laco";

// Processo do agendador: `npm run agendador`. Conecta com o papel `ilpi_agendador`.
// Variáveis: AGENDADOR_DATABASE_URL (obrigatória) e AGENDADOR_INTERVALO_MIN (padrão 15).

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
await rodarAgendador({
  servico: { pool },
  registrar,
  intervaloMs: minutos * 60_000,
  sinal: controle.signal,
});
await pool.end();
registrar("info", "agendador encerrado");
