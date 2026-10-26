import { diasEntre, somarDias } from "@/compartilhado/datas";
import { dataLocalDe, instanteLocal, type JanelaDaCasa } from "@/modules/administracao";
import type { ConfiguracaoDeAlertas } from "./configuracao";
import type { Condicao } from "./reconciliacao";

// Condições de alerta (spec 6.4), a partir de dados já carregados do banco. Funções puras.
// O título é para dentro do sistema (painel e tablet): pode ter nome de residente e de remédio.

const MIN = 60_000;

function dataBr(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

const emDias = (n: number) => (n === 0 ? "hoje" : n === 1 ? "amanhã" : `em ${n} dias`);

// ---------------------------------------------------------------------------------------- estoque

export type ReservaParaAlerta = {
  chave: string;
  medicamento: string;
  /** Estoque individual: de quem. Null = estoque comum. */
  idosoNome: string | null;
  diasRestantes: number | null;
  esgotaEm: string | null;
};

export function condicoesDeEstoque(
  reservas: ReservaParaAlerta[],
  config: ConfiguracaoDeAlertas,
): Condicao[] {
  const aviso = Math.max(config.estoqueAvisoDias, config.prazoReposicaoDias);
  const r: Condicao[] = [];
  for (const x of reservas) {
    if (x.diasRestantes === null || x.diasRestantes > aviso) continue;
    const urgente = x.diasRestantes <= config.estoqueUrgenteDias;
    const de = x.idosoNome ? ` de ${x.idosoNome}` : " (estoque comum)";
    r.push({
      chave: `estoque:${x.chave}`,
      tipo: "estoque_acabando",
      gravidade: urgente ? "urgente" : "aviso",
      destino: "enfermeiro",
      titulo:
        x.diasRestantes === 0
          ? `${x.medicamento}${de}: falta para a próxima dose hoje`
          : `${x.medicamento}${de} acaba ${emDias(x.diasRestantes)}`,
      detalhe: x.esgotaEm
        ? `Sem estoque a partir de ${dataBr(x.esgotaEm)}. Prazo de reposição informado: ${config.prazoReposicaoDias} dias.`
        : null,
      entidade: "estoque",
      entidadeId: null,
      informativo: false,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------------------- validade

export type LoteParaAlerta = {
  id: string;
  numeroLote: string;
  medicamento: string;
  validade: string;
  saldo: number;
  idosoNome: string | null;
};

export function condicoesDeValidade(
  lotes: LoteParaAlerta[],
  hoje: string,
  config: ConfiguracaoDeAlertas,
): Condicao[] {
  const r: Condicao[] = [];
  for (const l of lotes) {
    if (l.saldo <= 0) continue;
    const dias = diasEntre(hoje, l.validade);
    const de = l.idosoNome ? ` de ${l.idosoNome}` : "";
    if (dias < 0) {
      r.push({
        chave: `vencido:${l.id}`,
        tipo: "lote_vencido",
        gravidade: "urgente",
        destino: "enfermeiro",
        titulo: `Lote vencido em estoque: ${l.medicamento}${de}, lote ${l.numeroLote}`,
        detalhe: `Venceu em ${dataBr(l.validade)}. Separe o lote e registre o descarte.`,
        entidade: "lote_estoque",
        entidadeId: l.id,
        informativo: false,
      });
    } else if (dias <= config.validadeAvisoDias) {
      r.push({
        chave: `validade:${l.id}`,
        tipo: "validade_proxima",
        gravidade: dias <= config.validadeUrgenteDias ? "urgente" : "aviso",
        destino: "enfermeiro",
        titulo: `${l.medicamento}${de}, lote ${l.numeroLote}, vence ${emDias(dias)}`,
        detalhe: `Validade ${dataBr(l.validade)}. Use este lote primeiro ou planeje o descarte.`,
        entidade: "lote_estoque",
        entidadeId: l.id,
        informativo: false,
      });
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------- doses

export type DoseParaAlerta = {
  id: string;
  idosoNome: string;
  medicamento: string;
  horaLocal: string;
  /** O horário que vale: o previsto, ou o novo se a dose foi adiada. */
  referencia: Date;
};

/** Primeiro fim de plantão depois do horário da dose. */
export function fimDoPlantao(referencia: Date, fuso: string, fins: string[]): Date {
  const dia = dataLocalDe(referencia, fuso);
  const candidatos = [dia, somarDias(dia, 1)]
    .flatMap((d) => fins.map((h) => instanteLocal(d, h, fuso)))
    .filter((t) => t.getTime() > referencia.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return candidatos[0] ?? new Date(referencia.getTime() + 12 * 60 * MIN);
}

export function condicoesDeDoses(
  doses: DoseParaAlerta[],
  agora: Date,
  janela: JanelaDaCasa,
  fuso: string,
  config: ConfiguracaoDeAlertas,
): Condicao[] {
  const r: Condicao[] = [];
  for (const d of doses) {
    const atraso = Math.floor((agora.getTime() - d.referencia.getTime()) / MIN);
    if (atraso <= janela.janelaMin) continue;
    const quem = `${d.idosoNome}, ${d.medicamento} das ${d.horaLocal}`;
    if (atraso <= janela.limiteMaiorMin) {
      r.push({
        chave: `dose_atrasada:${d.id}`,
        tipo: "dose_atrasada",
        gravidade: "aviso",
        destino: "enfermeiro",
        titulo: `Dose atrasada: ${quem}`,
        detalhe: `Passou da janela de ${janela.janelaMin} minutos e ainda não foi registrada.`,
        entidade: "dose_agendada",
        entidadeId: d.id,
        informativo: false,
      });
      continue;
    }
    // Sem registro: nunca se presume que foi dada. No fim do plantão, vai para o gestor.
    const fim = fimDoPlantao(d.referencia, fuso, config.fimDosPlantoes);
    const plantaoAcabou = agora.getTime() >= fim.getTime();
    r.push({
      chave: `dose_sem_registro:${d.id}`,
      tipo: "dose_sem_registro",
      gravidade: "urgente",
      destino: plantaoAcabou ? "gestor" : "enfermeiro",
      titulo: `Dose sem registro: ${quem}`,
      detalhe: plantaoAcabou
        ? "O plantão terminou sem registro. Confira com a equipe e lance como registro tardio, se foi dada."
        : "Mais de 2 horas sem registro. Confira se foi dada e lance como registro tardio.",
      entidade: "dose_agendada",
      entidadeId: d.id,
      informativo: false,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------------------- prescrição

export type PrescricaoParaAlerta = {
  id: string;
  idosoNome: string;
  medicamento: string;
  fim: string;
};

export function condicoesDePrescricoes(
  prescricoes: PrescricaoParaAlerta[],
  hoje: string,
  config: ConfiguracaoDeAlertas,
): Condicao[] {
  const r: Condicao[] = [];
  for (const p of prescricoes) {
    const dias = diasEntre(hoje, p.fim);
    if (dias < 0 || dias > config.prescricaoAvisoDias) continue;
    r.push({
      chave: `prescricao:${p.id}`,
      tipo: "prescricao_vencendo",
      gravidade: dias === 0 ? "urgente" : "aviso",
      destino: "enfermeiro",
      titulo: `Prescrição de ${p.medicamento} para ${p.idosoNome} termina ${emDias(dias)}`,
      detalhe: `Último dia: ${dataBr(p.fim)}. Renove com o médico ou confirme o fim do tratamento.`,
      entidade: "prescricao",
      entidadeId: p.id,
      informativo: false,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------------------- exceções e SOS

export function condicoesDeExcecoes(
  ontem: { data: string; total: number },
  porUsuario: Array<{ usuarioId: string; nome: string; total: number }>,
  config: ConfiguracaoDeAlertas,
): Condicao[] {
  const r: Condicao[] = [];
  if (ontem.total > 0) {
    r.push({
      chave: `excecoes_dia:${ontem.data}`,
      tipo: "excecoes_do_dia",
      gravidade: "aviso",
      destino: "gestor",
      titulo: `${ontem.total} ${ontem.total === 1 ? "exceção" : "exceções"} de conferência em ${dataBr(ontem.data)}`,
      detalhe: "Registros feitos sem a leitura da etiqueta, liberados pela enfermagem.",
      entidade: null,
      entidadeId: null,
      informativo: true,
    });
  }
  for (const u of porUsuario) {
    if (u.total < config.excecoesRepetidas) continue;
    r.push({
      chave: `excecoes_usuario:${u.usuarioId}`,
      tipo: "excecoes_repetidas",
      gravidade: "urgente",
      destino: "gestor",
      titulo: `${u.nome}: ${u.total} exceções de conferência em 7 dias`,
      detalhe: "Exceções repetidas pela mesma pessoa: verifique etiquetas, leitor e treinamento.",
      entidade: "usuario",
      entidadeId: u.usuarioId,
      informativo: false,
    });
  }
  return r;
}

export type SosBloqueado = {
  prescricaoId: string;
  idosoNome: string;
  medicamento: string;
  /** Dia (fuso da casa) do bloqueio: um alerta por prescrição por dia. */
  data: string;
  vezes: number;
};

export function condicoesDeSos(bloqueios: SosBloqueado[]): Condicao[] {
  return bloqueios.map((b) => ({
    chave: `sos:${b.prescricaoId}:${b.data}`,
    tipo: "sos_bloqueado" as const,
    gravidade: "aviso" as const,
    destino: "enfermeiro" as const,
    titulo: `${b.idosoNome} pediu ${b.medicamento} "se necessário" além do limite`,
    detalhe: `Bloqueado ${b.vezes === 1 ? "1 vez" : `${b.vezes} vezes`} em ${dataBr(b.data)}. Avalie o paciente.`,
    entidade: "prescricao",
    entidadeId: b.prescricaoId,
    informativo: true,
  }));
}
