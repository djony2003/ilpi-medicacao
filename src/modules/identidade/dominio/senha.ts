// Regras de senha para gestor e enfermeiro. Retorna a lista de problemas (vazia se a senha serve).
// Segue a orientação atual (NIST 800-63B): tamanho mínimo, sem regras de composição forçadas,
// recusa de senhas óbvias e de senhas derivadas dos dados da própria pessoa.

export const TAMANHO_MINIMO_SENHA = 12;
export const TAMANHO_MAXIMO_SENHA = 128;

const SENHAS_COMUNS = new Set([
  "123456789012",
  "1234567890123",
  "senha1234567",
  "senhasenha123",
  "password1234",
  "passwordpassword",
  "qwertyuiop12",
  "qwertyuiopasdf",
  "administrador",
  "administrador123",
  "mudar1234567",
  "trocar123456",
  "brasil123456",
  "abcdefghijkl",
  "asdfghjkl123",
  "iloveyou1234",
  "casadeidosos",
  "casadeidosos123",
]);

export type ContextoDaSenha = { email?: string | null; nome?: string | null };

function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function validarSenha(senha: string, contexto: ContextoDaSenha = {}): string[] {
  const problemas: string[] = [];

  if (senha.length < TAMANHO_MINIMO_SENHA) {
    problemas.push(`A senha precisa ter pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.`);
  }
  if (senha.length > TAMANHO_MAXIMO_SENHA) {
    problemas.push(`A senha pode ter no máximo ${TAMANHO_MAXIMO_SENHA} caracteres.`);
  }

  const normalizada = semAcento(senha).toLowerCase();
  if (SENHAS_COMUNS.has(normalizada)) {
    problemas.push("Essa senha é muito comum. Escolha outra.");
  }
  if (senha.length > 0 && new Set(senha).size <= 2) {
    problemas.push("A senha não pode ser formada por poucos caracteres repetidos.");
  }

  const trechos: string[] = [];
  if (contexto.email) trechos.push(contexto.email.split("@")[0] ?? "");
  if (contexto.nome) trechos.push(...contexto.nome.split(/\s+/));
  const usaDadosPessoais = trechos
    .map((t) => semAcento(t).toLowerCase())
    .some((t) => t.length >= 4 && normalizada.includes(t));
  if (usaDadosPessoais) {
    problemas.push("A senha não pode conter o seu nome nem o início do seu e-mail.");
  }

  return problemas;
}
