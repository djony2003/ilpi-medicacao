// E-mail de alerta (spec 6.5 e 7.7): só diz que há um alerta e onde ver. Nunca leva nome de
// residente, remédio, dose, alergia ou qualquer dado de saúde, nem o título do alerta: e-mail
// passa por servidores de terceiros e fica guardado em caixas que a casa não controla.

export type EmailDeAlerta = { assunto: string; texto: string };

const MOTIVO = {
  novo: "Há um novo alerta",
  agravado: "Um alerta ficou urgente",
  reaviso: "Há um alerta ainda não lido",
  escalonamento: "Um alerta urgente não foi lido a tempo e foi encaminhado a você",
} as const;

export function montarEmail(e: {
  motivo: keyof typeof MOTIVO;
  gravidade: "aviso" | "urgente";
  casaNome: string;
  nomeDestinatario: string;
  linkDoPainel: string;
}): EmailDeAlerta {
  const urgente = e.gravidade === "urgente";
  const assunto = `${urgente ? "[Urgente] " : ""}Alerta no ILPI Medicação: ${e.casaNome}`;
  const texto = [
    `Olá, ${e.nomeDestinatario}.`,
    "",
    `${MOTIVO[e.motivo]} na ${e.casaNome}${urgente ? ", marcado como urgente" : ""}.`,
    "Por segurança, os detalhes não vão por e-mail. Entre no sistema para ver e tratar:",
    e.linkDoPainel,
    "",
    "Você recebe esta mensagem porque faz parte da equipe de enfermagem ou da gestão da casa.",
  ].join("\n");
  return { assunto, texto };
}
