import type { Pool } from "pg";

/** Dependências de qualquer operação de negócio. O relógio é injetável para testar prazos. */
export type Servico = {
  pool: Pool;
  /** Chave AES-256 (base64) que protege campos sensíveis (telefone, CPF, segredos) no banco. */
  chaveCampos: string;
  agora?: () => Date;
};

export function relogio(servico: Servico): Date {
  return (servico.agora ?? (() => new Date()))();
}
