// Conferência de alergia contra o princípio ativo do medicamento. A regra é conservadora: prefere
// avisar à toa a deixar passar. Um aviso nunca bloqueia sozinho: quem prescreve confirma conscientemente.

export type AlergiaParaConferir = {
  id: string;
  substancia: string;
  gravidade: "leve" | "moderada" | "grave";
};

export type ConflitoDeAlergia = {
  alergiaId: string;
  substancia: string;
  gravidade: AlergiaParaConferir["gravidade"];
  tipo: "mesma_substancia" | "mesma_familia";
};

/** Minúsculas, sem acento, sem pontuação, espaços únicos. */
export function normalizarNome(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Palavras que aparecem em muitos nomes e não identificam a substância.
const NEUTRAS = new Set([
  "de",
  "do",
  "da",
  "dos",
  "das",
  "e",
  "com",
  "acido",
  "sodica",
  "sodico",
  "potassica",
  "potassico",
  "calcica",
  "calcico",
  "cloridrato",
  "sulfato",
  "fosfato",
  "citrato",
  "tartarato",
  "maleato",
  "succinato",
  "besilato",
  "mesilato",
  "bromidrato",
  "nitrato",
  "acetato",
  "oral",
  "simples",
  "composto",
]);

// Nomes populares e famílias de uso comum no Brasil. Ajuda, não substitui o julgamento clínico.
const SINONIMOS: string[][] = [
  ["dipirona", "metamizol", "metamizole", "novalgina", "anador"],
  ["aas", "aspirina", "acido acetilsalicilico", "acetilsalicilico"],
  ["paracetamol", "acetaminofeno", "tylenol"],
  ["ibuprofeno", "advil", "alivium"],
  ["diclofenaco", "voltaren", "cataflam"],
  ["omeprazol", "losec"],
  ["sinvastatina", "zocor"],
  ["losartana", "cozaar"],
  ["furosemida", "lasix"],
];

const FAMILIAS: Array<{ nome: string; membros: string[] }> = [
  {
    nome: "penicilinas",
    membros: [
      "penicilina",
      "amoxicilina",
      "ampicilina",
      "benzilpenicilina",
      "oxacilina",
      "piperacilina",
      "clavulanato",
    ],
  },
  {
    nome: "sulfas",
    membros: ["sulfa", "sulfametoxazol", "sulfadiazina", "sulfonamida", "bactrim"],
  },
  {
    nome: "anti-inflamatorios",
    membros: [
      "aine",
      "anti inflamatorio",
      "aas",
      "aspirina",
      "ibuprofeno",
      "diclofenaco",
      "naproxeno",
      "cetoprofeno",
      "nimesulida",
      "meloxicam",
      "piroxicam",
    ],
  },
  {
    nome: "opioides",
    membros: ["opioide", "morfina", "codeina", "tramadol", "fentanil", "oxicodona", "metadona"],
  },
];

function tokens(nome: string): string[] {
  return normalizarNome(nome)
    .split(" ")
    .filter((t) => t.length >= 3 && !NEUTRAS.has(t));
}

function mesmoSinonimo(a: string, b: string): boolean {
  return SINONIMOS.some((g) => g.includes(a) && g.includes(b));
}

function gruposDe(nome: string): Set<string> {
  const n = normalizarNome(nome);
  const t = new Set(tokens(nome));
  const achados = new Set<string>();
  for (const f of FAMILIAS) {
    const bate = f.membros.some((m) =>
      m.includes(" ")
        ? n.includes(m)
        : t.has(m) ||
          [...t].some(
            (x) => x.length >= 6 && m.length >= 6 && (x.startsWith(m) || m.startsWith(x)),
          ),
    );
    if (bate) achados.add(f.nome);
  }
  return achados;
}

function mesmaSubstancia(principioAtivo: string, substanciaAlergia: string): boolean {
  const tp = tokens(principioAtivo);
  const ta = tokens(substanciaAlergia);
  for (const a of ta) {
    for (const p of tp) {
      if (a === p || mesmoSinonimo(a, p)) return true;
      // "penicilina" x "benzilpenicilina": um contém o outro (só com 6+ letras, evita acidentes).
      if (a.length >= 6 && p.length >= 6 && (a.includes(p) || p.includes(a))) return true;
    }
  }
  return false;
}

/**
 * Alergias ativas que coincidem com o princípio ativo (ou com o nome comercial, que muitas vezes
 * é o que a pessoa lembra: "Novalgina"). Ordem: da mais grave para a mais leve.
 */
export function conflitosComAlergia(
  medicamento: { principioAtivo: string; nomeComercial?: string },
  alergias: AlergiaParaConferir[],
): ConflitoDeAlergia[] {
  const nomes = [medicamento.principioAtivo, medicamento.nomeComercial].filter((n): n is string =>
    Boolean(n),
  );
  const gruposDoMedicamento = new Set(nomes.flatMap((n) => [...gruposDe(n)]));
  const peso = { grave: 0, moderada: 1, leve: 2 } as const;
  const achados: ConflitoDeAlergia[] = [];

  for (const a of alergias) {
    if (nomes.some((n) => mesmaSubstancia(n, a.substancia))) {
      achados.push({
        alergiaId: a.id,
        substancia: a.substancia,
        gravidade: a.gravidade,
        tipo: "mesma_substancia",
      });
    } else if ([...gruposDe(a.substancia)].some((g) => gruposDoMedicamento.has(g))) {
      achados.push({
        alergiaId: a.id,
        substancia: a.substancia,
        gravidade: a.gravidade,
        tipo: "mesma_familia",
      });
    }
  }
  return achados.sort((x, y) => peso[x.gravidade] - peso[y.gravidade]);
}
