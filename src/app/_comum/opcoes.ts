// Listas de opções das telas (cópia das do servidor: o navegador não importa código do servidor).
export const FORMAS = [
  ["comprimido", "Comprimido"],
  ["capsula", "Cápsula"],
  ["gotas", "Gotas"],
  ["xarope", "Xarope"],
  ["solucao", "Solução"],
  ["suspensao", "Suspensão"],
  ["injetavel", "Injetável"],
  ["pomada", "Pomada"],
  ["creme", "Creme"],
  ["adesivo", "Adesivo"],
  ["spray", "Spray"],
  ["supositorio", "Supositório"],
  ["po", "Pó"],
  ["outro", "Outro"],
] as const;
export const UNIDADES = [
  ["comprimido", "comprimido(s)"],
  ["capsula", "cápsula(s)"],
  ["gotas", "gotas"],
  ["ml", "ml"],
  ["mg", "mg"],
  ["g", "g"],
  ["mcg", "mcg"],
  ["ui", "UI"],
  ["aplicacao", "aplicação(ões)"],
  ["jato", "jato(s)"],
  ["adesivo", "adesivo(s)"],
] as const;
export const VIAS = [
  ["oral", "Oral"],
  ["sublingual", "Sublingual"],
  ["topica", "Tópica"],
  ["oftalmica", "Oftálmica"],
  ["otica", "Ótica"],
  ["nasal", "Nasal"],
  ["inalatoria", "Inalatória"],
  ["retal", "Retal"],
  ["subcutanea", "Subcutânea"],
  ["intramuscular", "Intramuscular"],
  ["intravenosa", "Intravenosa"],
  ["transdermica", "Transdérmica"],
] as const;
export type Medicamento = {
  id: string;
  nomeComercial: string;
  principioAtivo: string;
  concentracao: string | null;
  forma: string;
  altoRisco: boolean;
  ativo: boolean;
};
