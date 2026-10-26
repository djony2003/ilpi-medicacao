// Validação e normalização dos dados do idoso. Funções puras: não tocam no banco.

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Confere formato AAAA-MM-DD e se o dia existe de verdade (30 de fevereiro não passa). */
export function dataValida(texto: string): boolean {
  const m = DATA_ISO.exec(texto);
  if (!m) return false;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

export function idadeEmAnos(nascimento: string, hoje: Date): number {
  const [a = 0, m = 0, d = 0] = nascimento.split("-").map(Number);
  let idade = hoje.getUTCFullYear() - a;
  const antesDoAniversario =
    hoje.getUTCMonth() + 1 < m || (hoje.getUTCMonth() + 1 === m && hoje.getUTCDate() < d);
  if (antesDoAniversario) idade -= 1;
  return idade;
}

export function normalizarCpf(texto: string): string {
  return texto.replace(/\D/g, "");
}

export function cpfValido(texto: string): boolean {
  const cpf = normalizarCpf(texto);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digito = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return (
    digito(cpf.slice(0, 9), 10) === Number(cpf[9]) &&
    digito(cpf.slice(0, 10), 11) === Number(cpf[10])
  );
}

export function mascararCpf(cpf: string): string {
  const n = normalizarCpf(cpf);
  return n.length === 11 ? `***.***.***-${n.slice(9)}` : "***";
}

/** Telefone brasileiro: DDD + 8 ou 9 dígitos, com ou sem +55. Devolve só os dígitos (sem o 55). */
export function normalizarTelefone(texto: string): string | null {
  let n = texto.replace(/\D/g, "");
  if ((n.length === 12 || n.length === 13) && n.startsWith("55")) n = n.slice(2);
  if (n.length !== 10 && n.length !== 11) return null;
  if (n.startsWith("0")) return null;
  const ddd = Number(n.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (n.length === 11 && n[2] !== "9") return null; // celular começa com 9
  return n;
}

export function mascararTelefone(telefone: string): string {
  const n = telefone.replace(/\D/g, "");
  return n.length >= 4 ? `(${n.slice(0, 2)}) *****-${n.slice(-4)}` : "*****";
}

export function formatarTelefone(telefone: string): string {
  const n = telefone.replace(/\D/g, "");
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return n;
}

export type EntradaIdoso = {
  nome: string;
  dataNascimento: string;
  cpf?: string | null;
  quarto?: string | null;
};

export function validarIdoso(entrada: Partial<EntradaIdoso>, hoje: Date): string[] {
  const problemas: string[] = [];
  if (entrada.nome !== undefined) {
    const nome = entrada.nome.trim();
    if (nome.length < 2 || nome.length > 200) problemas.push("Informe o nome (2 a 200 letras).");
  }
  if (entrada.dataNascimento !== undefined) {
    if (!dataValida(entrada.dataNascimento)) {
      problemas.push("Data de nascimento inválida. Use o formato AAAA-MM-DD.");
    } else {
      const idade = idadeEmAnos(entrada.dataNascimento, hoje);
      if (idade < 0) problemas.push("A data de nascimento não pode ser no futuro.");
      else if (idade > 125)
        problemas.push("Confira a data de nascimento: a idade passa de 125 anos.");
    }
  }
  if (entrada.cpf && !cpfValido(entrada.cpf)) problemas.push("CPF inválido.");
  if (entrada.quarto && entrada.quarto.trim().length > 40) {
    problemas.push("O quarto pode ter no máximo 40 caracteres.");
  }
  return problemas;
}

export const GRAVIDADES = ["leve", "moderada", "grave"] as const;
export type Gravidade = (typeof GRAVIDADES)[number];

export type EntradaAlergia = {
  substancia: string;
  gravidade: Gravidade;
  observacao?: string | null;
};

export function validarAlergia(entrada: EntradaAlergia): string[] {
  const problemas: string[] = [];
  const substancia = entrada.substancia.trim();
  if (substancia.length < 2 || substancia.length > 120) {
    problemas.push("Informe a substância da alergia (2 a 120 letras).");
  }
  if (!GRAVIDADES.includes(entrada.gravidade)) problemas.push("Gravidade desconhecida.");
  if ((entrada.observacao ?? "").length > 500) {
    problemas.push("A observação da alergia pode ter no máximo 500 caracteres.");
  }
  return problemas;
}

export type EntradaContato = {
  nome: string;
  parentesco: string;
  telefone: string;
  responsavelLegal?: boolean;
};

export function validarContato(entrada: EntradaContato): string[] {
  const problemas: string[] = [];
  const nome = entrada.nome.trim();
  const parentesco = entrada.parentesco.trim();
  if (nome.length < 2 || nome.length > 200) problemas.push("Informe o nome do contato.");
  if (parentesco.length < 2 || parentesco.length > 60) problemas.push("Informe o parentesco.");
  if (normalizarTelefone(entrada.telefone) === null) {
    problemas.push("Telefone inválido. Informe DDD e número, por exemplo (11) 91234-5678.");
  }
  return problemas;
}
