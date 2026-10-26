import { POLITICA } from "./politica";

// Ações sensíveis (aprovar ou revogar aparelho, trocar credenciais, desbloquear usuário) exigem
// que a pessoa tenha digitado a senha (web) ou o PIN (tablet) de novo há pouco tempo. Isso limita
// o estrago de uma tela deixada aberta ou de uma sessão roubada.

export class ErroDeReautenticacao extends Error {
  constructor() {
    super("Confirme sua senha ou PIN para continuar.");
    this.name = "ErroDeReautenticacao";
  }
}

export function reautenticadoRecentemente(reautenticadoEm: Date | null, agora: Date): boolean {
  if (reautenticadoEm === null) return false;
  const decorrido = agora.getTime() - reautenticadoEm.getTime();
  return decorrido >= 0 && decorrido < POLITICA.reautenticacaoMs;
}

export function exigirReautenticacaoRecente(reautenticadoEm: Date | null, agora: Date): void {
  if (!reautenticadoRecentemente(reautenticadoEm, agora)) throw new ErroDeReautenticacao();
}
