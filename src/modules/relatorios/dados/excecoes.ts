import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";
import { hojeNoFuso, problemasDoPeriodo, somarDias } from "../dominio/periodo";

// Relatório de exceções de conferência (spec 6.3 e 7.1): as vezes em que a etiqueta não pôde ser
// lida e uma pessoa da enfermagem liberou a dose mesmo assim. Serve para a gestão ver se a
// exceção virou rotina (etiqueta ruim, pessoa que libera demais, residente com mais casos).

const contexto = (ator: SessaoAutenticada) => ({ casaId: ator.casaId, usuarioId: ator.usuarioId });

export const ROTULOS_DE_EXCECAO = {
  etiqueta_ilegivel: "Etiqueta ilegível",
  etiqueta_danificada: "Etiqueta danificada",
} as const;

export type ItemDeExcecao = {
  administracaoId: string;
  ocorridaEm: string;
  idosoNome: string;
  medicamento: string;
  resultado: string;
  motivo: keyof typeof ROTULOS_DE_EXCECAO;
  justificativa: string;
  registradoPor: string;
  liberadoPor: string;
};

export type RelatorioDeExcecoes = {
  casaNome: string;
  fuso: string;
  emitidoEm: string;
  de: string;
  ate: string;
  /** Doses com registro de administração no período (para dar a proporção). */
  totalDeRegistros: number;
  total: number;
  porMotivo: Array<{ motivo: keyof typeof ROTULOS_DE_EXCECAO; quantidade: number }>;
  porLiberador: Array<{ nome: string; quantidade: number }>;
  porResidente: Array<{ nome: string; quantidade: number }>;
  itens: ItemDeExcecao[];
};

export async function relatorioDeExcecoes(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: {
    de?: string;
    ate?: string;
    /** Quando é para levar o relatório para fora (PDF ou planilha): pede a senha e deixa rastro. */
    exportacao?: { formato: "pdf" | "csv"; ip?: string | null };
  } = {},
): Promise<{ ok: true; relatorio: RelatorioDeExcecoes } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "relatorio_excecoes.ver");
  const agora = relogio(servico);
  if (entrada.exportacao) exigirReautenticacaoRecente(ator.reautenticadoEm, agora);
  return comContexto(servico.pool, contexto(ator), async (c) => {
    const casa = await c.query<{ nome: string; fuso: string }>(
      "SELECT nome, fuso_horario AS fuso FROM casa WHERE id = app_casa_id()",
    );
    const fuso = casa.rows[0]?.fuso ?? "America/Sao_Paulo";
    const ate = entrada.ate ?? hojeNoFuso(agora, fuso);
    const de = entrada.de ?? somarDias(ate, -29);
    const problemas = problemasDoPeriodo(de, ate);
    if (problemas.length > 0) return dadosInvalidos(...problemas);

    const intervalo = `a.ocorrida_em >= ($1::date)::timestamp AT TIME ZONE $3
                   AND a.ocorrida_em < (($2::date + 1)::timestamp AT TIME ZONE $3)`;
    const itens = await c.query<{
      administracao_id: string;
      ocorrida_em: Date;
      idoso_nome: string;
      medicamento: string;
      resultado: string;
      motivo: keyof typeof ROTULOS_DE_EXCECAO;
      justificativa: string;
      registrado_por: string;
      liberado_por: string;
    }>(
      `SELECT a.id AS administracao_id, a.ocorrida_em, i.nome AS idoso_nome,
              m.nome_comercial AS medicamento, a.resultado::text AS resultado,
              e.motivo, e.justificativa, ur.nome AS registrado_por, ul.nome AS liberado_por
         FROM excecao_conferencia e
         JOIN administracao a ON a.id = e.administracao_id AND a.casa_id = e.casa_id
         JOIN idoso i ON i.id = a.idoso_id AND i.casa_id = a.casa_id
         JOIN prescricao p ON p.id = a.prescricao_id AND p.casa_id = a.casa_id
         JOIN medicamento m ON m.id = p.medicamento_id AND m.casa_id = p.casa_id
         JOIN usuario ur ON ur.id = a.usuario_id
         JOIN usuario ul ON ul.id = e.liberada_por
        WHERE ${intervalo}
        ORDER BY a.ocorrida_em DESC, a.id
        LIMIT 5000`,
      [de, ate, fuso],
    );
    const registros = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM administracao a WHERE ${intervalo}`,
      [de, ate, fuso],
    );
    const contar = <T>(chave: (i: (typeof itens.rows)[number]) => T) => {
      const m = new Map<T, number>();
      for (const i of itens.rows) m.set(chave(i), (m.get(chave(i)) ?? 0) + 1);
      return [...m.entries()].sort((x, y) => y[1] - x[1]);
    };
    if (entrada.exportacao) {
      await registrarAuditoria(c, {
        acao: "relatorio.excecoes_exportado",
        entidade: "relatorio",
        depois: { formato: entrada.exportacao.formato, de, ate, linhas: itens.rows.length },
        ip: entrada.exportacao.ip,
      });
    }
    return {
      ok: true,
      relatorio: {
        casaNome: casa.rows[0]?.nome ?? "",
        fuso,
        emitidoEm: agora.toISOString(),
        de,
        ate,
        totalDeRegistros: Number(registros.rows[0]?.n ?? 0),
        total: itens.rows.length,
        porMotivo: contar((i) => i.motivo).map(([motivo, quantidade]) => ({ motivo, quantidade })),
        porLiberador: contar((i) => i.liberado_por).map(([nome, quantidade]) => ({
          nome,
          quantidade,
        })),
        porResidente: contar((i) => i.idoso_nome).map(([nome, quantidade]) => ({
          nome,
          quantidade,
        })),
        itens: itens.rows.map((i) => ({
          administracaoId: i.administracao_id,
          ocorridaEm: i.ocorrida_em.toISOString(),
          idosoNome: i.idoso_nome,
          medicamento: i.medicamento,
          resultado: i.resultado,
          motivo: i.motivo,
          justificativa: i.justificativa,
          registradoPor: i.registrado_por,
          liberadoPor: i.liberado_por,
        })),
      },
    } as const;
  });
}
