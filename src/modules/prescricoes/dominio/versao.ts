import { normalizarDias, normalizarHora } from "./validacao";
import type { ConteudoDePrescricao, Horario } from "./tipos";

// Compara duas versões da mesma prescrição. Serve a duas regras: uma "nova versão" idêntica à
// anterior é recusada (não há o que corrigir), e a trilha de auditoria guarda QUAIS campos
// mudaram, sem copiar o conteúdo.

export type CampoClinico =
  | "medicamento"
  | "tipo"
  | "dose"
  | "unidade"
  | "via"
  | "instrucoes"
  | "inicio"
  | "fim"
  | "altoRisco"
  | "horarios"
  | "sos"
  | "prescritor";

function horariosCanonicos(horarios: Horario[]): string {
  return JSON.stringify(
    horarios
      .map((h) => [normalizarHora(h.hora) ?? h.hora, normalizarDias(h.diasSemana)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

const vazioParaNulo = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function diferencasClinicas(
  antiga: ConteudoDePrescricao,
  nova: ConteudoDePrescricao,
): CampoClinico[] {
  const mudou: CampoClinico[] = [];
  if (antiga.medicamentoId !== nova.medicamentoId) mudou.push("medicamento");
  if (antiga.tipo !== nova.tipo) mudou.push("tipo");
  if (antiga.dose !== nova.dose) mudou.push("dose");
  if (antiga.unidade !== nova.unidade) mudou.push("unidade");
  if (antiga.via !== nova.via) mudou.push("via");
  if (vazioParaNulo(antiga.instrucoes) !== vazioParaNulo(nova.instrucoes)) mudou.push("instrucoes");
  if (antiga.inicio !== nova.inicio) mudou.push("inicio");
  if ((antiga.fim ?? null) !== (nova.fim ?? null)) mudou.push("fim");
  if (antiga.altoRisco !== nova.altoRisco) mudou.push("altoRisco");
  if (horariosCanonicos(antiga.horarios) !== horariosCanonicos(nova.horarios))
    mudou.push("horarios");
  if (JSON.stringify(sosCanonico(antiga)) !== JSON.stringify(sosCanonico(nova))) mudou.push("sos");
  if (vazioParaNulo(antiga.prescritor) !== vazioParaNulo(nova.prescritor)) mudou.push("prescritor");
  return mudou;
}

function sosCanonico(c: ConteudoDePrescricao) {
  return c.sos
    ? [c.sos.indicacao.trim().toLowerCase(), c.sos.limiteDiario, c.sos.intervaloMinimoMin]
    : null;
}
