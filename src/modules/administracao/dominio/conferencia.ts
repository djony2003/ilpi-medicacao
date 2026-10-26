import { emMilesimos, loteVencido } from "@/modules/estoque";
import {
  conflitosComAlergia,
  type AlergiaParaConferir,
  type ConflitoDeAlergia,
} from "@/modules/prescricoes";
import { classificarRegistro, type JanelaDaCasa } from "./estado";
import { horaLocalDe } from "./tempo";

// Conferência da dose à beira do leito (spec 5.3 e 5.4). Função pura: recebe tudo já carregado
// do banco e devolve os bloqueios, do mais grave para o mais leve, com a mensagem que o tablet
// mostra. O servidor roda esta mesma função na consulta (para a tela) e de novo dentro da
// transação que grava (para valer), então a tela nunca decide sozinha.
//
// Nenhum bloqueio tem exceção. A exceção de conferência (spec 5.5) só substitui a LEITURA da
// etiqueta pelo lote escolhido à mão: o lote escolhido passa pelas mesmas regras.

export type ResultadoDaAdministracao = "administrada" | "recusada" | "nao_administrada" | "adiada";
export const RESULTADOS: readonly ResultadoDaAdministracao[] = [
  "administrada",
  "recusada",
  "nao_administrada",
  "adiada",
];

export type CodigoDeBloqueio =
  | "dose_ja_registrada"
  | "pulseira_invalida"
  | "pulseira_desconhecida"
  | "pulseira_substituida"
  | "pulseira_de_outro_idoso"
  | "prescricao_encerrada"
  | "alergia"
  | "etiqueta_invalida"
  | "etiqueta_desconhecida"
  | "medicamento_errado"
  | "lote_de_outro_idoso"
  | "lote_vencido"
  | "unidade_diferente"
  | "saldo_insuficiente"
  | "horario_antecipado"
  | "horario_expirado";

export type Bloqueio = {
  codigo: CodigoDeBloqueio;
  /** Frase curta para a tela, como na tabela 5.4. */
  mensagem: string;
  /** O que a pessoa pode fazer. */
  acao: string;
  /** Só a antecipação além do limite pode ser liberada (pelo enfermeiro, com o PIN). */
  liberavel?: true;
};

const B: Record<CodigoDeBloqueio, { mensagem: string; acao: string }> = {
  dose_ja_registrada: { mensagem: "Dose já registrada", acao: "Nenhuma." },
  pulseira_invalida: {
    mensagem: "Este código não é de uma pulseira",
    acao: "Leia a pulseira do paciente.",
  },
  pulseira_desconhecida: {
    mensagem: "Pulseira não encontrada nesta casa",
    acao: "Confira a pulseira ou chame o enfermeiro.",
  },
  pulseira_substituida: {
    mensagem: "Esta pulseira foi substituída",
    acao: "Use a pulseira nova do paciente e avise o enfermeiro.",
  },
  pulseira_de_outro_idoso: {
    mensagem: "Esta pulseira é de outro paciente",
    acao: "Tente com o paciente certo.",
  },
  prescricao_encerrada: {
    mensagem: "Prescrição não está mais vigente",
    acao: "Chame o enfermeiro.",
  },
  alergia: {
    mensagem: "Alerta: alergia registrada",
    acao: "Não dê o remédio. O enfermeiro avalia.",
  },
  etiqueta_invalida: {
    mensagem: "Este código não é de uma etiqueta de medicamento",
    acao: "Leia a etiqueta da embalagem.",
  },
  etiqueta_desconhecida: {
    mensagem: "Etiqueta não encontrada no estoque desta casa",
    acao: "Procure o medicamento correto ou chame o enfermeiro.",
  },
  medicamento_errado: {
    mensagem: "Este medicamento não está prescrito para este horário",
    acao: "Procure o correto ou chame o enfermeiro.",
  },
  lote_de_outro_idoso: {
    mensagem: "Este lote é do estoque de outro paciente",
    acao: "Use o estoque deste paciente ou o estoque comum.",
  },
  lote_vencido: { mensagem: "Lote vencido", acao: "Separe o lote e avise o enfermeiro." },
  unidade_diferente: {
    mensagem: "A unidade do lote é diferente da prescrita",
    acao: "Chame o enfermeiro.",
  },
  saldo_insuficiente: {
    mensagem: "Saldo do lote não confere",
    acao: "O enfermeiro faz o ajuste com justificativa.",
  },
  horario_antecipado: {
    mensagem: "Ainda é cedo para esta dose",
    acao: "Aguarde o horário. Só o enfermeiro libera antes.",
  },
  horario_expirado: {
    mensagem: "Passou do limite de horário desta dose",
    acao: "Avise o enfermeiro: a dose entra como registro tardio.",
  },
};

function bloqueio(codigo: CodigoDeBloqueio, complemento?: string): Bloqueio {
  const base = B[codigo];
  return {
    codigo,
    mensagem: complemento ? `${base.mensagem}: ${complemento}` : base.mensagem,
    acao: base.acao,
    ...(codigo === "horario_antecipado" ? { liberavel: true as const } : {}),
  };
}

export type LeituraDaPulseira =
  { situacao: "lida"; idosoId: string } | { situacao: "invalida" | "desconhecida" | "substituida" };

export type LoteParaConferir = {
  id: string;
  medicamentoId: string;
  /** Estoque individual: de quem é. Null = estoque comum. */
  idosoId: string | null;
  validade: string;
  unidade: string;
  saldo: number;
};

export type LeituraDoLote =
  { situacao: "lida"; lote: LoteParaConferir } | { situacao: "invalida" | "desconhecida" };

export type PrescricaoParaConferir = {
  status: "ativa" | "encerrada" | "substituida";
  medicamentoId: string;
  principioAtivo: string;
  nomeComercial: string;
  dose: number;
  unidade: string;
  alergiasConfirmadas: readonly string[];
};

export type RegistroAnterior = { usuarioNome: string; ocorridaEm: Date };

export type EntradaDaConferencia = {
  /** Idoso a quem a dose pertence. */
  idosoId: string;
  prescricao: PrescricaoParaConferir;
  alergias: AlergiaParaConferir[];
  /** Resultado final já gravado para esta dose, se houver. */
  registroFinal: RegistroAnterior | null;
  /** Null: não exigida (não administrada pode ser registrada sem o paciente presente). */
  pulseira: LeituraDaPulseira | null;
  /** Null: ainda não lida (ou resultado que não usa remédio). */
  lote: LeituraDoLote | null;
  resultado: ResultadoDaAdministracao;
  /** AAAA-MM-DD no fuso da casa, para a validade do lote. */
  hoje: string;
  fuso: string;
};

export type ResultadoDaConferencia = {
  bloqueios: Bloqueio[];
  /** Alergias que coincidem mas foram confirmadas por quem prescreveu: avisam, não bloqueiam. */
  alergiasConfirmadas: ConflitoDeAlergia[];
};

function dataBr(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** O resultado usa o remédio (e por isso passa pela conferência de alergia e de lote)? */
export function usaMedicamento(r: ResultadoDaAdministracao): boolean {
  return r === "administrada" || r === "adiada";
}

export function conferirDose(e: EntradaDaConferencia): ResultadoDaConferencia {
  const bloqueios: Bloqueio[] = [];
  const alergiasConfirmadas: ConflitoDeAlergia[] = [];

  if (e.registroFinal) {
    const hora = horaLocalDe(e.registroFinal.ocorridaEm, e.fuso);
    bloqueios.push(bloqueio("dose_ja_registrada", `por ${e.registroFinal.usuarioNome} às ${hora}`));
    return { bloqueios, alergiasConfirmadas };
  }

  const p = e.pulseira;
  if (p) {
    if (p.situacao === "lida") {
      if (p.idosoId !== e.idosoId) bloqueios.push(bloqueio("pulseira_de_outro_idoso"));
    } else {
      bloqueios.push(bloqueio(`pulseira_${p.situacao}`));
    }
  }

  if (e.prescricao.status !== "ativa") bloqueios.push(bloqueio("prescricao_encerrada"));

  if (usaMedicamento(e.resultado)) {
    const conflitos = conflitosComAlergia(
      { principioAtivo: e.prescricao.principioAtivo, nomeComercial: e.prescricao.nomeComercial },
      e.alergias,
    );
    const confirmadas = new Set(e.prescricao.alergiasConfirmadas);
    const novos = conflitos.filter((c) => !confirmadas.has(c.alergiaId));
    alergiasConfirmadas.push(...conflitos.filter((c) => confirmadas.has(c.alergiaId)));
    if (novos.length > 0) {
      bloqueios.push(
        bloqueio("alergia", novos.map((c) => `${c.substancia} (${c.gravidade})`).join(", ")),
      );
    }
  }

  const leitura = e.lote;
  if (e.resultado === "administrada" && leitura) {
    if (leitura.situacao !== "lida") bloqueios.push(bloqueio(`etiqueta_${leitura.situacao}`));
    else {
      const l = leitura.lote;
      if (l.medicamentoId !== e.prescricao.medicamentoId) {
        bloqueios.push(bloqueio("medicamento_errado"));
      } else {
        // Remédio certo: o resto do lote só importa se for o remédio certo.
        if (l.idosoId !== null && l.idosoId !== e.idosoId) {
          bloqueios.push(bloqueio("lote_de_outro_idoso"));
        }
        if (loteVencido(l.validade, e.hoje)) {
          bloqueios.push(bloqueio("lote_vencido", `venceu em ${dataBr(l.validade)}`));
        }
        if (l.unidade !== e.prescricao.unidade) {
          bloqueios.push(
            bloqueio(
              "unidade_diferente",
              `lote em ${l.unidade}, prescrição em ${e.prescricao.unidade}`,
            ),
          );
        } else if (emMilesimos(l.saldo) < emMilesimos(e.prescricao.dose)) {
          bloqueios.push(bloqueio("saldo_insuficiente"));
        }
      }
    }
  }

  return { bloqueios, alergiasConfirmadas };
}

export type RegraDeHorario =
  | { tipo: "livre" }
  | { tipo: "exige_motivo"; sentido: "atrasado" | "adiantado" }
  | { tipo: "bloqueio"; bloqueio: Bloqueio };

/**
 * Regra de horário do registro (spec 5.2), a partir da referência da dose (o horário previsto,
 * ou o novo horário se ela foi adiada).
 */
export function regraDeHorario(
  referencia: Date,
  agora: Date,
  janela: JanelaDaCasa,
): RegraDeHorario {
  const c = classificarRegistro(referencia, agora, janela);
  if (c.regra === "normal") return { tipo: "livre" };
  if (c.regra === "exige_motivo") return { tipo: "exige_motivo", sentido: c.sentido };
  if (c.regra === "bloqueado")
    return { tipo: "bloqueio", bloqueio: bloqueio("horario_antecipado") };
  return { tipo: "bloqueio", bloqueio: bloqueio("horario_expirado") };
}

const MIN = 60_000;

/**
 * Novo horário de uma dose adiada: depois de agora e, no máximo, até o limite maior contado do
 * horário original. Adiar não pode empurrar a dose para depois do ponto em que ela viraria
 * "sem registro".
 */
export function problemaNoAdiamento(
  novo: Date,
  prevista: Date,
  agora: Date,
  janela: JanelaDaCasa,
): string | null {
  if (Number.isNaN(novo.getTime())) return "Informe o novo horário.";
  if (novo.getTime() <= agora.getTime()) return "O novo horário precisa ser depois de agora.";
  if (novo.getTime() > prevista.getTime() + janela.limiteMaiorMin * MIN) {
    return `A dose só pode ser adiada até ${janela.limiteMaiorMin} minutos depois do horário previsto.`;
  }
  return null;
}
