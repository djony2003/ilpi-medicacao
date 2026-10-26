import { dataValida, diasEntre } from "@/compartilhado/datas";
import { TIPOS, UNIDADES, VIAS, type ConteudoDePrescricao, type Horario } from "./tipos";

// Validação da prescrição. Função pura: devolve os problemas em português claro, vazio se tudo certo.

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_HORARIOS_POR_DIA = 24;
export const DOSE_MAXIMA = 100_000;
/** Início no máximo um ano à frente: mais que isso quase sempre é erro de digitação do ano. */
export const MAX_DIAS_NO_FUTURO = 365;

export function normalizarHora(hora: string): string | null {
  const m = HORA.exec(hora.trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

/** Dias 1..7 sem repetição e em ordem; lista vazia ou ausente vira todos os dias. */
export function normalizarDias(dias: number[] | undefined): number[] {
  if (!dias || dias.length === 0) return [1, 2, 3, 4, 5, 6, 7];
  return [...new Set(dias)].sort((a, b) => a - b);
}

function validarHorarios(horarios: Horario[]): string[] {
  const problemas: string[] = [];
  const vistas = new Set<string>();
  for (const h of horarios) {
    const hora = normalizarHora(h.hora);
    if (!hora) {
      problemas.push(`Horário inválido: "${h.hora}". Use HH:MM, de 00:00 a 23:59.`);
      continue;
    }
    if (vistas.has(hora)) problemas.push(`O horário ${hora} aparece mais de uma vez.`);
    vistas.add(hora);
    const dias = h.diasSemana ?? [];
    if (dias.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      problemas.push(
        `Dias da semana inválidos no horário ${hora}: use números de 1 (segunda) a 7 (domingo).`,
      );
    }
  }
  return problemas;
}

/**
 * @param hoje data de hoje NO FUSO DA CASA (AAAA-MM-DD), calculada por quem chama.
 */
export function validarPrescricao(c: ConteudoDePrescricao, hoje: string): string[] {
  const p: string[] = [];

  if (!TIPOS.includes(c.tipo)) p.push("Tipo de prescrição desconhecido.");
  if (!UNIDADES.includes(c.unidade)) p.push("Unidade da dose desconhecida.");
  if (!VIAS.includes(c.via)) p.push("Via de administração desconhecida.");

  if (!Number.isFinite(c.dose) || c.dose <= 0) p.push("A dose deve ser maior que zero.");
  else if (c.dose > DOSE_MAXIMA) p.push("Confira a dose: o valor é alto demais.");
  else if (Math.round(c.dose * 1000) / 1000 !== c.dose)
    p.push("A dose aceita até 3 casas decimais.");

  if (c.instrucoes && c.instrucoes.length > 500)
    p.push("As instruções podem ter no máximo 500 caracteres.");
  if (c.prescritor && (c.prescritor.trim().length < 2 || c.prescritor.length > 200)) {
    p.push("O nome de quem prescreveu deve ter entre 2 e 200 caracteres.");
  }

  const inicioOk = dataValida(c.inicio);
  if (!inicioOk) p.push("Data de início inválida. Use o formato AAAA-MM-DD.");
  else if (diasEntre(hoje, c.inicio) > MAX_DIAS_NO_FUTURO) {
    p.push("Confira a data de início: ela está a mais de um ano no futuro.");
  }
  if (c.fim !== undefined && c.fim !== null) {
    if (!dataValida(c.fim)) p.push("Data de fim inválida. Use o formato AAAA-MM-DD.");
    else {
      if (inicioOk && c.fim < c.inicio) p.push("O fim da prescrição não pode ser antes do início.");
      if (c.fim < hoje) p.push("O fim da prescrição já passou: não há o que administrar.");
    }
  }

  if (c.tipo === "regular") {
    if (c.horarios.length === 0) p.push("Informe ao menos um horário.");
    if (c.horarios.length > MAX_HORARIOS_POR_DIA) p.push("No máximo 24 horários por prescrição.");
    if (c.sos) p.push("Prescrição com horários fixos não leva limite de 'se necessário'.");
    p.push(...validarHorarios(c.horarios));
  } else if (c.tipo === "sos") {
    if (c.horarios.length > 0) p.push("Dose 'se necessário' não tem horários fixos.");
    const s = c.sos;
    if (!s)
      p.push("Informe a indicação, o limite por dia e o intervalo mínimo da dose 'se necessário'.");
    else {
      if (s.indicacao.trim().length < 3 || s.indicacao.length > 200) {
        p.push("A indicação (sintoma) deve ter entre 3 e 200 caracteres.");
      }
      if (!Number.isInteger(s.limiteDiario) || s.limiteDiario < 1 || s.limiteDiario > 24) {
        p.push("O limite por dia deve ser um número inteiro de 1 a 24.");
      }
      if (
        !Number.isInteger(s.intervaloMinimoMin) ||
        s.intervaloMinimoMin < 1 ||
        s.intervaloMinimoMin > 1440
      ) {
        p.push("O intervalo mínimo deve ser de 1 a 1440 minutos.");
      }
    }
  }
  return p;
}
