import type { PoolClient } from "pg";

export type ProblemaDeCadeia = {
  seq: number;
  problema: "inicio_ausente" | "lacuna" | "encadeamento_quebrado" | "conteudo_adulterado";
};

/**
 * Confere a cadeia de hashes da casa do contexto atual.
 * Devolve null se está íntegra, ou a primeira linha com problema.
 */
export async function verificarCadeiaDeAuditoria(
  cliente: PoolClient,
): Promise<ProblemaDeCadeia | null> {
  const { rows } = await cliente.query<{ seq_com_problema: string; problema: string }>(
    "SELECT seq_com_problema, problema FROM auditoria_verificar()",
  );
  const linha = rows[0];
  if (!linha) return null;
  return {
    seq: Number(linha.seq_com_problema),
    problema: linha.problema as ProblemaDeCadeia["problema"],
  };
}
