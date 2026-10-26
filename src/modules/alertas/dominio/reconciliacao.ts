import type { ConfiguracaoDeAlertas } from "./configuracao";

// Reconciliação dos alertas (spec 6.4, "para evitar ruído"). Função pura: recebe as condições
// que valem agora e os alertas abertos, e devolve o que fazer. Regras:
//  - um alerta por condição (a chave);
//  - condição nova abre; condição que piorou agrava (e avisa de novo); que melhorou, abranda
//    sem avisar; que sumiu, fecha sozinha. Informativos (resumo de exceções, SOS bloqueado) não
//    fecham por sumir: fecham quando alguém lê;
//  - quem já tratou não é incomodado de novo: condição fechada à mão (ou lida) nos últimos 7 dias
//    não reabre, a não ser que tenha piorado desde então;
//  - aberto e não lido: reaviso a cada N horas (urgente mais curto que aviso);
//  - urgente para a enfermagem, não lido em N horas: escala para o gestor. Condição que já nasce
//    endereçada ao gestor (dose sem registro no fim do plantão) também escala.

export type TipoDeAlerta =
  | "estoque_acabando"
  | "validade_proxima"
  | "lote_vencido"
  | "dose_atrasada"
  | "dose_sem_registro"
  | "prescricao_vencendo"
  | "excecoes_do_dia"
  | "excecoes_repetidas"
  | "sos_bloqueado";

export type Gravidade = "aviso" | "urgente";
export type Destino = "enfermeiro" | "gestor";

export type Condicao = {
  chave: string;
  tipo: TipoDeAlerta;
  gravidade: Gravidade;
  destino: Destino;
  titulo: string;
  detalhe: string | null;
  entidade: string | null;
  entidadeId: string | null;
  /** Fecha ao ser lido, não ao sumir. */
  informativo: boolean;
};

export type AlertaAberto = {
  id: string;
  chave: string;
  gravidade: Gravidade;
  destino: Destino;
  titulo: string;
  detalhe: string | null;
  informativo: boolean;
  abertoEm: Date;
  gravidadeDesde: Date;
  notificadoEm: Date | null;
  escaladoEm: Date | null;
  /** Alguém já leu. */
  lido: boolean;
};

/** Alerta fechado por uma pessoa (manual ou leitura) recentemente: não reabre igual. */
export type Tratado = { chave: string; gravidade: Gravidade };

export type Plano = {
  abrir: Condicao[];
  /** Ficou urgente: muda a gravidade e avisa de novo. */
  agravar: Array<{ id: string; condicao: Condicao }>;
  /** Ficou menos grave, ou o texto mudou (ex.: "acaba em 3 dias" → "em 2 dias"): só atualiza. */
  atualizar: Array<{ id: string; condicao: Condicao }>;
  resolver: string[];
  reavisar: string[];
  escalar: string[];
};

const HORA_MS = 3_600_000;
const peso = (g: Gravidade) => (g === "urgente" ? 2 : 1);

export function reconciliar(
  condicoes: Condicao[],
  abertos: AlertaAberto[],
  tratados: Tratado[],
  agora: Date,
  config: ConfiguracaoDeAlertas,
): Plano {
  const plano: Plano = {
    abrir: [],
    agravar: [],
    atualizar: [],
    resolver: [],
    reavisar: [],
    escalar: [],
  };
  const atuais = new Map<string, Condicao>();
  for (const c of condicoes) {
    const ja = atuais.get(c.chave);
    // Duas leituras da mesma condição: vale a mais grave.
    if (!ja || peso(c.gravidade) > peso(ja.gravidade)) atuais.set(c.chave, c);
  }
  const tratadosPorChave = new Map<string, Gravidade>();
  for (const t of tratados) {
    const ja = tratadosPorChave.get(t.chave);
    if (!ja || peso(t.gravidade) > peso(ja)) tratadosPorChave.set(t.chave, t.gravidade);
  }
  const abertosPorChave = new Map(abertos.map((a) => [a.chave, a]));

  for (const [chave, c] of atuais) {
    if (abertosPorChave.has(chave)) continue;
    const tratada = tratadosPorChave.get(chave);
    if (tratada !== undefined && peso(c.gravidade) <= peso(tratada)) continue;
    plano.abrir.push(c);
  }

  for (const a of abertos) {
    const c = atuais.get(a.chave);
    if (!c) {
      if (!a.informativo) plano.resolver.push(a.id);
      continue;
    }
    if (peso(c.gravidade) > peso(a.gravidade)) {
      plano.agravar.push({ id: a.id, condicao: c });
      continue; // o agravamento já notifica; reaviso e escalonamento contam a partir dele
    }
    if (c.gravidade !== a.gravidade || c.titulo !== a.titulo || c.detalhe !== a.detalhe) {
      plano.atualizar.push({ id: a.id, condicao: c });
    }

    const jaEscalado = a.escaladoEm !== null || a.destino === "gestor";
    const pedeGestor = c.destino === "gestor" && a.destino !== "gestor";
    const urgenteEsquecido =
      a.gravidade === "urgente" &&
      !a.lido &&
      agora.getTime() - a.gravidadeDesde.getTime() >= config.escalonamentoHoras * HORA_MS;
    if (!jaEscalado && (pedeGestor || urgenteEsquecido)) {
      plano.escalar.push(a.id);
      continue;
    }

    const intervalo =
      (a.gravidade === "urgente" ? config.reavisoUrgenteHoras : config.reavisoAvisoHoras) * HORA_MS;
    const ultimo = (a.notificadoEm ?? a.abertoEm).getTime();
    if (!a.lido && !a.informativo && agora.getTime() - ultimo >= intervalo)
      plano.reavisar.push(a.id);
  }
  return plano;
}

/** Quem recebe e-mail por este motivo. Avisos só vão por e-mail se a casa pedir. */
export function deveEnviarEmail(
  gravidade: Gravidade,
  motivo: "novo" | "agravado" | "reaviso" | "escalonamento",
  config: ConfiguracaoDeAlertas,
): boolean {
  if (motivo === "escalonamento" || motivo === "agravado") return true;
  return gravidade === "urgente" || config.emailParaAvisos;
}
