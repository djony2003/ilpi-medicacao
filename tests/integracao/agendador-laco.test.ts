import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executarUmaRodada, rodarAgendador, type Registro } from "@/agendador/laco";
import { criarPoolAgendador } from "../ajudantes/banco";

let agendador: pg.Pool;

beforeAll(() => {
  agendador = criarPoolAgendador(2);
});
afterAll(async () => {
  await agendador.end();
});

function coletor() {
  const linhas: { nivel: string; mensagem: string; dados?: object }[] = [];
  const registrar: Registro = (nivel, mensagem, dados) => linhas.push({ nivel, mensagem, dados });
  return { linhas, registrar };
}

describe("laço do agendador", () => {
  it("uma rodada com banco saudável registra o resumo", async () => {
    const { linhas, registrar } = coletor();
    const r = await executarUmaRodada({ pool: agendador }, registrar);
    expect(r).not.toBeNull();
    expect(linhas.at(-1)).toMatchObject({ mensagem: "rodada concluída" });
  });

  it("falha geral (banco fora do ar) é registrada sem derrubar o processo e sem vazar a mensagem", async () => {
    const quebrado = {
      query: () => Promise.reject(new Error("senha=segredo host=interno")),
    } as unknown as pg.Pool;
    const { linhas, registrar } = coletor();
    expect(await executarUmaRodada({ pool: quebrado }, registrar)).toBeNull();
    expect(linhas.at(-1)).toMatchObject({ nivel: "error", mensagem: "rodada falhou" });
    expect(JSON.stringify(linhas)).not.toContain("segredo");
  });

  it("para ao receber o sinal de encerramento, mesmo durante a espera", async () => {
    const { registrar } = coletor();
    const controle = new AbortController();
    const rodando = rodarAgendador({
      servico: { pool: agendador },
      registrar,
      intervaloMs: 60 * 60_000,
      sinal: controle.signal,
    });
    setTimeout(() => controle.abort(), 150);
    await expect(rodando).resolves.toBeUndefined();
  });

  it("repete a rodada no intervalo configurado", async () => {
    const { linhas, registrar } = coletor();
    const controle = new AbortController();
    const rodando = rodarAgendador({
      servico: { pool: agendador },
      registrar,
      intervaloMs: 40,
      sinal: controle.signal,
    });
    // Cada rodada percorre todas as casas do banco de teste, e o tempo dela cresce com os outros
    // testes rodando em paralelo: espera as 3 rodadas (com prazo), em vez de um tempo fixo.
    const rodadas = () => linhas.filter((l) => l.mensagem === "rodada concluída").length;
    const prazo = Date.now() + 10_000;
    while (rodadas() < 3 && Date.now() < prazo) await new Promise((r) => setTimeout(r, 20));
    controle.abort();
    await rodando;
    expect(rodadas()).toBeGreaterThanOrEqual(3);
  });
});
