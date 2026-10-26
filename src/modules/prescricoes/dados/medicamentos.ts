import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import { sugerirAltoRisco } from "../dominio/alto-risco";
import { FORMAS, type Forma } from "../dominio/tipos";

// Catálogo de medicamentos da casa. O princípio ativo é o que a conferência de alergia compara;
// "alto risco" aqui é a política da casa para o medicamento e vira o padrão das prescrições.

function contexto(ator: SessaoAutenticada) {
  return { casaId: ator.casaId, usuarioId: ator.usuarioId };
}

export type NovoMedicamento = {
  nomeComercial: string;
  principioAtivo: string;
  concentracao?: string | null;
  forma: Forma;
  /** Ausente: o sistema sugere pelo princípio ativo (lista de alta vigilância). */
  altoRisco?: boolean;
};

export type MedicamentoDoCatalogo = {
  id: string;
  nomeComercial: string;
  principioAtivo: string;
  concentracao: string | null;
  forma: Forma;
  altoRisco: boolean;
  ativo: boolean;
};

type Linha = {
  id: string;
  nome_comercial: string;
  principio_ativo: string;
  concentracao: string | null;
  forma: Forma;
  alto_risco_padrao: boolean;
  ativo: boolean;
};

export const COLUNAS_MEDICAMENTO =
  "id, nome_comercial, principio_ativo, concentracao, forma, alto_risco_padrao, ativo";

export function medicamentoDe(l: Linha): MedicamentoDoCatalogo {
  return {
    id: l.id,
    nomeComercial: l.nome_comercial,
    principioAtivo: l.principio_ativo,
    concentracao: l.concentracao,
    forma: l.forma,
    altoRisco: l.alto_risco_padrao,
    ativo: l.ativo,
  };
}

function validarMedicamento(m: NovoMedicamento): string[] {
  const p: string[] = [];
  const nome = m.nomeComercial.trim();
  const principio = m.principioAtivo.trim();
  if (nome.length < 2 || nome.length > 200)
    p.push("O nome do medicamento deve ter entre 2 e 200 caracteres.");
  if (principio.length < 2 || principio.length > 200) {
    p.push("O princípio ativo deve ter entre 2 e 200 caracteres.");
  }
  const conc = m.concentracao?.trim();
  if (conc !== undefined && conc.length > 60)
    p.push("A concentração pode ter no máximo 60 caracteres.");
  if (!FORMAS.includes(m.forma)) p.push("Forma farmacêutica desconhecida.");
  return p;
}

export async function cadastrarMedicamento(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: NovoMedicamento & { ip?: string | null },
): Promise<
  | { ok: true; medicamentoId: string; altoRisco: boolean }
  | Falha<"dados_invalidos" | "ja_cadastrado">
> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const problemas = validarMedicamento(entrada);
  if (problemas.length > 0) return dadosInvalidos(...problemas);
  const altoRisco = entrada.altoRisco ?? sugerirAltoRisco(entrada.principioAtivo);

  try {
    return await comContexto(servico.pool, contexto(ator), async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO medicamento
           (casa_id, nome_comercial, principio_ativo, concentracao, forma, alto_risco_padrao, criado_por)
         VALUES (app_casa_id(), btrim($1), btrim($2), nullif(btrim($3), ''), $4, $5, $6)
         RETURNING id`,
        [
          entrada.nomeComercial,
          entrada.principioAtivo,
          entrada.concentracao ?? "",
          entrada.forma,
          altoRisco,
          ator.usuarioId,
        ],
      );
      const id = r.rows[0]?.id ?? "";
      await registrarAuditoria(c, {
        acao: "medicamento.cadastrado",
        entidade: "medicamento",
        entidadeId: id,
        depois: { forma: entrada.forma, altoRisco },
        ip: entrada.ip,
      });
      return { ok: true, medicamentoId: id, altoRisco } as const;
    });
  } catch (erro) {
    // O índice único é a garantia final contra duplicata, inclusive entre dois cadastros simultâneos.
    const e = erro as { code?: string; constraint?: string };
    if (e.code === "23505" && e.constraint === "medicamento_unico") return falha("ja_cadastrado");
    throw erro;
  }
}

export async function listarMedicamentos(
  servico: Servico,
  ator: SessaoAutenticada,
  filtro: { incluirInativos?: boolean } = {},
): Promise<MedicamentoDoCatalogo[]> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<Linha>(
      `SELECT ${COLUNAS_MEDICAMENTO} FROM medicamento
        WHERE ($1::boolean OR ativo)
        ORDER BY lower(nome_comercial), lower(coalesce(concentracao, ''))`,
      [filtro.incluirInativos ?? false],
    );
    return r.rows.map(medicamentoDe);
  });
}

/** Muda a política de alto risco do medicamento. Vale para as prescrições novas; as antigas não mudam. */
export async function definirAltoRiscoDoMedicamento(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { medicamentoId: string; altoRisco: boolean; ip?: string | null },
): Promise<{ ok: true } | Falha<"nao_encontrado" | "sem_mudanca">> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query<{ alto_risco_padrao: boolean }>(
      "SELECT alto_risco_padrao FROM medicamento WHERE id = $1 FOR UPDATE",
      [entrada.medicamentoId],
    );
    const atual = r.rows[0]?.alto_risco_padrao;
    if (atual === undefined) return falha("nao_encontrado");
    if (atual === entrada.altoRisco) return falha("sem_mudanca");
    await c.query("UPDATE medicamento SET alto_risco_padrao = $2 WHERE id = $1", [
      entrada.medicamentoId,
      entrada.altoRisco,
    ]);
    await registrarAuditoria(c, {
      acao: "medicamento.alto_risco_alterado",
      entidade: "medicamento",
      entidadeId: entrada.medicamentoId,
      antes: { altoRisco: atual },
      depois: { altoRisco: entrada.altoRisco },
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}

/** Tira do catálogo. Recusa se ainda houver prescrição ativa com ele: primeiro encerra-se a prescrição. */
export async function desativarMedicamento(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { medicamentoId: string; ip?: string | null },
): Promise<{ ok: true } | Falha<"nao_encontrado" | "em_uso">> {
  exigirPermissao(ator.perfil, "prescricao.gerir");
  const agora = relogio(servico);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const r = await c.query("SELECT 1 FROM medicamento WHERE id = $1 AND ativo FOR UPDATE", [
      entrada.medicamentoId,
    ]);
    if (r.rowCount !== 1) return falha("nao_encontrado");
    const uso = await c.query(
      "SELECT 1 FROM prescricao WHERE medicamento_id = $1 AND status = 'ativa' LIMIT 1",
      [entrada.medicamentoId],
    );
    if (uso.rowCount === 1) return falha("em_uso");
    await c.query("UPDATE medicamento SET ativo = false, desativado_em = $2 WHERE id = $1", [
      entrada.medicamentoId,
      agora,
    ]);
    await registrarAuditoria(c, {
      acao: "medicamento.desativado",
      entidade: "medicamento",
      entidadeId: entrada.medicamentoId,
      ip: entrada.ip,
    });
    return { ok: true } as const;
  });
}
