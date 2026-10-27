import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "@node-rs/argon2";
import pg from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarDosesDaCasa } from "@/modules/administracao";
import { verificarAlertasDaCasa } from "@/modules/alertas";
import { emitirEtiqueta, gerarPdfDaEtiqueta, registrarEntrada } from "@/modules/estoque";
import { criarDispositivo, criarUsuario, type SessaoAutenticada } from "@/modules/identidade";
import {
  adicionarAlergia,
  cadastrarIdoso,
  emitirPulseira,
  gerarPdfDaPulseira,
} from "@/modules/idosos";
import { cadastrarMedicamento, prescrever } from "@/modules/prescricoes";

// Casa de demonstração para o tablet: `npm run demo`. Cria uma casa nova (a cada execução), a
// equipe com PIN, um tablet com código de ativação, três residentes, remédios, lotes e doses para
// os próximos minutos, e grava em ./demo os PDFs das pulseiras e das etiquetas para imprimir.
//
// Só para desenvolvimento e demonstração: os PINs são fixos e aparecem na tela.

const MIGRADOR = process.env.MIGRATOR_DATABASE_URL;
const APP = process.env.DATABASE_URL;
const CHAVE = process.env.CHAVE_CAMPOS;
if (!MIGRADOR || !APP || !CHAVE) {
  console.error("Faltam MIGRATOR_DATABASE_URL, DATABASE_URL ou CHAVE_CAMPOS (veja .env.example).");
  process.exit(1);
}

const migrador = new pg.Pool({ connectionString: MIGRADOR, max: 2 });
const app = new pg.Pool({ connectionString: APP, max: 4 });
const servico = { pool: app, chaveCampos: CHAVE };
const PASTA = join(process.cwd(), "demo");
mkdirSync(PASTA, { recursive: true });

function exigir<T extends { ok: boolean }>(r: T, oQue: string): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`${oQue}: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

/** HH:MM em São Paulo daqui a `min` minutos (arredondado para 5). */
function horaDaquiA(min: number): string {
  const t = Math.ceil((Date.now() + min * 60_000) / 300_000) * 300_000;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(t));
}
const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

// ------------------------------------------------------------------ casa e gestor
const casaId = randomUUID();
const gestorId = randomUUID();
const carimbo = new Date().toISOString().slice(5, 16).replace("T", " ");
await comContexto(migrador, { casaId }, async (c) => {
  await c.query("INSERT INTO casa (id, nome) VALUES ($1, $2)", [
    casaId,
    `Casa de Demonstração ${carimbo}`,
  ]);
  await c.query(
    `INSERT INTO usuario (id, casa_id, nome, email, perfil, senha_hash)
     VALUES ($1, $2, 'Gestora da Demonstração', $3, 'gestor', $4)`,
    [gestorId, casaId, `gestora-${gestorId.slice(0, 8)}@demo.test`, await hash(randomUUID())],
  );
});
// A gestora age por este script (não entra pela tela): sessão só em memória, já confirmada.
const gestora: SessaoAutenticada = {
  sessaoId: randomUUID(),
  casaId,
  usuarioId: gestorId,
  perfil: "gestor",
  tipo: "web",
  dispositivoId: null,
  senhaTrocar: false,
  pinTrocar: false,
  reautenticadoEm: new Date(),
};

// ------------------------------------------------------------------ equipe e tablet
// Senha provisória da enfermeira no computador: no primeiro acesso ela configura o autenticador
// e troca a senha.
const SENHA_PROVISORIA = "provisoria-da-demonstracao";
const PINS = { cuidadora: "731946", colega: "582417", enfermeira: "264839" };
const ana = exigir(
  await criarUsuario(servico, gestora, {
    nome: "Ana (cuidadora)",
    perfil: "cuidador",
    pinInicial: PINS.cuidadora,
  }),
  "cuidadora",
);
const bruno = exigir(
  await criarUsuario(servico, gestora, {
    nome: "Bruno (cuidador)",
    perfil: "cuidador",
    pinInicial: PINS.colega,
  }),
  "cuidador",
);
const carla = exigir(
  await criarUsuario(servico, gestora, {
    nome: "Carla (enfermeira)",
    perfil: "enfermeiro",
    email: `carla-${gestorId.slice(0, 8)}@demo.test`,
    senhaInicial: SENHA_PROVISORIA,
    pinInicial: PINS.enfermeira,
  }),
  "enfermeira",
);
// Gestor com acesso pelo computador (a gestora acima age só por este script).
exigir(
  await criarUsuario(servico, gestora, {
    nome: "Marcos (gestor)",
    perfil: "gestor",
    email: `marcos-${gestorId.slice(0, 8)}@demo.test`,
    senhaInicial: SENHA_PROVISORIA,
  }),
  "gestor",
);
// Na demonstração, o PIN já vale como definitivo (na vida real, a pessoa troca no primeiro uso).
await comContexto(migrador, { casaId }, (c) =>
  c.query("UPDATE usuario SET pin_trocar = false WHERE id = ANY($1::uuid[])", [
    [ana.usuarioId, bruno.usuarioId, carla.usuarioId],
  ]),
);
const tablet = await criarDispositivo(servico, gestora, { nome: "Tablet do posto (demo)" });

// ------------------------------------------------------------------ residentes e remédios
const enfermeira: SessaoAutenticada = {
  ...gestora,
  usuarioId: carla.usuarioId,
  perfil: "enfermeiro",
};

async function residente(nome: string, quarto: string, alergias: string[] = []) {
  const r = exigir(
    await cadastrarIdoso(servico, enfermeira, {
      nome,
      dataNascimento: "1938-04-12",
      quarto,
      alergias: alergias.map((substancia) => ({ substancia, gravidade: "grave" as const })),
    }),
    nome,
  );
  return r.idosoId;
}

async function remedio(
  nomeComercial: string,
  principioAtivo: string,
  concentracao: string,
  altoRisco = false,
  lote: { quantidade?: number; validade?: string } = {},
) {
  const m = exigir(
    await cadastrarMedicamento(servico, enfermeira, {
      nomeComercial,
      principioAtivo,
      concentracao,
      forma: "comprimido",
      altoRisco,
    }),
    nomeComercial,
  );
  const l = exigir(
    await registrarEntrada(servico, enfermeira, {
      medicamentoId: m.medicamentoId,
      numeroLote: `D${Math.floor(1000 + Math.random() * 9000)}`,
      validade: lote.validade ?? "2027-12-31",
      unidade: "comprimido",
      quantidade: lote.quantidade ?? 30,
    }),
    `lote de ${nomeComercial}`,
  );
  const e = exigir(await emitirEtiqueta(servico, enfermeira, { loteId: l.loteId }), "etiqueta");
  writeFileSync(
    join(PASTA, `etiqueta-${nomeComercial.toLowerCase()}.pdf`),
    await gerarPdfDaEtiqueta(e.etiqueta),
  );
  return m.medicamentoId;
}

async function regular(idosoId: string, medicamentoId: string, hora: string, altoRisco = false) {
  exigir(
    await prescrever(servico, enfermeira, {
      idosoId,
      medicamentoId,
      tipo: "regular",
      dose: 1,
      unidade: "comprimido",
      via: "oral",
      inicio: hoje,
      fim: null,
      altoRisco,
      horarios: [{ hora }],
    }),
    "prescrição",
  );
}

const aparecida = await residente("Aparecida Souza", "12", ["Dipirona"]);
const benedito = await residente("Benedito Lima", "14");
const celina = await residente("Celina Prado", "15");

const losartana = await remedio("Losartana", "Losartana potássica", "50 mg");
const metformina = await remedio("Metformina", "Cloridrato de metformina", "850 mg");
// Varfarina com 2 comprimidos: o estoque acaba em 2 dias (alerta urgente).
const varfarina = await remedio("Varfarina", "Varfarina sódica", "5 mg", true, { quantidade: 2 });
const amoxicilina = await remedio("Amoxicilina", "Amoxicilina", "500 mg");
const paracetamol = await remedio("Paracetamol", "Paracetamol", "500 mg");
// Um lote que vence em 20 dias (alerta de validade, aviso).
await remedio("Dipirona", "Dipirona sódica", "500 mg", false, {
  validade: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
});

await regular(aparecida, losartana, horaDaquiA(5));
await regular(benedito, metformina, horaDaquiA(10));
await regular(benedito, varfarina, horaDaquiA(15), true);
await regular(celina, amoxicilina, horaDaquiA(20));
exigir(
  await prescrever(servico, enfermeira, {
    idosoId: aparecida,
    medicamentoId: paracetamol,
    tipo: "sos",
    dose: 1,
    unidade: "comprimido",
    via: "oral",
    inicio: hoje,
    fim: null,
    altoRisco: false,
    horarios: [],
    sos: { indicacao: "Dor ou febre", limiteDiario: 4, intervaloMinimoMin: 360 },
  }),
  "SOS",
);
// Alergia descoberta depois da prescrição: a dose de Celina vai bloquear na conferência.
exigir(
  await adicionarAlergia(servico, enfermeira, {
    idosoId: celina,
    substancia: "Penicilina",
    gravidade: "grave",
  }),
  "alergia",
);
await gerarDosesDaCasa(servico, casaId);
const alertas = await verificarAlertasDaCasa(servico, casaId);

for (const [id, arquivo] of [
  [aparecida, "aparecida"],
  [benedito, "benedito"],
  [celina, "celina"],
] as const) {
  const p = exigir(await emitirPulseira(servico, enfermeira, { idosoId: id }), "pulseira");
  writeFileSync(join(PASTA, `pulseira-${arquivo}.pdf`), await gerarPdfDaPulseira(p.pulseira));
}

console.log(`
Casa de demonstração criada.

Código de ativação do tablet: ${tablet.codigo}
  Abra /tablet no aparelho e digite o código.

Equipe (PIN):
  Ana (cuidadora)      ${PINS.cuidadora}
  Bruno (cuidador)     ${PINS.colega}    (segunda validação da Varfarina)
  Carla (enfermeira)   ${PINS.enfermeira}    (exceção de conferência e liberação)

Doses de hoje: Aparecida (Losartana ${horaDaquiA(5)}), Benedito (Metformina ${horaDaquiA(10)},
Varfarina ${horaDaquiA(15)}, alto risco), Celina (Amoxicilina ${horaDaquiA(20)}: bloqueia por alergia
a Penicilina). SOS: Paracetamol para Aparecida.

Computador (/entrar): ${`carla-${gestorId.slice(0, 8)}@demo.test`}, senha provisória ${SENHA_PROVISORIA}
  No primeiro acesso: configurar o autenticador e trocar a senha.

Gestão (/entrar): ${`marcos-${gestorId.slice(0, 8)}@demo.test`}, senha provisória ${SENHA_PROVISORIA}
  Vê também Exceções, Auditoria e Configurações.

Alertas abertos: ${alertas.abertos} (estoque baixo da Varfarina, validade da Dipirona).

PDFs das pulseiras e etiquetas em ${PASTA}
`);

await app.end();
await migrador.end();
