// Vocabulário da prescrição. Os valores são os mesmos dos tipos enumerados do banco (0005).

export const FORMAS = [
  "comprimido",
  "capsula",
  "gotas",
  "xarope",
  "solucao",
  "suspensao",
  "injetavel",
  "pomada",
  "creme",
  "adesivo",
  "spray",
  "supositorio",
  "po",
  "outro",
] as const;
export const UNIDADES = [
  "comprimido",
  "capsula",
  "gotas",
  "ml",
  "mg",
  "g",
  "mcg",
  "ui",
  "aplicacao",
  "jato",
  "adesivo",
] as const;
export const VIAS = [
  "oral",
  "sublingual",
  "topica",
  "oftalmica",
  "otica",
  "nasal",
  "inalatoria",
  "retal",
  "subcutanea",
  "intramuscular",
  "intravenosa",
  "transdermica",
] as const;
export const TIPOS = ["regular", "sos"] as const;

export type Forma = (typeof FORMAS)[number];
export type UnidadeDeDose = (typeof UNIDADES)[number];
export type Via = (typeof VIAS)[number];
export type TipoDePrescricao = (typeof TIPOS)[number];
export type StatusDePrescricao = "ativa" | "encerrada" | "substituida";

export type Horario = {
  /** Hora de parede no fuso da casa, "HH:MM". */
  hora: string;
  /** 1 = segunda ... 7 = domingo. Vazio ou ausente = todos os dias. */
  diasSemana?: number[];
};

export type EntradaSos = {
  indicacao: string;
  limiteDiario: number;
  intervaloMinimoMin: number;
};

/** Conteúdo clínico de uma prescrição, como digitado pelo enfermeiro a partir da receita. */
export type ConteudoDePrescricao = {
  medicamentoId: string;
  tipo: TipoDePrescricao;
  dose: number;
  unidade: UnidadeDeDose;
  via: Via;
  instrucoes?: string | null;
  /** AAAA-MM-DD */
  inicio: string;
  /** AAAA-MM-DD; ausente ou null = uso contínuo. */
  fim?: string | null;
  altoRisco: boolean;
  horarios: Horario[];
  sos?: EntradaSos | null;
  prescritor?: string | null;
};
