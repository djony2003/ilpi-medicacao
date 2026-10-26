import { describe, expect, it } from "vitest";
import { acharSegredo } from "@/modules/auditoria";

describe("detecção de segredos na auditoria", () => {
  it.each([
    [{ senha: "x" }, "senha"],
    [{ senha_hash: "$argon2id$..." }, "senha_hash"],
    [{ pinHash: "abc" }, "pinHash"],
    [{ PIN: "123456" }, "PIN"],
    [{ token_hash: "abc" }, "token_hash"],
    [{ totp_segredo_cifrado: "v1:..." }, "totp_segredo_cifrado"],
    [{ externo: { interno: { password: "x" } } }, "externo.interno.password"],
    [{ lista: [{ cookie: "a=b" }] }, "lista[0].cookie"],
  ])("recusa %j", (valor, caminho) => {
    expect(acharSegredo(valor)).toBe(caminho);
  });

  it.each([
    [{ pin_trocar: true }],
    [{ totp_ativo: false }],
    [{ senha_hash: null }],
    [{ perfil: "gestor", ativo: true, nome_do_campo: "dose" }],
    [{ medicamento: "Losartana", dose: "50 mg" }],
    [{ tokens_emitidos: 0 }],
    [null],
    ["texto solto"],
    [42],
  ])("aceita %j", (valor) => {
    expect(acharSegredo(valor)).toBeNull();
  });
});
