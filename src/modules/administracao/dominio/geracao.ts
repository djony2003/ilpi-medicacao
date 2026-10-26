import { diasEntre, somarDias } from "@/compartilhado/datas";
import { horariosNoDia, type Horario } from "@/modules/prescricoes";
import { instanteLocal } from "./tempo";

// Geração das doses de uma prescrição regular. Função pura: não toca em banco nem em relógio.

export type PrescricaoParaGerar = {
  id: string;
  /** AAAA-MM-DD */
  inicio: string;
  fim: string | null;
  /** Quando a versão foi criada: não se geram doses de antes disso (ver `dosesDoPeriodo`). */
  criadaEm: Date;
  horarios: Horario[];
};

export type DoseGerada = {
  prescricaoId: string;
  dataLocal: string;
  horaLocal: string;
  previstaEm: Date;
};

/** Maior intervalo de datas aceito numa chamada, para um erro de uso não gerar milhões de linhas. */
export const MAX_DIAS_DE_GERACAO = 60;

/**
 * Doses de `de` a `ate` (datas locais, inclusive), respeitando vigência, dias da semana e fuso.
 *
 * Só nasce dose com horário igual ou posterior ao momento em que a versão da prescrição foi criada.
 * Isso evita a dose "fantasma": ao mudar a dose às 9h, a nova versão não ganha um horário das 8h
 * que a antiga já cumpriu e que a equipe daria de novo.
 */
export function dosesDoPeriodo(
  p: PrescricaoParaGerar,
  de: string,
  ate: string,
  fuso: string,
): DoseGerada[] {
  const dias = diasEntre(de, ate);
  if (dias < 0) return [];
  if (dias + 1 > MAX_DIAS_DE_GERACAO) throw new Error("Período de geração grande demais.");

  const primeiro = de > p.inicio ? de : p.inicio;
  const ultimo = p.fim !== null && p.fim < ate ? p.fim : ate;
  const doses: DoseGerada[] = [];
  for (let dia = primeiro; dia <= ultimo; dia = somarDias(dia, 1)) {
    for (const hora of horariosNoDia(p.horarios, dia)) {
      const previstaEm = instanteLocal(dia, hora, fuso);
      if (previstaEm.getTime() < p.criadaEm.getTime()) continue;
      doses.push({ prescricaoId: p.id, dataLocal: dia, horaLocal: hora, previstaEm });
    }
  }
  return doses;
}
