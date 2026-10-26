import type { PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { registrarAuditoria } from "@/modules/auditoria";
import { PERFIS, exigirPermissao, type Perfil } from "../dominio/permissoes";
import { validarPin } from "../dominio/pin";
import { exigirReautenticacaoRecente } from "../dominio/reautenticacao";
import { validarSenha } from "../dominio/senha";
import { gastarTempoDeVerificacao, hashSenha, verificarSenhaHash } from "./hash-senha";
import { relogio, type Servico } from "./servico";
import { revogarSessoesDoUsuario, type SessaoAutenticada } from "./sessao";
import { carregarUsuarioTravado, estaBloqueado, registrarFalha } from "./tentativas";

// Gestão de usuários. Tudo aqui exige gestor com confirmação recente de senha, exceto trocar a
// própria senha ou PIN, que qualquer pessoa autenticada faz confirmando a credencial atual.
//
// Regras que o banco sozinho não garante:
// - nunca ficar sem gestor ativo na casa;
// - ninguém desativa a si mesmo (evita trancar a casa sem querer);
// - redefinir ou desativar derruba na hora as sessões abertas da pessoa;
// - credenciais definidas por gestor são provisórias: a pessoa é obrigada a trocar.

export type Rejeicao =
  | { ok: false; motivo: "dados_invalidos"; problemas: string[] }
  | { ok: false; motivo: "email_em_uso" }
  | { ok: false; motivo: "usuario_nao_encontrado" }
  | { ok: false; motivo: "proprio_usuario" }
  | { ok: false; motivo: "ultimo_gestor" }
  | { ok: false; motivo: "credencial_atual_incorreta" }
  | { ok: false; motivo: "sem_credencial" };

const invalido = (...problemas: string[]): Rejeicao => ({
  ok: false,
  motivo: "dados_invalidos",
  problemas,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NovoUsuario = {
  nome: string;
  perfil: Perfil;
  /** Obrigatório para gestor e enfermeiro (entram pela web). Cuidador não usa. */
  email?: string;
  registroProfissional?: string;
  /** Senha provisória (gestor e enfermeiro). */
  senhaInicial?: string;
  /** PIN provisório. Obrigatório para cuidador; opcional para os demais. */
  pinInicial?: string;
};

export type ResumoDeUsuario = {
  id: string;
  nome: string;
  email: string | null;
  perfil: Perfil;
  registroProfissional: string | null;
  ativo: boolean;
  bloqueadoAte: Date | null;
  totpAtivo: boolean;
  temPin: boolean;
};

function exigirGestorConfirmado(servico: Servico, ator: SessaoAutenticada): Date {
  exigirPermissao(ator.perfil, "usuarios.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);
  return agora;
}

function contextoDo(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

export async function listarUsuarios(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<ResumoDeUsuario[]> {
  exigirPermissao(ator.perfil, "usuarios.gerir");
  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const r = await c.query<{
      id: string;
      nome: string;
      email: string | null;
      perfil: Perfil;
      registro_profissional: string | null;
      ativo: boolean;
      bloqueado_ate: Date | null;
      totp_ativo: boolean;
      tem_pin: boolean;
    }>(
      `SELECT id, nome, email, perfil, registro_profissional, ativo, bloqueado_ate, totp_ativo,
              (pin_hash IS NOT NULL) AS tem_pin
         FROM usuario ORDER BY ativo DESC, nome`,
    );
    return r.rows.map((l) => ({
      id: l.id,
      nome: l.nome,
      email: l.email,
      perfil: l.perfil,
      registroProfissional: l.registro_profissional,
      ativo: l.ativo,
      bloqueadoAte: l.bloqueado_ate,
      totpAtivo: l.totp_ativo,
      temPin: l.tem_pin,
    }));
  });
}

export async function criarUsuario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: NovoUsuario & { ip?: string | null },
): Promise<{ ok: true; usuarioId: string } | Rejeicao> {
  const agora = exigirGestorConfirmado(servico, ator);

  const nome = entrada.nome.trim();
  const email = entrada.email?.trim().toLowerCase();
  const problemas: string[] = [];
  if (nome.length < 2 || nome.length > 120) problemas.push("Informe o nome (2 a 120 letras).");
  if (!PERFIS.includes(entrada.perfil)) problemas.push("Perfil desconhecido.");
  if ((entrada.registroProfissional ?? "").length > 40) {
    problemas.push("O registro profissional pode ter no máximo 40 caracteres.");
  }

  const entraPelaWeb = entrada.perfil !== "cuidador";
  if (entraPelaWeb) {
    if (!email || email.length > 254 || !EMAIL.test(email))
      problemas.push("Informe um e-mail válido.");
    if (entrada.senhaInicial === undefined) {
      problemas.push("Informe a senha provisória.");
    } else {
      problemas.push(...validarSenha(entrada.senhaInicial, { email, nome }));
    }
  } else if (email) {
    problemas.push("Cuidador não usa e-mail: ele entra só com PIN no tablet.");
  }
  if (entrada.perfil === "cuidador" && entrada.pinInicial === undefined) {
    problemas.push("Informe o PIN provisório do cuidador.");
  }
  if (entrada.pinInicial !== undefined) problemas.push(...validarPin(entrada.pinInicial));
  if (problemas.length > 0) return { ok: false, motivo: "dados_invalidos", problemas };

  const senhaHash =
    entraPelaWeb && entrada.senhaInicial ? await hashSenha(entrada.senhaInicial) : null;
  const pinHash = entrada.pinInicial ? await hashSenha(entrada.pinInicial) : null;

  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO usuario
         (casa_id, nome, email, perfil, registro_profissional, senha_hash, senha_trocar,
          pin_hash, pin_trocar, criado_em)
       VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        nome,
        entraPelaWeb ? (email ?? null) : null,
        entrada.perfil,
        entrada.registroProfissional?.trim() || null,
        senhaHash,
        senhaHash !== null,
        pinHash,
        pinHash !== null,
        agora,
      ],
    );
    const usuarioId = r.rows[0]?.id;
    if (!usuarioId) return { ok: false, motivo: "email_em_uso" } as const;

    await registrarAuditoria(c, {
      acao: "usuario.criado",
      entidade: "usuario",
      entidadeId: usuarioId,
      depois: { perfil: entrada.perfil, email: email ?? null, comPin: pinHash !== null },
      ip: entrada.ip,
    });
    return { ok: true, usuarioId } as const;
  });
}

async function ativosDeGestor(c: PoolClient): Promise<number> {
  const r = await c.query<{ total: string }>(
    "SELECT count(*)::text AS total FROM usuario WHERE perfil = 'gestor' AND ativo",
  );
  return Number(r.rows[0]?.total ?? 0);
}

export async function desativarUsuario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { usuarioId: string; ip?: string | null },
): Promise<{ ok: true } | Rejeicao> {
  const agora = exigirGestorConfirmado(servico, ator);
  if (entrada.usuarioId === ator.usuarioId) return { ok: false, motivo: "proprio_usuario" };

  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    // Trava os gestores ativos juntos para duas desativações simultâneas não zerarem a casa.
    await c.query("SELECT id FROM usuario WHERE perfil = 'gestor' AND ativo FOR UPDATE");
    const alvo = await carregarUsuarioTravado(c, entrada.usuarioId);
    if (!alvo) return { ok: false, motivo: "usuario_nao_encontrado" } as const;
    if (alvo.ativo && alvo.perfil === "gestor" && (await ativosDeGestor(c)) <= 1) {
      return { ok: false, motivo: "ultimo_gestor" } as const;
    }

    await c.query("UPDATE usuario SET ativo = false, desativado_em = $2 WHERE id = $1", [
      alvo.id,
      agora,
    ]);
    const sessoes = await revogarSessoesDoUsuario(c, alvo.id, agora);
    await registrarAuditoria(c, {
      acao: "usuario.desativado",
      entidade: "usuario",
      entidadeId: alvo.id,
      depois: { sessoesEncerradas: sessoes },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export async function reativarUsuario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { usuarioId: string; ip?: string | null },
): Promise<{ ok: true } | Rejeicao> {
  exigirGestorConfirmado(servico, ator);
  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const alvo = await carregarUsuarioTravado(c, entrada.usuarioId);
    if (!alvo) return { ok: false, motivo: "usuario_nao_encontrado" } as const;
    await c.query("UPDATE usuario SET ativo = true, desativado_em = NULL WHERE id = $1", [alvo.id]);
    await registrarAuditoria(c, {
      acao: "usuario.reativado",
      entidade: "usuario",
      entidadeId: alvo.id,
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export async function desbloquearUsuario(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { usuarioId: string; ip?: string | null },
): Promise<{ ok: true } | Rejeicao> {
  exigirGestorConfirmado(servico, ator);
  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const alvo = await carregarUsuarioTravado(c, entrada.usuarioId);
    if (!alvo) return { ok: false, motivo: "usuario_nao_encontrado" } as const;
    await c.query("UPDATE usuario SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1", [
      alvo.id,
    ]);
    await registrarAuditoria(c, {
      acao: "usuario.desbloqueado",
      entidade: "usuario",
      entidadeId: alvo.id,
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

type Credencial = "senha" | "pin";

/** Gestor define uma credencial provisória. A pessoa é obrigada a trocá-la no próximo acesso. */
async function redefinirCredencial(
  servico: Servico,
  ator: SessaoAutenticada,
  tipo: Credencial,
  entrada: { usuarioId: string; novoValor: string; ip?: string | null },
): Promise<{ ok: true } | Rejeicao> {
  const agora = exigirGestorConfirmado(servico, ator);

  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const alvo = await carregarUsuarioTravado(c, entrada.usuarioId);
    if (!alvo) return { ok: false, motivo: "usuario_nao_encontrado" } as const;

    const problemas =
      tipo === "senha"
        ? alvo.perfil === "cuidador"
          ? ["Cuidador não tem senha: ele entra só com PIN."]
          : validarSenha(entrada.novoValor, { email: alvo.email, nome: alvo.nome })
        : validarPin(entrada.novoValor);
    if (problemas.length > 0) return invalido(...problemas);

    const novoHash = await hashSenha(entrada.novoValor);
    if (tipo === "senha") {
      await c.query(
        `UPDATE usuario SET senha_hash = $2, senha_trocar = true,
                tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1`,
        [alvo.id, novoHash],
      );
    } else {
      await c.query(
        `UPDATE usuario SET pin_hash = $2, pin_trocar = true,
                tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1`,
        [alvo.id, novoHash],
      );
    }
    // Quem tinha a credencial antiga (ou a roubou) perde o acesso agora.
    const sessoes = await revogarSessoesDoUsuario(c, alvo.id, agora);
    await registrarAuditoria(c, {
      acao: tipo === "senha" ? "usuario.senha_redefinida" : "usuario.pin_redefinido",
      entidade: "usuario",
      entidadeId: alvo.id,
      depois: { sessoesEncerradas: sessoes },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export const redefinirSenha = (
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { usuarioId: string; novaSenha: string; ip?: string | null },
) =>
  redefinirCredencial(servico, ator, "senha", {
    usuarioId: entrada.usuarioId,
    novoValor: entrada.novaSenha,
    ip: entrada.ip,
  });

export const redefinirPin = (
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { usuarioId: string; novoPin: string; ip?: string | null },
) =>
  redefinirCredencial(servico, ator, "pin", {
    usuarioId: entrada.usuarioId,
    novoValor: entrada.novoPin,
    ip: entrada.ip,
  });

/** Celular perdido: apaga o autenticador. No próximo login a pessoa configura um novo. */
export async function redefinirSegundoFator(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { usuarioId: string; ip?: string | null },
): Promise<{ ok: true } | Rejeicao> {
  const agora = exigirGestorConfirmado(servico, ator);
  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const alvo = await carregarUsuarioTravado(c, entrada.usuarioId);
    if (!alvo) return { ok: false, motivo: "usuario_nao_encontrado" } as const;
    await c.query(
      `UPDATE usuario SET totp_ativo = false, totp_segredo_cifrado = NULL, totp_ultimo_passo = NULL
        WHERE id = $1`,
      [alvo.id],
    );
    await revogarSessoesDoUsuario(c, alvo.id, agora);
    await registrarAuditoria(c, {
      acao: "usuario.segundo_fator_redefinido",
      entidade: "usuario",
      entidadeId: alvo.id,
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

/** A própria pessoa troca a credencial confirmando a atual. Encerra as outras sessões dela. */
async function trocarMinhaCredencial(
  servico: Servico,
  ator: SessaoAutenticada,
  tipo: Credencial,
  entrada: { atual: string; novo: string; ip?: string | null },
): Promise<{ ok: true } | Rejeicao> {
  const agora = relogio(servico);

  return comContexto(servico.pool, contextoDo(ator), async (c) => {
    const u = await carregarUsuarioTravado(c, ator.usuarioId);
    const guardado = tipo === "senha" ? u?.senha_hash : u?.pin_hash;
    if (!u || !u.ativo || !guardado) {
      await gastarTempoDeVerificacao(entrada.atual);
      return { ok: false, motivo: "sem_credencial" } as const;
    }
    if (estaBloqueado(u, agora)) {
      await gastarTempoDeVerificacao(entrada.atual);
      return { ok: false, motivo: "credencial_atual_incorreta" } as const;
    }
    if (!(await verificarSenhaHash(guardado, entrada.atual))) {
      await registrarFalha(c, u, agora, "reautenticacao.falha", {
        ip: entrada.ip,
        dispositivoId: ator.dispositivoId,
      });
      return { ok: false, motivo: "credencial_atual_incorreta" } as const;
    }

    const problemas =
      tipo === "senha"
        ? validarSenha(entrada.novo, { email: u.email, nome: u.nome })
        : validarPin(entrada.novo);
    if (entrada.novo === entrada.atual)
      problemas.push("A nova credencial precisa ser diferente da atual.");
    if (problemas.length > 0) return invalido(...problemas);

    const novoHash = await hashSenha(entrada.novo);
    if (tipo === "senha") {
      await c.query("UPDATE usuario SET senha_hash = $2, senha_trocar = false WHERE id = $1", [
        u.id,
        novoHash,
      ]);
    } else {
      await c.query("UPDATE usuario SET pin_hash = $2, pin_trocar = false WHERE id = $1", [
        u.id,
        novoHash,
      ]);
    }
    const outras = await c.query(
      `UPDATE sessao SET revogada_em = $3
        WHERE usuario_id = $1 AND id <> $2 AND revogada_em IS NULL`,
      [u.id, ator.sessaoId, agora],
    );
    await registrarAuditoria(c, {
      acao: tipo === "senha" ? "usuario.senha_trocada" : "usuario.pin_trocado",
      entidade: "usuario",
      entidadeId: u.id,
      depois: { outrasSessoesEncerradas: outras.rowCount ?? 0 },
      dispositivoId: ator.dispositivoId,
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

export const trocarMinhaSenha = (
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { senhaAtual: string; novaSenha: string; ip?: string | null },
) =>
  trocarMinhaCredencial(servico, ator, "senha", {
    atual: entrada.senhaAtual,
    novo: entrada.novaSenha,
    ip: entrada.ip,
  });

export const trocarMeuPin = (
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { pinAtual: string; novoPin: string; ip?: string | null },
) =>
  trocarMinhaCredencial(servico, ator, "pin", {
    atual: entrada.pinAtual,
    novo: entrada.novoPin,
    ip: entrada.ip,
  });
