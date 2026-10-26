import type { PoolClient } from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { dadosInvalidos, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import { exigirPermissao, type SessaoAutenticada } from "@/modules/identidade";
import {
  compararParaEscala,
  estadoDaDose,
  janelaDaCasa,
  minutosDesde,
  type EstadoDaDose,
} from "../dominio/estado";

// Escala do plantão: o que o tablet mostra e o que a folha de contingência imprime. Só leitura
// (a folha, além disso, deixa um registro de que foi emitida).

const HORA_MS = 3_600_000;
export const JANELA_MAXIMA_DA_ESCALA_H = 48;
const LIMITE_DE_DOSES = 3000;

export type AlergiaNaEscala = { substancia: string; gravidade: "leve" | "moderada" | "grave" };

export type DoseDaEscala = {
  id: string;
  idosoId: string;
  idosoNome: string;
  quarto: string | null;
  alergias: AlergiaNaEscala[];
  medicamento: { nome: string; principioAtivo: string; concentracao: string | null };
  dose: number;
  unidade: string;
  via: string;
  instrucoes: string | null;
  altoRisco: boolean;
  /** AAAA-MM-DD e HH:MM no fuso da casa: é o que a equipe lê. */
  dataLocal: string;
  horaLocal: string;
  previstaEm: string;
  estado: EstadoDaDose;
  /** Minutos de atraso (positivo) ou de antecedência (negativo) em relação ao horário. */
  minutosDesdeOHorario: number;
};

export type EscalaDoPlantao = {
  agora: string;
  de: string;
  ate: string;
  fuso: string;
  janela: { janelaMin: number; limiteMaiorMin: number };
  /** Verdadeiro se havia mais doses do que o limite: a lista foi cortada nas mais antigas. */
  truncada: boolean;
  doses: DoseDaEscala[];
};

export type PeriodoDaEscala = { de?: Date; ate?: Date };

type LinhaDeDose = {
  id: string;
  idoso_id: string;
  idoso_nome: string;
  quarto: string | null;
  data_local: string;
  hora_local: string;
  prevista_em: Date;
  medicamento_nome: string;
  principio_ativo: string;
  concentracao: string | null;
  dose: string;
  unidade: string;
  via: string;
  instrucoes: string | null;
  alto_risco: boolean;
};

/** Período padrão: as últimas 12 horas (para ver o que ficou pendente) até as próximas 8. */
function periodo(
  agora: Date,
  p: PeriodoDaEscala,
  padrao: { antesH: number; depoisH: number },
): { de: Date; ate: Date } | null {
  const de = p.de ?? new Date(agora.getTime() - padrao.antesH * HORA_MS);
  const ate = p.ate ?? new Date(agora.getTime() + padrao.depoisH * HORA_MS);
  if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) return null;
  if (ate.getTime() <= de.getTime()) return null;
  if (ate.getTime() - de.getTime() > JANELA_MAXIMA_DA_ESCALA_H * HORA_MS) return null;
  return { de, ate };
}

async function carregar(
  c: PoolClient,
  agora: Date,
  intervalo: { de: Date; ate: Date },
): Promise<EscalaDoPlantao> {
  const casa = await c.query<{ fuso: string; configuracoes: unknown }>(
    "SELECT fuso_horario AS fuso, configuracoes FROM casa WHERE id = app_casa_id()",
  );
  const { fuso, configuracoes } = casa.rows[0] ?? { fuso: "America/Sao_Paulo", configuracoes: {} };
  const janela = janelaDaCasa(configuracoes);

  // Mais antigas primeiro no corte: se passar do limite, perde-se o que é mais antigo.
  const r = await c.query<LinhaDeDose>(
    `SELECT d.id, d.idoso_id, i.nome AS idoso_nome, i.quarto,
            d.data_local::text AS data_local, to_char(d.hora_local, 'HH24:MI') AS hora_local,
            d.prevista_em, m.nome_comercial AS medicamento_nome, m.principio_ativo,
            m.concentracao, p.dose::text AS dose, p.unidade::text AS unidade, p.via::text AS via,
            p.instrucoes, p.alto_risco
       FROM dose_agendada d
       JOIN prescricao p ON p.id = d.prescricao_id AND p.casa_id = d.casa_id
       JOIN medicamento m ON m.id = p.medicamento_id AND m.casa_id = p.casa_id
       JOIN idoso i ON i.id = d.idoso_id AND i.casa_id = d.casa_id
      WHERE d.cancelada_em IS NULL
        AND i.status = 'ativo'
        AND d.prevista_em >= $1 AND d.prevista_em < $2
      ORDER BY d.prevista_em DESC, d.id
      LIMIT ${LIMITE_DE_DOSES + 1}`,
    [intervalo.de, intervalo.ate],
  );
  const truncada = r.rows.length > LIMITE_DE_DOSES;
  const linhas = r.rows.slice(0, LIMITE_DE_DOSES).reverse();

  const idosos = [...new Set(linhas.map((l) => l.idoso_id))];
  const alergiasPorIdoso = new Map<string, AlergiaNaEscala[]>();
  if (idosos.length > 0) {
    const a = await c.query<{ idoso_id: string } & AlergiaNaEscala>(
      `SELECT idoso_id, substancia, gravidade FROM alergia
        WHERE idoso_id = ANY($1::uuid[]) AND ativa
        ORDER BY CASE gravidade WHEN 'grave' THEN 0 WHEN 'moderada' THEN 1 ELSE 2 END, substancia`,
      [idosos],
    );
    for (const l of a.rows) {
      const lista = alergiasPorIdoso.get(l.idoso_id) ?? [];
      lista.push({ substancia: l.substancia, gravidade: l.gravidade });
      alergiasPorIdoso.set(l.idoso_id, lista);
    }
  }

  const doses = linhas.map((l): DoseDaEscala => {
    // Registro de administração entra no M5: até lá nenhuma dose consta como feita.
    const estado = estadoDaDose(
      { previstaEm: l.prevista_em, cancelada: false, registrada: false },
      agora,
      janela,
    );
    return {
      id: l.id,
      idosoId: l.idoso_id,
      idosoNome: l.idoso_nome,
      quarto: l.quarto,
      alergias: alergiasPorIdoso.get(l.idoso_id) ?? [],
      medicamento: {
        nome: l.medicamento_nome,
        principioAtivo: l.principio_ativo,
        concentracao: l.concentracao,
      },
      dose: Number(l.dose),
      unidade: l.unidade,
      via: l.via,
      instrucoes: l.instrucoes,
      altoRisco: l.alto_risco,
      dataLocal: l.data_local,
      horaLocal: l.hora_local,
      previstaEm: l.prevista_em.toISOString(),
      estado,
      minutosDesdeOHorario: minutosDesde(l.prevista_em, agora),
    };
  });

  return {
    agora: agora.toISOString(),
    de: intervalo.de.toISOString(),
    ate: intervalo.ate.toISOString(),
    fuso,
    janela,
    truncada,
    doses,
  };
}

/** Escala do tablet: atrasadas no topo, depois a janela atual, depois o que vem. */
export async function escalaDoPlantao(
  servico: Servico,
  ator: SessaoAutenticada,
  p: PeriodoDaEscala = {},
): Promise<{ ok: true; escala: EscalaDoPlantao } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "escala.ver");
  const agora = relogio(servico);
  const intervalo = periodo(agora, p, { antesH: 12, depoisH: 8 });
  if (!intervalo) return dadosInvalidos("Período inválido: use no máximo 48 horas.");

  return comContexto(
    servico.pool,
    { casaId: ator.casaId, usuarioId: ator.usuarioId },
    async (c) => {
      const escala = await carregar(c, agora, intervalo);
      escala.doses.sort((a, b) =>
        compararParaEscala(
          { estado: a.estado, previstaEm: new Date(a.previstaEm) },
          { estado: b.estado, previstaEm: new Date(b.previstaEm) },
        ),
      );
      return { ok: true, escala } as const;
    },
  );
}

export type DadosDaFolha = {
  casaNome: string;
  emitidaEm: string;
  fuso: string;
  de: string;
  ate: string;
  truncada: boolean;
  /** Em ordem de horário, depois quarto e nome: é a ordem da ronda no papel. */
  doses: DoseDaEscala[];
};

/**
 * Dados da folha de contingência (a ser impressa quando o sistema estiver fora). Cada emissão
 * fica na trilha, com o período e a quantidade, sem nomes nem dados clínicos.
 */
export async function dadosDaFolhaDeContingencia(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: PeriodoDaEscala & { ip?: string | null } = {},
): Promise<{ ok: true; folha: DadosDaFolha } | Falha<"dados_invalidos">> {
  exigirPermissao(ator.perfil, "escala.ver");
  const agora = relogio(servico);
  // Padrão da folha: do início desta hora até 12 horas à frente.
  const inicioDaHora = new Date(Math.floor(agora.getTime() / HORA_MS) * HORA_MS);
  const intervalo = periodo(
    agora,
    { de: entrada.de ?? inicioDaHora, ate: entrada.ate },
    { antesH: 0, depoisH: 12 },
  );
  if (!intervalo) return dadosInvalidos("Período inválido: use no máximo 48 horas.");

  return comContexto(
    servico.pool,
    { casaId: ator.casaId, usuarioId: ator.usuarioId },
    async (c) => {
      const escala = await carregar(c, agora, intervalo);
      const casa = await c.query<{ nome: string }>(
        "SELECT nome FROM casa WHERE id = app_casa_id()",
      );
      escala.doses.sort(
        (a, b) =>
          a.previstaEm.localeCompare(b.previstaEm) ||
          (a.quarto ?? "").localeCompare(b.quarto ?? "", "pt-BR", { numeric: true }) ||
          a.idosoNome.localeCompare(b.idosoNome, "pt-BR") ||
          a.medicamento.nome.localeCompare(b.medicamento.nome, "pt-BR"),
      );
      await registrarAuditoria(c, {
        acao: "escala.folha_emitida",
        entidade: "casa",
        entidadeId: ator.casaId,
        depois: {
          de: escala.de,
          ate: escala.ate,
          doses: escala.doses.length,
          truncada: escala.truncada,
        },
        ip: entrada.ip ?? null,
      });
      return {
        ok: true,
        folha: {
          casaNome: casa.rows[0]?.nome ?? "",
          emitidaEm: escala.agora,
          fuso: escala.fuso,
          de: escala.de,
          ate: escala.ate,
          truncada: escala.truncada,
          doses: escala.doses,
        },
      } as const;
    },
  );
}
