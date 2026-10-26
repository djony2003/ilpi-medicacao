import type pg from "pg";
import { expect } from "vitest";
import { cifrar } from "@/compartilhado/criptografia";
import {
  ativarDispositivo,
  autenticarSessao,
  criarDispositivo,
  entrar,
  entrarComPin,
  gerarCodigo,
  gerarSegredoTotp,
  passoDe,
  reautenticar,
  verificarSegundoFator,
  type Servico,
  type SessaoAutenticada,
} from "@/modules/identidade";
import { SENHA_PADRAO, criarUsuario, type UsuarioDeTeste } from "./dados";

export type AtorWeb = SessaoAutenticada & {
  token: string;
  usuario: UsuarioDeTeste;
  segredoTotp: string;
};

/**
 * Cria um gestor ou enfermeiro com autenticador ativo, faz o login completo pelo caminho real
 * (senha + código) e devolve a sessão autenticada. Com `reautenticado`, confirma a senha também.
 */
export async function criarAtorWeb(
  servico: () => Servico,
  migrador: pg.Pool,
  casaId: string,
  perfil: "gestor" | "enfermeiro" = "gestor",
  opcoes: { reautenticado?: boolean } = {},
): Promise<AtorWeb> {
  const chave = servico().chaveCampos;
  const segredoTotp = gerarSegredoTotp();
  const usuario = await criarUsuario(migrador, casaId, {
    perfil,
    totpSegredoCifrado: cifrar(segredoTotp, chave),
    totpAtivo: true,
  });

  const etapa1 = await entrar(servico(), { email: usuario.email ?? "", senha: SENHA_PADRAO });
  if (!etapa1.ok) throw new Error("a senha deveria ser aceita");
  const agora = servico().agora?.() ?? new Date();
  const etapa2 = await verificarSegundoFator(servico(), {
    token: etapa1.token,
    codigo: gerarCodigo(segredoTotp, passoDe(agora.getTime())),
  });
  if (!etapa2.ok) throw new Error("o segundo fator deveria ser aceito");

  if (opcoes.reautenticado) {
    const antes = await autenticarSessao(servico(), etapa1.token);
    if (!antes) throw new Error("a sessão deveria valer");
    expect((await reautenticar(servico(), antes, { segredo: SENHA_PADRAO })).ok).toBe(true);
  }
  const sessao = await autenticarSessao(servico(), etapa1.token);
  if (!sessao) throw new Error("a sessão deveria valer");
  return { ...sessao, token: etapa1.token, usuario, segredoTotp };
}

export type AtorTablet = SessaoAutenticada & { token: string; usuario: UsuarioDeTeste };

/**
 * Cria um tablet aprovado e um usuário com PIN, e entra pelo caminho real (aparelho + PIN).
 * Por padrão o usuário é cuidador, o perfil mais restrito.
 */
export async function criarAtorTablet(
  servico: () => Servico,
  migrador: pg.Pool,
  casaId: string,
  perfil: "cuidador" | "enfermeiro" = "cuidador",
): Promise<AtorTablet> {
  const gestor = await criarAtorWeb(servico, migrador, casaId, "gestor", { reautenticado: true });
  const { codigo } = await criarDispositivo(servico(), gestor, { nome: "Tablet de teste" });
  const ativacao = await ativarDispositivo(servico(), { codigo });
  if (!ativacao.ok) throw new Error("a ativação deveria funcionar");
  const usuario = await criarUsuario(migrador, casaId, { perfil, pin: "846201" });
  const entrada = await entrarComPin(servico(), {
    tokenDoDispositivo: ativacao.token,
    usuarioId: usuario.id,
    pin: "846201",
  });
  if (!entrada.ok) throw new Error("o PIN deveria ser aceito");
  const sessao = await autenticarSessao(servico(), entrada.token);
  if (!sessao) throw new Error("a sessão deveria valer");
  return { ...sessao, token: entrada.token, usuario };
}
