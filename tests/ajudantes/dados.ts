import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hash } from "@node-rs/argon2";
import { comContexto } from "@/compartilhado/banco/transacao";

// Criação de dados de teste. Usa o papel dono do schema, que também é limitado pelo RLS (FORCE),
// por isso cada inserção acontece dentro do contexto da casa certa.

export const SENHA_PADRAO = "senha-forte-de-teste-123";

export async function criarCasa(migrador: pg.Pool, nome = "Casa de Teste"): Promise<string> {
  const id = randomUUID();
  await comContexto(migrador, { casaId: id }, (c) =>
    c.query("INSERT INTO casa (id, nome) VALUES ($1, $2)", [id, nome]),
  );
  return id;
}

export type UsuarioDeTeste = {
  id: string;
  casaId: string;
  email: string | null;
  perfil: "gestor" | "enfermeiro" | "cuidador";
  nome: string;
};

export async function criarUsuario(
  migrador: pg.Pool,
  casaId: string,
  opcoes: {
    perfil: UsuarioDeTeste["perfil"];
    nome?: string;
    senha?: string | null;
    totpSegredoCifrado?: string | null;
    totpAtivo?: boolean;
    pin?: string | null;
    pinTrocar?: boolean;
  },
): Promise<UsuarioDeTeste> {
  const id = randomUUID();
  const nome = opcoes.nome ?? `Usuário ${id.slice(0, 6)}`;
  const email = opcoes.perfil === "cuidador" ? null : `u-${id}@exemplo.test`;
  // Cuidador entra só por PIN; os demais perfis nascem com a senha padrão de teste.
  const senha =
    opcoes.senha === undefined
      ? opcoes.perfil === "cuidador"
        ? null
        : SENHA_PADRAO
      : opcoes.senha;
  const senhaHash = senha === null ? null : await hash(senha);
  const pinHash = opcoes.pin ? await hash(opcoes.pin) : null;

  await comContexto(migrador, { casaId }, (c) =>
    c.query(
      `INSERT INTO usuario
         (id, casa_id, nome, email, perfil, senha_hash, totp_segredo_cifrado, totp_ativo,
          pin_hash, pin_trocar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        casaId,
        nome,
        email,
        opcoes.perfil,
        senhaHash,
        opcoes.totpSegredoCifrado ?? null,
        opcoes.totpAtivo ?? false,
        pinHash,
        opcoes.pinTrocar ?? false,
      ],
    ),
  );
  return { id, casaId, email, perfil: opcoes.perfil, nome };
}
