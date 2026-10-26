import { hash, verify } from "@node-rs/argon2";

// Argon2id (o padrão da biblioteca) com os parâmetros mínimos recomendados pela OWASP:
// 19 MiB de memória, 2 iterações, 1 de paralelismo. Serve para senha e para PIN.
const PARAMETROS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashSenha(segredo: string): Promise<string> {
  return hash(segredo, PARAMETROS);
}

/** Nunca lança: hash malformado conta como senha errada. */
export async function verificarSenhaHash(guardado: string, segredo: string): Promise<boolean> {
  try {
    return await verify(guardado, segredo);
  } catch {
    return false;
  }
}

let hashFalso: Promise<string> | undefined;

/**
 * Gasta o mesmo tempo de uma verificação real. Usada quando o e-mail não existe, para o tempo da
 * resposta não revelar quais e-mails têm conta.
 */
export async function gastarTempoDeVerificacao(segredo: string): Promise<void> {
  hashFalso ??= hashSenha("valor-falso-apenas-para-igualar-o-tempo");
  await verificarSenhaHash(await hashFalso, segredo);
}
