// Módulo identidade: login, perfis, PIN no tablet, sessões e aparelhos cadastrados.
// Interface pública: tudo o que outros módulos podem usar deve ser exportado daqui.
export {
  ACOES,
  ErroDePermissao,
  PERFIS,
  exigirPermissao,
  podeExecutar,
  type Acao,
  type Perfil,
} from "./dominio/permissoes";
export {
  confirmarConfiguracaoTotp,
  entrar,
  iniciarConfiguracaoTotp,
  verificarSegundoFator,
  type InicioDaConfiguracaoTotp,
  type ResultadoDaSenha,
  type ResultadoDoSegundoFator,
} from "./dados/login";
export { hashSenha, verificarSenhaHash } from "./dados/hash-senha";
export { type Servico } from "./dados/servico";
export {
  autenticarSessao,
  criarSessao,
  localizarSessao,
  revogarSessoesDoUsuario,
  sair,
  type SessaoAutenticada,
} from "./dados/sessao";
export { POLITICA } from "./dominio/politica";
export { TAMANHO_PIN, validarPin } from "./dominio/pin";
export {
  TAMANHO_MAXIMO_SENHA,
  TAMANHO_MINIMO_SENHA,
  validarSenha,
  type ContextoDaSenha,
} from "./dominio/senha";
export {
  PERIODO_SEGUNDOS,
  codificarBase32,
  decodificarBase32,
  gerarCodigo,
  gerarSegredoTotp,
  montarUriTotp,
  passoDe,
  verificarCodigo,
} from "./dominio/totp";
