import { describe, expect, it } from "vitest";
import { codigoLegivel, extrairCodigo, lerPayloadQr, montarPayloadQr } from "@/compartilhado/qr";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import {
  cpfValido,
  dataValida,
  formatarTelefone,
  idadeEmAnos,
  mascararCpf,
  mascararTelefone,
  normalizarTelefone,
  validarAlergia,
  validarContato,
  validarIdoso,
} from "@/modules/idosos";

const HOJE = new Date("2026-03-10T12:00:00Z");

describe("datas", () => {
  it("aceita só datas que existem de verdade, com ano bissexto", () => {
    expect(dataValida("1940-02-29")).toBe(true);
    expect(dataValida("1900-02-29")).toBe(false); // 1900 não foi bissexto
    expect(dataValida("1941-02-29")).toBe(false);
    expect(dataValida("1944-02-29")).toBe(true);
    expect(dataValida("1950-04-31")).toBe(false);
    expect(dataValida("1950-13-01")).toBe(false);
    expect(dataValida("50-01-01")).toBe(false);
    expect(dataValida("1950/01/01")).toBe(false);
    expect(dataValida("")).toBe(false);
  });

  it("calcula a idade considerando o aniversário", () => {
    expect(idadeEmAnos("1940-03-10", HOJE)).toBe(86);
    expect(idadeEmAnos("1940-03-11", HOJE)).toBe(85);
    expect(idadeEmAnos("1940-04-01", HOJE)).toBe(85);
    expect(idadeEmAnos("2026-12-01", HOJE)).toBe(-1);
  });
});

describe("CPF", () => {
  it("aceita CPFs com dígitos verificadores corretos, com ou sem pontuação", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
    expect(cpfValido("111.444.777-35")).toBe(true);
  });

  it("recusa dígito errado, tamanho errado e sequências repetidas", () => {
    expect(cpfValido("529.982.247-26")).toBe(false);
    expect(cpfValido("123.456.789-00")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cpfValido("5299822472")).toBe(false);
    expect(cpfValido("")).toBe(false);
    expect(cpfValido("abc")).toBe(false);
  });

  it("mascara mostrando só os dois últimos dígitos", () => {
    expect(mascararCpf("52998224725")).toBe("***.***.***-25");
    expect(mascararCpf("lixo")).toBe("***");
  });
});

describe("telefone", () => {
  it("normaliza para DDD + número, com ou sem +55 e pontuação", () => {
    expect(normalizarTelefone("(11) 91234-5678")).toBe("11912345678");
    expect(normalizarTelefone("+55 11 91234-5678")).toBe("11912345678");
    expect(normalizarTelefone("5511912345678")).toBe("11912345678");
    expect(normalizarTelefone("(11) 3234-5678")).toBe("1132345678");
  });

  it("recusa número incompleto, DDD inválido e celular sem o 9", () => {
    for (const ruim of ["", "1234", "(11) 1234-567", "(01) 91234-5678", "(11) 81234-5678", "abc"]) {
      expect(normalizarTelefone(ruim), ruim).toBeNull();
    }
  });

  it("mascara e formata", () => {
    expect(mascararTelefone("11912345678")).toBe("(11) *****-5678");
    expect(formatarTelefone("11912345678")).toBe("(11) 91234-5678");
    expect(formatarTelefone("1132345678")).toBe("(11) 3234-5678");
  });
});

describe("validarIdoso", () => {
  const base = { nome: "Maria da Silva", dataNascimento: "1938-05-20" };

  it("aceita dados corretos, com e sem CPF e quarto", () => {
    expect(validarIdoso(base, HOJE)).toEqual([]);
    expect(validarIdoso({ ...base, cpf: "529.982.247-25", quarto: "12B" }, HOJE)).toEqual([]);
    expect(validarIdoso({ ...base, cpf: null, quarto: null }, HOJE)).toEqual([]);
  });

  it("aponta cada problema em português", () => {
    expect(validarIdoso({ ...base, nome: " A " }, HOJE).join(" ")).toMatch(/nome/i);
    expect(validarIdoso({ ...base, dataNascimento: "20/05/1938" }, HOJE).join(" ")).toMatch(
      /AAAA-MM-DD/,
    );
    expect(validarIdoso({ ...base, dataNascimento: "2030-01-01" }, HOJE).join(" ")).toMatch(
      /futuro/,
    );
    expect(validarIdoso({ ...base, dataNascimento: "1850-01-01" }, HOJE).join(" ")).toMatch(/125/);
    expect(validarIdoso({ ...base, cpf: "123" }, HOJE).join(" ")).toMatch(/CPF/);
    expect(validarIdoso({ ...base, quarto: "x".repeat(41) }, HOJE).join(" ")).toMatch(/quarto/i);
  });

  it("em edição parcial, só valida o que veio", () => {
    expect(validarIdoso({}, HOJE)).toEqual([]);
    expect(validarIdoso({ quarto: "3A" }, HOJE)).toEqual([]);
    expect(validarIdoso({ nome: "" }, HOJE)).toHaveLength(1);
  });
});

describe("alergia e contato", () => {
  it("valida alergia", () => {
    expect(validarAlergia({ substancia: "Dipirona", gravidade: "grave" })).toEqual([]);
    expect(validarAlergia({ substancia: "D", gravidade: "grave" })).toHaveLength(1);
    expect(validarAlergia({ substancia: "Dipirona", gravidade: "enorme" as never })).toHaveLength(
      1,
    );
    expect(
      validarAlergia({ substancia: "Dipirona", gravidade: "leve", observacao: "x".repeat(501) }),
    ).toHaveLength(1);
  });

  it("valida contato", () => {
    const ok = { nome: "João Souza", parentesco: "Filho", telefone: "(11) 91234-5678" };
    expect(validarContato(ok)).toEqual([]);
    expect(validarContato({ ...ok, telefone: "123" }).join(" ")).toMatch(/Telefone/);
    expect(validarContato({ ...ok, nome: "J" })).toHaveLength(1);
    expect(validarContato({ ...ok, parentesco: "" })).toHaveLength(1);
  });
});

describe("QR da pulseira", () => {
  it("o código opaco tem 20 caracteres sem símbolos ambíguos e não se repete", () => {
    const codigos = new Set(Array.from({ length: 500 }, () => gerarCodigoOpaco()));
    expect(codigos.size).toBe(500);
    for (const c of codigos) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{20}$/);
  });

  it("monta e lê o conteúdo do QR, separando pulseira de etiqueta de lote", () => {
    const codigo = gerarCodigoOpaco();
    const payload = montarPayloadQr("idoso", codigo);
    expect(payload).toBe(`ILPI:I:${codigo}`);
    expect(lerPayloadQr(payload)).toEqual({ tipo: "idoso", codigo });
    expect(lerPayloadQr(montarPayloadQr("lote", codigo))).toEqual({ tipo: "lote", codigo });
  });

  it("extrai o código do QR, do texto digitado com hífens e em minúsculas", () => {
    const codigo = gerarCodigoOpaco();
    expect(extrairCodigo(montarPayloadQr("idoso", codigo), "idoso")).toBe(codigo);
    expect(extrairCodigo(codigoLegivel(codigo), "idoso")).toBe(codigo);
    expect(extrairCodigo(` ${codigoLegivel(codigo).toLowerCase()} `, "idoso")).toBe(codigo);
    expect(codigoLegivel(codigo)).toMatch(/^(\w{5}-){3}\w{5}$/);
  });

  it("recusa etiqueta do tipo errado, lixo e tamanho errado", () => {
    const codigo = gerarCodigoOpaco();
    expect(extrairCodigo(montarPayloadQr("lote", codigo), "idoso")).toBeNull();
    for (const ruim of [
      "",
      "ola",
      "ILPI:X:" + codigo,
      codigo.slice(1),
      codigo + "A",
      "0O1IL".repeat(4),
    ]) {
      expect(extrairCodigo(ruim, "idoso"), ruim).toBeNull();
    }
  });
});
