import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { gerarCodigoOpaco } from "@/compartilhado/tokens";
import { lerPayloadQr } from "@/compartilhado/qr";
import { gerarPdfDaPulseira } from "@/modules/idosos";

const temPoppler =
  spawnSync("pdftoppm", ["-v"]).error === undefined &&
  spawnSync("pdftotext", ["-v"]).error === undefined;

function rasterizar(pdf: Uint8Array): PNG {
  const pasta = mkdtempSync(join(tmpdir(), "pulseira-"));
  try {
    writeFileSync(join(pasta, "p.pdf"), pdf);
    execFileSync("pdftoppm", [
      "-r",
      "200",
      "-png",
      "-singlefile",
      join(pasta, "p.pdf"),
      join(pasta, "p"),
    ]);
    return PNG.sync.read(readFileSync(join(pasta, "p.png")));
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

function lerQrs(png: PNG): string[] {
  const lidos: string[] = [];
  const dados = new Uint8ClampedArray(png.data);
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const r = jsQR(dados, png.width, png.height);
    if (!r) break;
    lidos.push(r.data);
    // Apaga o QR já lido (pinta de branco a caixa dele) para o próximo ser encontrado.
    const xs = [
      r.location.topLeftCorner,
      r.location.topRightCorner,
      r.location.bottomLeftCorner,
      r.location.bottomRightCorner,
    ];
    const x0 = Math.floor(Math.min(...xs.map((p) => p.x))) - 4;
    const x1 = Math.ceil(Math.max(...xs.map((p) => p.x))) + 4;
    const y0 = Math.floor(Math.min(...xs.map((p) => p.y))) - 4;
    const y1 = Math.ceil(Math.max(...xs.map((p) => p.y))) + 4;
    for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x += 1) {
        dados.fill(255, (y * png.width + x) * 4, (y * png.width + x) * 4 + 4);
      }
    }
  }
  return lidos;
}

const base = { nome: "Maria Aparecida da Conceição", dataNascimento: "1938-05-20", quarto: "12B" };

describe("PDF da pulseira", () => {
  it("gera um PDF de uma página", async () => {
    const pdf = await gerarPdfDaPulseira({ ...base, codigo: gerarCodigoOpaco() });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it.runIf(temPoppler)(
    "os dois QR codes impressos (tira e cartão) leem de volta o mesmo código",
    async () => {
      const codigo = gerarCodigoOpaco();
      const lidos = lerQrs(rasterizar(await gerarPdfDaPulseira({ ...base, codigo })));
      expect(lidos).toHaveLength(2);
      for (const l of lidos) expect(lerPayloadQr(l)).toEqual({ tipo: "idoso", codigo });
    },
  );

  it.runIf(temPoppler)(
    "o texto impresso traz nome, nascimento e quarto para conferência",
    async () => {
      const pdf = await gerarPdfDaPulseira({ ...base, codigo: gerarCodigoOpaco() });
      const pasta = mkdtempSync(join(tmpdir(), "pulseira-txt-"));
      try {
        writeFileSync(join(pasta, "p.pdf"), pdf);
        const texto = execFileSync("pdftotext", [join(pasta, "p.pdf"), "-"]).toString();
        expect(texto).toContain("Maria Aparecida da Conceição");
        expect(texto).toContain("20/05/1938");
        expect(texto).toContain("Quarto 12B");
      } finally {
        rmSync(pasta, { recursive: true, force: true });
      }
    },
  );

  it("nomes enormes ou com caracteres fora do alfabeto latino não quebram a geração", async () => {
    const codigo = gerarCodigoOpaco();
    for (const nome of ["A".repeat(200), "Zoë 山田 太郎 😀", "João", "X"]) {
      const pdf = await gerarPdfDaPulseira({
        nome,
        dataNascimento: "1940-01-01",
        quarto: null,
        codigo,
      });
      expect(pdf.length).toBeGreaterThan(1000);
    }
  });

  it.runIf(temPoppler)("nome longo continua com QR legível", async () => {
    const codigo = gerarCodigoOpaco();
    const lidos = lerQrs(
      rasterizar(await gerarPdfDaPulseira({ ...base, nome: "B".repeat(150), codigo })),
    );
    expect(lidos).toHaveLength(2);
  });
});
