import { ArmazenamentoEmDisco } from "@/compartilhado/armazenamento";
import { ambiente } from "@/compartilhado/ambiente";
import { obterPool } from "@/compartilhado/banco/pool";
import { criarApi } from "@/web/api";

// Ponto único de entrada da API. Toda a lógica está em src/web/api.ts, que também é usada
// diretamente nos testes sem precisar subir o servidor.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Criada na primeira requisição, não na importação: o build do Next importa este arquivo sem as
// variáveis de ambiente de execução.
let armazenamento: ArmazenamentoEmDisco | undefined;
let api: ((request: Request) => Promise<Response>) | undefined;

function obterApi(): (request: Request) => Promise<Response> {
  api ??= criarApi({
    servico: () => ({
      pool: obterPool(),
      chaveCampos: ambiente().CHAVE_CAMPOS,
      armazenamento: (armazenamento ??= new ArmazenamentoEmDisco(ambiente().ARMAZENAMENTO_DIR)),
    }),
    producao: process.env.NODE_ENV === "production",
    origemEsperada: ambiente().APP_ORIGEM,
  });
  return api;
}

export const GET = (request: Request) => obterApi()(request);
export const POST = (request: Request) => obterApi()(request);
