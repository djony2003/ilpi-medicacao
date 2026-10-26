// Regras do PIN de 6 dígitos usado no tablet. Um PIN curto é fraco por natureza; a proteção real
// está no aparelho aprovado, no bloqueio por tentativas e na expiração rápida da sessão. Mesmo
// assim, recusamos os PINs que qualquer pessoa tentaria primeiro.

export const TAMANHO_PIN = 6;

function todosIguais(pin: string): boolean {
  return new Set(pin).size === 1;
}

function sequencia(pin: string): boolean {
  const d = [...pin].map(Number);
  const passos = d.slice(1).map((n, i) => n - (d[i] ?? 0));
  return passos.every((p) => p === 1) || passos.every((p) => p === -1);
}

// 121212, 123123, 456456: um bloco curto repetido.
function blocoRepetido(pin: string): boolean {
  return (
    pin.slice(0, 2).repeat(3) === pin ||
    pin.slice(0, 3).repeat(2) === pin ||
    pin.slice(0, 1).repeat(6) === pin
  );
}

// 123321, 456654: lê igual de trás para frente.
function espelhado(pin: string): boolean {
  return pin === [...pin].reverse().join("");
}

// 112233, 556677: três pares.
function paresEmSequencia(pin: string): boolean {
  const [a, b, c, d, e, f] = [...pin];
  return a === b && c === d && e === f;
}

const MAIS_USADOS = new Set([
  "123456",
  "654321",
  "000000",
  "111111",
  "121212",
  "123123",
  "112233",
  "159753",
  "147258",
  "258369",
  "123321",
  "010203",
  "102030",
  "112211",
  "696969",
  "200000",
  "202020",
  "101010",
  "131313",
  "142536",
]);

export function validarPin(pin: string): string[] {
  const problemas: string[] = [];
  if (!/^\d{6}$/.test(pin)) {
    return [`O PIN precisa ter exatamente ${TAMANHO_PIN} dígitos, só números.`];
  }
  if (
    MAIS_USADOS.has(pin) ||
    todosIguais(pin) ||
    sequencia(pin) ||
    blocoRepetido(pin) ||
    espelhado(pin) ||
    paresEmSequencia(pin)
  ) {
    problemas.push("Esse PIN é fácil demais de adivinhar. Escolha outro.");
  }
  return problemas;
}
