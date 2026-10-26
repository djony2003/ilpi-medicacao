import { normalizarNome } from "./alergia";

// Medicamentos de alta vigilância (lista de referência do ISMP Brasil, resumida). O sistema só SUGERE
// "alto risco" ao cadastrar o medicamento; quem prescreve decide, e a segunda validação é aplicada
// pelo que ficou marcado na prescrição.
const ALTA_VIGILANCIA = [
  "insulina",
  "varfarina",
  "heparina",
  "enoxaparina",
  "rivaroxabana",
  "apixabana",
  "dabigatrana",
  "metotrexato",
  "digoxina",
  "morfina",
  "fentanil",
  "oxicodona",
  "metadona",
  "hidromorfona",
  "cloreto de potassio",
  "potassio",
  "amiodarona",
  "lítio",
  "litio",
  "nitroprussiato",
  "midazolam",
  "clonazepam",
  "diazepam",
  "haloperidol",
  "carbamazepina",
  "fenitoina",
  "tacrolimo",
  "ciclosporina",
];

export function sugerirAltoRisco(principioAtivo: string): boolean {
  const n = normalizarNome(principioAtivo);
  return ALTA_VIGILANCIA.some((a) => n.includes(normalizarNome(a)));
}
