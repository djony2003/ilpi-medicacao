// Tipos das respostas da API. `import type` some na compilação: nenhum código do servidor (banco,
// criptografia) entra no pacote do tablet.
export type {
  Bloqueio,
  ConferenciaDaDose,
  DoseDaEscala,
  EscalaDoPlantao,
  LoteDisponivel,
  SosDoIdoso,
} from "@/modules/administracao";

export type Pessoa = { id: string; nome: string; perfil: "gestor" | "enfermeiro" | "cuidador" };
export type PinDeOutraPessoa = { usuarioId: string; pin: string };
