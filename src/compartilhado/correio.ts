import nodemailer from "nodemailer";

// Envio de e-mail. A aplicação só conhece esta interface; o provedor (SMTP de um serviço
// transacional, a definir com a casa-piloto) entra por configuração.

export type Mensagem = { para: string; assunto: string; texto: string };

export type Correio = {
  enviar(m: Mensagem): Promise<void>;
};

/** Para testes: guarda o que seria enviado; pode simular falhas. */
export class CorreioEmMemoria implements Correio {
  readonly enviadas: Mensagem[] = [];
  falharProximas = 0;
  async enviar(m: Mensagem): Promise<void> {
    if (this.falharProximas > 0) {
      this.falharProximas -= 1;
      throw new Error("falha simulada do servidor de e-mail");
    }
    this.enviadas.push(m);
  }
}

/**
 * SMTP a partir de uma URL (smtps://usuario:senha@servidor:465). Prazos curtos: o envio acontece
 * dentro da rodada do agendador, e um servidor lento não pode segurar os alertas das outras casas.
 */
export function correioSmtp(url: string, remetente: string): Correio {
  const u = new URL(url);
  const transporte = nodemailer.createTransport({
    host: u.hostname,
    port: Number(u.port || (u.protocol === "smtps:" ? 465 : 587)),
    secure: u.protocol === "smtps:",
    requireTLS: u.protocol !== "smtps:",
    auth: u.username
      ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async enviar(m) {
      await transporte.sendMail({ from: remetente, to: m.para, subject: m.assunto, text: m.texto });
    },
  };
}
