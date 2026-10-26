import { comBusca } from "@/compartilhado/banco/busca";
import { comContexto } from "@/compartilhado/banco/transacao";
import {
  gerarCodigoDeAtivacao,
  gerarToken,
  hashDeToken,
  normalizarCodigoDeAtivacao,
} from "@/compartilhado/tokens";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao } from "../dominio/permissoes";
import { POLITICA } from "../dominio/politica";
import { exigirReautenticacaoRecente } from "../dominio/reautenticacao";
import { relogio, type Servico } from "./servico";
import type { SessaoAutenticada } from "./sessao";

// Aparelhos (o tablet do posto de enfermagem).
//
// Um tablet só funciona depois que um gestor o aprova: o gestor gera um código de uso único e de
// curta duração, digita-o no tablet, e o tablet recebe um token próprio de longa duração. Sem esse
// token, o PIN não abre nada. Se o tablet some, o gestor revoga e ele para na hora.

const TAMANHO_CODIGO = 10;

export type CodigoDeAtivacao = {
  dispositivoId: string;
  /** O código aparece só aqui. No banco fica apenas o hash. */
  codigo: string;
  expiraEm: Date;
};

export async function criarDispositivo(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { nome: string; ip?: string | null },
): Promise<CodigoDeAtivacao> {
  exigirPermissao(ator.perfil, "dispositivos.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);

  const nome = entrada.nome.trim();
  if (nome.length === 0 || nome.length > 80) {
    throw new Error("O nome do aparelho precisa ter entre 1 e 80 caracteres.");
  }

  const codigo = gerarCodigoDeAtivacao(TAMANHO_CODIGO);
  const expiraEm = new Date(agora.getTime() + POLITICA.codigoDeAtivacaoMs);

  return comContexto(
    servico.pool,
    { casaId: ator.casaId, usuarioId: ator.usuarioId },
    async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO dispositivo (casa_id, nome, codigo_ativacao_hash, codigo_expira_em, criado_por, criado_em)
         VALUES (app_casa_id(), $1, $2, $3, $4, $5)
         RETURNING id`,
        [nome, hashDeToken(codigo), expiraEm, ator.usuarioId, agora],
      );
      const dispositivoId = r.rows[0]?.id;
      if (!dispositivoId) throw new Error("Não foi possível criar o aparelho.");
      await registrarAuditoria(c, {
        acao: "dispositivo.criado",
        entidade: "dispositivo",
        entidadeId: dispositivoId,
        depois: { nome },
        ip: entrada.ip,
      });
      return { dispositivoId, codigo, expiraEm };
    },
  );
}

export type ResultadoDaAtivacao =
  | { ok: true; token: string; dispositivoId: string; nome: string }
  | { ok: false; motivo: "codigo_invalido" };

const CODIGO_INVALIDO = { ok: false, motivo: "codigo_invalido" } as const;

/** Roda no tablet: troca o código de uso único pelo token do aparelho. */
export async function ativarDispositivo(
  servico: Servico,
  entrada: { codigo: string; ip?: string | null },
): Promise<ResultadoDaAtivacao> {
  const codigo = normalizarCodigoDeAtivacao(entrada.codigo);
  if (codigo.length !== TAMANHO_CODIGO) return CODIGO_INVALIDO;

  const hashDoCodigo = hashDeToken(codigo);
  const agora = relogio(servico);

  const achado = await comBusca(servico.pool, "ativacao_hash", hashDoCodigo, async (c) => {
    const r = await c.query<{ id: string; casa_id: string; nome: string }>(
      `SELECT id, casa_id, nome FROM dispositivo
        WHERE codigo_ativacao_hash = $1
          AND ativado_em IS NULL AND revogado_em IS NULL
          AND codigo_expira_em > $2`,
      [hashDoCodigo, agora],
    );
    return r.rows[0] ?? null;
  });
  if (!achado) return CODIGO_INVALIDO;

  const token = gerarToken();
  return comContexto(servico.pool, { casaId: achado.casa_id }, async (c) => {
    // A condição no WHERE garante uso único mesmo se dois tablets digitarem o código juntos.
    const r = await c.query(
      `UPDATE dispositivo
          SET token_hash = $2, ativado_em = $3, ultimo_uso_em = $3,
              codigo_ativacao_hash = NULL, codigo_expira_em = NULL
        WHERE id = $1 AND ativado_em IS NULL AND revogado_em IS NULL
          AND codigo_ativacao_hash IS NOT NULL AND codigo_expira_em > $3`,
      [achado.id, hashDeToken(token), agora],
    );
    if (r.rowCount !== 1) return CODIGO_INVALIDO;
    await registrarAuditoria(c, {
      acao: "dispositivo.ativado",
      entidade: "dispositivo",
      entidadeId: achado.id,
      dispositivoId: achado.id,
      ip: entrada.ip,
    });
    return { ok: true, token, dispositivoId: achado.id, nome: achado.nome } as const;
  });
}

export type DispositivoAtivo = { id: string; casaId: string; nome: string };

/** Valida o token do aparelho. Devolve null se for desconhecido, não ativado ou revogado. */
export async function localizarDispositivo(
  servico: Servico,
  token: string,
): Promise<DispositivoAtivo | null> {
  if (token.length === 0 || token.length > 200) return null;
  const hashDoToken = hashDeToken(token);
  return comBusca(servico.pool, "dispositivo_hash", hashDoToken, async (c) => {
    const r = await c.query<{ id: string; casa_id: string; nome: string }>(
      `SELECT id, casa_id, nome FROM dispositivo
        WHERE token_hash = $1 AND ativado_em IS NOT NULL AND revogado_em IS NULL`,
      [hashDoToken],
    );
    const linha = r.rows[0];
    return linha ? { id: linha.id, casaId: linha.casa_id, nome: linha.nome } : null;
  });
}

export type ResumoDeDispositivo = {
  id: string;
  nome: string;
  situacao: "aguardando_ativacao" | "ativo" | "revogado";
  ultimoUsoEm: Date | null;
  criadoEm: Date;
};

export async function listarDispositivos(
  servico: Servico,
  ator: SessaoAutenticada,
): Promise<ResumoDeDispositivo[]> {
  exigirPermissao(ator.perfil, "dispositivos.gerir");
  return comContexto(
    servico.pool,
    { casaId: ator.casaId, usuarioId: ator.usuarioId },
    async (c) => {
      const r = await c.query<{
        id: string;
        nome: string;
        ativado_em: Date | null;
        revogado_em: Date | null;
        ultimo_uso_em: Date | null;
        criado_em: Date;
      }>(
        `SELECT id, nome, ativado_em, revogado_em, ultimo_uso_em, criado_em
           FROM dispositivo ORDER BY criado_em DESC`,
      );
      return r.rows.map((l) => ({
        id: l.id,
        nome: l.nome,
        situacao: l.revogado_em ? "revogado" : l.ativado_em ? "ativo" : "aguardando_ativacao",
        ultimoUsoEm: l.ultimo_uso_em,
        criadoEm: l.criado_em,
      }));
    },
  );
}

/** Revoga o aparelho e encerra na hora as sessões abertas nele. Devolve false se já estava revogado. */
export async function revogarDispositivo(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { dispositivoId: string; ip?: string | null },
): Promise<boolean> {
  exigirPermissao(ator.perfil, "dispositivos.gerir");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);

  return comContexto(
    servico.pool,
    { casaId: ator.casaId, usuarioId: ator.usuarioId },
    async (c) => {
      const r = await c.query(
        `UPDATE dispositivo
            SET revogado_em = $2, token_hash = NULL, codigo_ativacao_hash = NULL
          WHERE id = $1 AND revogado_em IS NULL`,
        [entrada.dispositivoId, agora],
      );
      if (r.rowCount !== 1) return false;
      const sessoes = await c.query(
        "UPDATE sessao SET revogada_em = $2 WHERE dispositivo_id = $1 AND revogada_em IS NULL",
        [entrada.dispositivoId, agora],
      );
      await registrarAuditoria(c, {
        acao: "dispositivo.revogado",
        entidade: "dispositivo",
        entidadeId: entrada.dispositivoId,
        depois: { sessoesEncerradas: sessoes.rowCount ?? 0 },
        ip: entrada.ip,
      });
      return true;
    },
  );
}
