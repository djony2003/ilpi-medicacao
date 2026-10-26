import { describe, expect, it } from "vitest";
import {
  ACOES,
  ErroDePermissao,
  PERFIS,
  exigirPermissao,
  podeExecutar,
  type Acao,
  type Perfil,
} from "@/modules/identidade";

// A matriz abaixo é escrita à mão a partir da tabela da spec (seção 7.1), de forma independente
// da implementação. Se alguém mudar uma permissão, este teste obriga a mudar a spec também.
const ESPERADO: Record<Acao, Record<Perfil, boolean>> = {
  "escala.ver": { cuidador: true, enfermeiro: true, gestor: true },
  "administracao.registrar": { cuidador: true, enfermeiro: true, gestor: true },
  "administracao.segunda_validacao": { cuidador: true, enfermeiro: true, gestor: true },
  "prescricao.gerir": { cuidador: false, enfermeiro: true, gestor: true },
  "conferencia.liberar_excecao": { cuidador: false, enfermeiro: true, gestor: true },
  "estoque.gerir": { cuidador: false, enfermeiro: true, gestor: true },
  "idoso.gerir": { cuidador: false, enfermeiro: true, gestor: true },
  "usuarios.gerir": { cuidador: false, enfermeiro: false, gestor: true },
  "configuracoes.gerir": { cuidador: false, enfermeiro: false, gestor: true },
  "dispositivos.gerir": { cuidador: false, enfermeiro: false, gestor: true },
  "auditoria.ver": { cuidador: false, enfermeiro: false, gestor: true },
  "relatorio_excecoes.ver": { cuidador: false, enfermeiro: false, gestor: true },
};

describe("permissões por perfil", () => {
  it("a matriz esperada cobre exatamente as ações existentes (nenhuma ação sem teste)", () => {
    expect(Object.keys(ESPERADO).sort()).toEqual([...ACOES].sort());
  });

  describe.each(PERFIS)("perfil %s", (perfil) => {
    it.each(ACOES)("ação %s", (acao) => {
      expect(podeExecutar(perfil, acao)).toBe(ESPERADO[acao][perfil]);
    });
  });

  it("exigirPermissao não faz nada quando permitido e lança erro tipado quando negado", () => {
    expect(() => exigirPermissao("gestor", "auditoria.ver")).not.toThrow();
    expect(() => exigirPermissao("cuidador", "auditoria.ver")).toThrow(ErroDePermissao);
    try {
      exigirPermissao("enfermeiro", "usuarios.gerir");
      expect.unreachable();
    } catch (erro) {
      expect(erro).toBeInstanceOf(ErroDePermissao);
      expect((erro as ErroDePermissao).perfil).toBe("enfermeiro");
      expect((erro as ErroDePermissao).acao).toBe("usuarios.gerir");
    }
  });

  it("o gestor pode tudo o que o enfermeiro pode, e o enfermeiro tudo o que o cuidador pode", () => {
    for (const acao of ACOES) {
      if (podeExecutar("cuidador", acao)) expect(podeExecutar("enfermeiro", acao)).toBe(true);
      if (podeExecutar("enfermeiro", acao)) expect(podeExecutar("gestor", acao)).toBe(true);
    }
  });
});
