import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import pg from "pg";
import { comContexto } from "@/compartilhado/banco/transacao";
import { gerarDosesDaCasa } from "@/modules/administracao";
import { verificarAlertasDaCasa } from "@/modules/alertas";
import { registrarEntrada } from "@/modules/estoque";
import { criarDispositivo, criarUsuario, type SessaoAutenticada } from "@/modules/identidade";
import { cadastrarIdoso } from "@/modules/idosos";
import { cadastrarMedicamento, prescrever } from "@/modules/prescricoes";

// Casa fictícia do porte de uma casa real: 60 residentes em 2 alas (um andar), 12 pessoas na
// equipe em 3 turnos, 2 tablets. Só para demonstração: PINs e senha provisória fixos, nomes
// inventados. `DEMO_EMAIL` (ex.: seunome@gmail.com) faz os e-mails saírem como seunome+gestor@gmail.com.

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

function exigir<T extends { ok: boolean }>(r: T, oQue: string): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`${oQue}: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}
const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
// Sorteio repetível: a mesma casa sempre sai igual.
let semente = 20261121;
const sorteio = () => (semente = (semente * 1664525 + 1013904223) % 4294967296) / 4294967296;
const escolher = <T>(l: readonly T[]): T => l[Math.floor(sorteio() * l.length)]!;
function sortear<T>(l: readonly T[], n: number): T[] {
  const c = [...l];
  const r: T[] = [];
  while (r.length < n && c.length > 0) r.push(c.splice(Math.floor(sorteio() * c.length), 1)[0]!);
  return r;
}

const base = process.env.DEMO_EMAIL?.trim();
const email = (apelido: string, id: string) => {
  if (base?.includes("@")) {
    const [u, d] = base.split("@");
    return `${u}+${apelido}@${d}`;
  }
  return `${apelido}-${id}@demo.test`;
};

// ------------------------------------------------------------------ casa
const casaId = randomUUID();
const gestorSistemaId = randomUUID();
const marca = gestorSistemaId.slice(0, 6);
await comContexto(migrador, { casaId }, async (c) => {
  await c.query("INSERT INTO casa (id, nome) VALUES ($1, $2)", [
    casaId,
    `Lar Vila Serena (fictícia ${marca})`,
  ]);
  await c.query(
    `INSERT INTO usuario (id, casa_id, nome, email, perfil, senha_hash)
     VALUES ($1, $2, 'Administração do sistema', $3, 'gestor', $4)`,
    [gestorSistemaId, casaId, `sistema-${marca}@demo.test`, await hash(randomUUID())],
  );
});
const sistema: SessaoAutenticada = {
  sessaoId: randomUUID(),
  casaId,
  usuarioId: gestorSistemaId,
  perfil: "gestor",
  tipo: "web",
  dispositivoId: null,
  senhaTrocar: false,
  pinTrocar: false,
  reautenticadoEm: new Date(),
};

// ------------------------------------------------------------------ equipe (12)
const SENHA = "provisoria-da-demonstracao";
const PINS = [
  "731946",
  "582417",
  "264839",
  "915372",
  "406158",
  "693851",
  "158264",
  "749306",
  "320794",
  "584127",
  "967413",
  "281659",
];
const equipe: Array<{
  nome: string;
  perfil: "gestor" | "enfermeiro" | "cuidador";
  apelido?: string;
  turno: string;
}> = [
  { nome: "Marta Ribeiro (gestora)", perfil: "gestor", apelido: "gestora", turno: "comercial" },
  {
    nome: "Carla Mendes (enfermeira)",
    perfil: "enfermeiro",
    apelido: "enfermeira.manha",
    turno: "manhã",
  },
  {
    nome: "Paulo Nogueira (enfermeiro)",
    perfil: "enfermeiro",
    apelido: "enfermeiro.noite",
    turno: "noite",
  },
  { nome: "Ana Lima (cuidadora)", perfil: "cuidador", turno: "manhã" },
  { nome: "Bruno Alves (cuidador)", perfil: "cuidador", turno: "manhã" },
  { nome: "Cláudia Reis (cuidadora)", perfil: "cuidador", turno: "manhã" },
  { nome: "Diego Santos (cuidador)", perfil: "cuidador", turno: "tarde" },
  { nome: "Elaine Costa (cuidadora)", perfil: "cuidador", turno: "tarde" },
  { nome: "Fábio Moura (cuidador)", perfil: "cuidador", turno: "tarde" },
  { nome: "Graça Pinto (cuidadora)", perfil: "cuidador", turno: "noite" },
  { nome: "Hélio Duarte (cuidador)", perfil: "cuidador", turno: "noite" },
  { nome: "Irene Tavares (cuidadora)", perfil: "cuidador", turno: "noite" },
];
const linhasEquipe: string[] = [];
const ids: string[] = [];
let enfermeiraId = "";
for (const [i, p] of equipe.entries()) {
  const pin = PINS[i]!;
  const r = exigir(
    await criarUsuario(servico, sistema, {
      nome: p.nome,
      perfil: p.perfil,
      ...(p.apelido ? { email: email(p.apelido, marca), senhaInicial: SENHA } : {}),
      ...(p.perfil !== "gestor" ? { pinInicial: pin } : {}),
    }),
    p.nome,
  );
  ids.push(r.usuarioId);
  if (i === 1) enfermeiraId = r.usuarioId;
  linhasEquipe.push(
    `  ${p.nome.padEnd(30)} ${p.turno.padEnd(10)} ${p.perfil !== "gestor" ? `PIN ${pin}` : ""}${p.apelido ? `  e-mail ${email(p.apelido, marca)}` : ""}`,
  );
}
await comContexto(migrador, { casaId }, (c) =>
  c.query("UPDATE usuario SET pin_trocar = false WHERE id = ANY($1::uuid[])", [ids]),
);
const tablets = [
  await criarDispositivo(servico, sistema, { nome: "Tablet Ala A" }),
  await criarDispositivo(servico, sistema, { nome: "Tablet Ala B" }),
];
const enfermeira: SessaoAutenticada = { ...sistema, usuarioId: enfermeiraId, perfil: "enfermeiro" };

// ------------------------------------------------------------------ remédios (24)
const CATALOGO: Array<[string, string, string, boolean?]> = [
  ["Losartana", "Losartana potássica", "50 mg"],
  ["Metformina", "Cloridrato de metformina", "850 mg"],
  ["Sinvastatina", "Sinvastatina", "20 mg"],
  ["AAS", "Ácido acetilsalicílico", "100 mg"],
  ["Omeprazol", "Omeprazol", "20 mg"],
  ["Enalapril", "Maleato de enalapril", "10 mg"],
  ["Anlodipino", "Besilato de anlodipino", "5 mg"],
  ["Hidroclorotiazida", "Hidroclorotiazida", "25 mg"],
  ["Atenolol", "Atenolol", "50 mg"],
  ["Furosemida", "Furosemida", "40 mg"],
  ["Levotiroxina", "Levotiroxina sódica", "50 mcg"],
  ["Donepezila", "Cloridrato de donepezila", "10 mg"],
  ["Memantina", "Cloridrato de memantina", "10 mg"],
  ["Sertralina", "Cloridrato de sertralina", "50 mg"],
  ["Quetiapina", "Fumarato de quetiapina", "25 mg"],
  ["Clonazepam", "Clonazepam", "0,5 mg"],
  ["Carbamazepina", "Carbamazepina", "200 mg"],
  ["Levodopa+Benserazida", "Levodopa e benserazida", "200/50 mg"],
  ["Carbonato de Cálcio", "Carbonato de cálcio", "500 mg"],
  ["Vitamina D", "Colecalciferol", "2000 UI"],
  ["Espironolactona", "Espironolactona", "25 mg"],
  ["Varfarina", "Varfarina sódica", "5 mg", true],
  ["Digoxina", "Digoxina", "0,25 mg", true],
  ["Insulina oral (demo)", "Glibenclamida", "5 mg", true],
];
const remedios: Array<{ id: string; altoRisco: boolean }> = [];
for (const [nome, ativo, conc, risco] of CATALOGO) {
  const m = exigir(
    await cadastrarMedicamento(servico, enfermeira, {
      nomeComercial: nome,
      principioAtivo: ativo,
      concentracao: conc,
      forma: "comprimido",
      altoRisco: risco ?? false,
    }),
    nome,
  );
  exigir(
    await registrarEntrada(servico, enfermeira, {
      medicamentoId: m.medicamentoId,
      numeroLote: `V${Math.floor(1000 + sorteio() * 9000)}`,
      validade: "2027-12-31",
      unidade: "comprimido",
      quantidade: 600,
    }),
    `lote de ${nome}`,
  );
  remedios.push({ id: m.medicamentoId, altoRisco: risco ?? false });
}

// ------------------------------------------------------------------ 60 residentes
const NOMES = [
  "Aparecida",
  "Benedito",
  "Celina",
  "Durval",
  "Eunice",
  "Francisco",
  "Geralda",
  "Henrique",
  "Ivone",
  "João",
  "Lúcia",
  "Manoel",
  "Neusa",
  "Osvaldo",
  "Pedrina",
  "Raimundo",
  "Sebastiana",
  "Tereza",
  "Valdemar",
  "Zilda",
];
const SOBRENOMES = [
  "Souza",
  "Lima",
  "Prado",
  "Ferreira",
  "Gomes",
  "Barros",
  "Cardoso",
  "Teixeira",
  "Araújo",
  "Campos",
  "Rocha",
  "Nunes",
  "Pereira",
  "Martins",
  "Cunha",
];
const HORARIOS = ["08:00", "12:00", "14:00", "20:00", "22:00"] as const;
let total = 0;
for (const ala of ["A", "B"] as const) {
  for (let n = 1; n <= 30; n++) {
    const nome = `${escolher(NOMES)} ${escolher(SOBRENOMES)} ${escolher(SOBRENOMES)}`;
    const alergias = sorteio() < 0.15 ? [escolher(["Dipirona", "Penicilina", "Sulfa"])] : [];
    const r = exigir(
      await cadastrarIdoso(servico, enfermeira, {
        nome,
        dataNascimento: `${1930 + Math.floor(sorteio() * 18)}-${String(1 + Math.floor(sorteio() * 12)).padStart(2, "0")}-${String(1 + Math.floor(sorteio() * 28)).padStart(2, "0")}`,
        quarto: `Ala ${ala} - ${String(n).padStart(2, "0")}`,
        alergias: alergias.map((substancia) => ({ substancia, gravidade: "grave" as const })),
      }),
      nome,
    );
    for (const med of sortear(remedios, 2 + Math.floor(sorteio() * 4))) {
      const vezes = med.altoRisco ? 1 : 1 + Math.floor(sorteio() * 3);
      exigir(
        await prescrever(servico, enfermeira, {
          idosoId: r.idosoId,
          medicamentoId: med.id,
          tipo: "regular",
          dose: 1,
          unidade: "comprimido",
          via: "oral",
          inicio: hoje,
          fim: null,
          altoRisco: med.altoRisco,
          horarios: sortear(HORARIOS, vezes)
            .sort()
            .map((hora) => ({ hora })),
        }),
        "prescrição",
      );
    }
    total++;
  }
}
await gerarDosesDaCasa(servico, casaId);
const alertas = await verificarAlertasDaCasa(servico, casaId);

console.log(`
Casa fictícia criada: Lar Vila Serena (${marca}) com ${total} residentes (Ala A e Ala B), ${CATALOGO.length} remédios.

Tablets (digite o código em /tablet):
  Tablet Ala A  ${tablets[0]!.codigo}
  Tablet Ala B  ${tablets[1]!.codigo}

Equipe (PIN no tablet; e-mail e senha provisória "${SENHA}" no computador, em /entrar):
${linhasEquipe.join("\n")}

Alertas abertos: ${alertas.abertos}
`);
await app.end();
await migrador.end();
