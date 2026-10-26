import { createHash } from "node:crypto";
import { comContexto } from "@/compartilhado/banco/transacao";
import { cifrarBytes, decifrarBytes } from "@/compartilhado/criptografia";
import { falha, type Falha } from "@/compartilhado/resultado";
import type { Servico } from "@/compartilhado/servico";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";

// Foto ou PDF da receita médica: o comprovante de que a prescrição foi transcrita de uma receita.
//
// - O arquivo é cifrado pela aplicação (AES-256-GCM, vinculado à chave do objeto) ANTES de ir para
//   o armazenamento privado; o banco guarda só a referência, o tamanho e o hash do original.
// - O tipo vem do CONTEÚDO (primeiros bytes), nunca do que o navegador declarou.
// - Nenhum link público: ler a receita passa pela API, com sessão, permissão e registro na trilha.

export const TAMANHO_MAXIMO_RECEITA = 10 * 1024 * 1024;

export type TipoDeReceita = "image/jpeg" | "image/png" | "application/pdf";

export function detectarTipoDeReceita(b: Uint8Array): TipoDeReceita | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  ) {
    return "image/png";
  }
  if (b.length >= 5 && Buffer.from(b.subarray(0, 5)).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

function armazenamentoDe(servico: Servico) {
  if (!servico.armazenamento) throw new Error("Armazenamento de arquivos não configurado.");
  return servico.armazenamento;
}

export type ReceitaDaPrescricao = {
  id: string;
  prescricaoId: string;
  versao: number;
  tipoMime: TipoDeReceita;
  tamanhoBytes: number;
  enviadaEm: string;
};

export async function anexarReceita(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { prescricaoId: string; bytes: Uint8Array; ip?: string | null },
): Promise<
  | { ok: true; receitaId: string; tipoMime: TipoDeReceita; tamanhoBytes: number }
  | Falha<"nao_encontrado" | "arquivo_invalido" | "arquivo_grande_demais">
> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const armazenamento = armazenamentoDe(servico);
  if (entrada.bytes.length === 0) return falha("arquivo_invalido");
  if (entrada.bytes.length > TAMANHO_MAXIMO_RECEITA) return falha("arquivo_grande_demais");
  const tipo = detectarTipoDeReceita(entrada.bytes);
  if (!tipo) return falha("arquivo_invalido");

  const sha256 = createHash("sha256").update(entrada.bytes).digest("hex");
  let gravada: string | null = null;
  try {
    return await comContexto(servico.pool, contexto(ator), async (c) => {
      const existe = await c.query("SELECT 1 FROM prescricao WHERE id = $1", [
        entrada.prescricaoId,
      ]);
      if (existe.rowCount !== 1) return falha("nao_encontrado");

      const chave = `casas/${ator.casaId}/receitas/${gerarCodigoOpaco().toLowerCase()}${gerarCodigoOpaco().toLowerCase()}`;
      const r = await c.query<{ id: string }>(
        `INSERT INTO receita_prescricao
           (casa_id, prescricao_id, chave, tipo_mime, tamanho_bytes, sha256, enviado_por)
         VALUES (app_casa_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
        [entrada.prescricaoId, chave, tipo, entrada.bytes.length, sha256, ator.usuarioId],
      );
      const id = r.rows[0]?.id ?? "";
      // Grava dentro da transação: se o armazenamento falhar, a linha do banco é desfeita.
      await armazenamento.gravar(chave, cifrarBytes(entrada.bytes, servico.chaveCampos, chave));
      gravada = chave;
      await registrarAuditoria(c, {
        acao: "receita.anexada",
        entidade: "receita_prescricao",
        entidadeId: id,
        depois: {
          prescricaoId: entrada.prescricaoId,
          tipoMime: tipo,
          tamanhoBytes: entrada.bytes.length,
        },
        ip: entrada.ip,
      });
      return {
        ok: true,
        receitaId: id,
        tipoMime: tipo,
        tamanhoBytes: entrada.bytes.length,
      } as const;
    });
  } catch (erro) {
    // O banco desfez a linha; o objeto já gravado ficaria órfão, então apaga.
    if (gravada) await armazenamento.apagar(gravada).catch(() => undefined);
    throw erro;
  }
}

/** Receitas da prescrição e de todas as versões do mesmo grupo (a receita vale para o histórico). */
export async function listarReceitas(
  servico: Servico,
  ator: SessaoAutenticada,
  prescricaoId: string,
): Promise<ReceitaDaPrescricao[]> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{
      id: string;
      prescricao_id: string;
      versao: number;
      tipo_mime: TipoDeReceita;
      tamanho_bytes: number;
      enviado_em: Date;
    }>(
      `SELECT rp.id, rp.prescricao_id, p.versao, rp.tipo_mime, rp.tamanho_bytes, rp.enviado_em
         FROM receita_prescricao rp
         JOIN prescricao p ON p.id = rp.prescricao_id
        WHERE p.grupo_id = (SELECT grupo_id FROM prescricao WHERE id = $1)
        ORDER BY rp.enviado_em DESC`,
      [prescricaoId],
    );
    return r.rows.map((l) => ({
      id: l.id,
      prescricaoId: l.prescricao_id,
      versao: l.versao,
      tipoMime: l.tipo_mime,
      tamanhoBytes: l.tamanho_bytes,
      enviadaEm: l.enviado_em.toISOString(),
    }));
  });
}

/** Devolve o arquivo original. Cada leitura fica registrada na trilha de auditoria. */
export async function lerReceita(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { prescricaoId: string; receitaId: string; ip?: string | null },
): Promise<{ ok: true; bytes: Buffer; tipoMime: TipoDeReceita } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const armazenamento = armazenamentoDe(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ chave: string; tipo_mime: TipoDeReceita; sha256: string }>(
      `SELECT rp.chave, rp.tipo_mime, rp.sha256
         FROM receita_prescricao rp
         JOIN prescricao p ON p.id = rp.prescricao_id
        WHERE rp.id = $2
          AND p.grupo_id = (SELECT grupo_id FROM prescricao WHERE id = $1)`,
      [entrada.prescricaoId, entrada.receitaId],
    );
    const l = r.rows[0];
    if (!l) return falha("nao_encontrado");
    const guardado = await armazenamento.ler(l.chave);
    if (!guardado) throw new Error("Arquivo da receita ausente no armazenamento.");
    const bytes = decifrarBytes(guardado, servico.chaveCampos, l.chave);
    if (createHash("sha256").update(bytes).digest("hex") !== l.sha256) {
      throw new Error("Arquivo da receita não confere com o registro (integridade).");
    }
    await registrarAuditoria(c, {
      acao: "receita.lida",
      entidade: "receita_prescricao",
      entidadeId: entrada.receitaId,
      depois: { prescricaoId: entrada.prescricaoId },
      ip: entrada.ip,
    });
    return { ok: true, bytes, tipoMime: l.tipo_mime } as const;
  });
}
