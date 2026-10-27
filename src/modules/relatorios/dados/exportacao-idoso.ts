import { comContexto } from "@/compartilhado/banco/transacao";
import { decifrar } from "@/compartilhado/criptografia";
import { falha, type Falha } from "@/compartilhado/resultado";
import { relogio, type Servico } from "@/compartilhado/servico";
import { registrarAuditoria } from "@/modules/auditoria";
import {
  exigirPermissao,
  exigirReautenticacaoRecente,
  type SessaoAutenticada,
} from "@/modules/identidade";

// Exportação dos dados de um residente (LGPD, art. 18: acesso e portabilidade; spec 7.5). A casa
// é a controladora: o gestor atende o pedido do titular ou da família e entrega este arquivo.
//
// Sai tudo o que o sistema guarda sobre a pessoa: cadastro (com CPF e telefones por extenso),
// alergias, contatos, prescrições com todas as versões, administrações e as alterações do cadastro.
// Não sai: o código da pulseira (credencial), a chave da foto, endereços de IP e qualquer dado
// de acesso da equipe. Exige a senha confirmada há pouco e fica na trilha, só com as contagens.

const contexto = (ator: SessaoAutenticada) => ({ casaId: ator.casaId, usuarioId: ator.usuarioId });

export type ExportacaoDoIdoso = {
  formato: "ilpi-exportacao-idoso/1";
  exportadoEm: string;
  casa: string;
  residente: {
    id: string;
    nome: string;
    dataNascimento: string;
    cpf: string | null;
    quarto: string | null;
    situacao: string;
    cadastradoEm: string;
  };
  alergias: Array<{
    substancia: string;
    gravidade: string;
    observacao: string | null;
    ativa: boolean;
    registradaEm: string;
    desativadaEm: string | null;
  }>;
  contatosDeEmergencia: Array<{
    nome: string;
    parentesco: string;
    telefone: string;
    responsavelLegal: boolean;
    ativo: boolean;
  }>;
  prescricoes: Array<{
    grupo: string;
    versao: number;
    tipo: string;
    medicamento: string;
    principioAtivo: string;
    concentracao: string | null;
    dose: string;
    unidade: string;
    via: string;
    instrucoes: string | null;
    inicio: string;
    fim: string | null;
    altoRisco: boolean;
    prescritor: string | null;
    justificativa: string | null;
    situacao: string;
    encerradaEm: string | null;
    motivoEncerramento: string | null;
    horarios: string[];
    sos: { indicacao: string; limiteDiario: number; intervaloMinimoMin: number } | null;
  }>;
  administracoes: Array<{
    ocorridaEm: string;
    registradaEm: string;
    medicamento: string;
    resultado: string;
    motivo: string | null;
    quantidade: string | null;
    loteNumero: string | null;
    metodo: string;
    foraDaJanela: string | null;
    registradoPor: string;
    excecaoDeConferencia: { motivo: string; justificativa: string; liberadaPor: string } | null;
    segundaValidacaoPor: string | null;
  }>;
  alteracoesDoCadastro: Array<{ quando: string; quem: string | null; acao: string }>;
};

type Linha = Record<string, unknown>;

export async function exportarDadosDoIdoso(
  servico: Servico,
  ator: SessaoAutenticada,
  entrada: { idosoId: string; ip?: string | null },
): Promise<{ ok: true; exportacao: ExportacaoDoIdoso } | Falha<"nao_encontrado">> {
  exigirPermissao(ator.perfil, "lgpd.exportar");
  const agora = relogio(servico);
  exigirReautenticacaoRecente(ator.reautenticadoEm, agora);
  const chave = servico.chaveCampos;

  return comContexto(servico.pool, contexto(ator), async (c) => {
    const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
    const isoOuNulo = (d: unknown): string | null =>
      d === null || d === undefined ? null : iso(d);

    const i = (
      await c.query<Linha>(
        `SELECT i.id, i.nome, i.data_nascimento::text AS nascimento, i.cpf_cifrado, i.quarto,
                i.status::text AS status, i.criado_em, ca.nome AS casa
           FROM idoso i JOIN casa ca ON ca.id = i.casa_id
          WHERE i.id = $1`,
        [entrada.idosoId],
      )
    ).rows[0];
    if (!i) return falha("nao_encontrado");

    const alergias = await c.query<Linha>(
      `SELECT substancia, gravidade::text AS gravidade, observacao, ativa, criado_em, desativada_em
         FROM alergia WHERE idoso_id = $1 ORDER BY criado_em, id`,
      [entrada.idosoId],
    );
    const contatos = await c.query<Linha>(
      `SELECT nome, parentesco, telefone_cifrado, responsavel_legal, ativo
         FROM contato_emergencia WHERE idoso_id = $1 ORDER BY criado_em, id`,
      [entrada.idosoId],
    );
    const prescricoes = await c.query<Linha>(
      `SELECT p.grupo_id, p.versao, p.tipo::text AS tipo, m.nome_comercial, m.principio_ativo,
              m.concentracao, p.dose::text AS dose, p.unidade::text AS unidade, p.via::text AS via,
              p.instrucoes, p.inicio::text AS inicio, p.fim::text AS fim, p.alto_risco, p.prescritor,
              p.justificativa, p.status::text AS status, p.encerrada_em, p.motivo_encerramento,
              p.sos_indicacao, p.sos_limite_diario, p.sos_intervalo_min,
              coalesce((SELECT array_agg(to_char(h.hora, 'HH24:MI') ORDER BY h.hora)
                          FROM horario_prescricao h WHERE h.prescricao_id = p.id), '{}') AS horarios
         FROM prescricao p JOIN medicamento m ON m.id = p.medicamento_id AND m.casa_id = p.casa_id
        WHERE p.idoso_id = $1 ORDER BY p.criado_em, p.versao, p.id`,
      [entrada.idosoId],
    );
    const administracoes = await c.query<Linha>(
      `SELECT a.ocorrida_em, a.registrada_em, m.nome_comercial, a.resultado::text AS resultado,
              a.motivo, a.quantidade::text AS quantidade, l.numero_lote, a.metodo::text AS metodo,
              a.fora_da_janela, ur.nome AS registrado_por,
              e.motivo AS excecao_motivo, e.justificativa AS excecao_justificativa,
              ul.nome AS excecao_liberada_por, uv.nome AS validador
         FROM administracao a
         JOIN prescricao p ON p.id = a.prescricao_id AND p.casa_id = a.casa_id
         JOIN medicamento m ON m.id = p.medicamento_id AND m.casa_id = p.casa_id
         JOIN usuario ur ON ur.id = a.usuario_id
         LEFT JOIN lote_estoque l ON l.id = a.lote_id AND l.casa_id = a.casa_id
         LEFT JOIN excecao_conferencia e ON e.administracao_id = a.id AND e.casa_id = a.casa_id
         LEFT JOIN usuario ul ON ul.id = e.liberada_por
         LEFT JOIN segunda_validacao sv ON sv.administracao_id = a.id AND sv.casa_id = a.casa_id
         LEFT JOIN usuario uv ON uv.id = sv.validador_id
        WHERE a.idoso_id = $1 ORDER BY a.ocorrida_em, a.seq`,
      [entrada.idosoId],
    );
    const alteracoes = await c.query<Linha>(
      `SELECT a.ocorrido_em, u.nome, a.acao
         FROM auditoria a LEFT JOIN usuario u ON u.id = a.usuario_id
        WHERE a.entidade = 'idoso' AND a.entidade_id = $1 ORDER BY a.seq`,
      [entrada.idosoId],
    );

    const exportacao: ExportacaoDoIdoso = {
      formato: "ilpi-exportacao-idoso/1",
      exportadoEm: agora.toISOString(),
      casa: String(i.casa),
      residente: {
        id: String(i.id),
        nome: String(i.nome),
        dataNascimento: String(i.nascimento),
        cpf: i.cpf_cifrado ? decifrar(String(i.cpf_cifrado), chave) : null,
        quarto: (i.quarto as string | null) ?? null,
        situacao: String(i.status),
        cadastradoEm: iso(i.criado_em),
      },
      alergias: alergias.rows.map((a) => ({
        substancia: String(a.substancia),
        gravidade: String(a.gravidade),
        observacao: (a.observacao as string | null) ?? null,
        ativa: Boolean(a.ativa),
        registradaEm: iso(a.criado_em),
        desativadaEm: isoOuNulo(a.desativada_em),
      })),
      contatosDeEmergencia: contatos.rows.map((k) => ({
        nome: String(k.nome),
        parentesco: String(k.parentesco),
        telefone: decifrar(String(k.telefone_cifrado), chave),
        responsavelLegal: Boolean(k.responsavel_legal),
        ativo: Boolean(k.ativo),
      })),
      prescricoes: prescricoes.rows.map((p) => ({
        grupo: String(p.grupo_id),
        versao: Number(p.versao),
        tipo: String(p.tipo),
        medicamento: String(p.nome_comercial),
        principioAtivo: String(p.principio_ativo),
        concentracao: (p.concentracao as string | null) ?? null,
        dose: String(p.dose),
        unidade: String(p.unidade),
        via: String(p.via),
        instrucoes: (p.instrucoes as string | null) ?? null,
        inicio: String(p.inicio),
        fim: (p.fim as string | null) ?? null,
        altoRisco: Boolean(p.alto_risco),
        prescritor: (p.prescritor as string | null) ?? null,
        justificativa: (p.justificativa as string | null) ?? null,
        situacao: String(p.status),
        encerradaEm: isoOuNulo(p.encerrada_em),
        motivoEncerramento: (p.motivo_encerramento as string | null) ?? null,
        horarios: p.horarios as string[],
        sos:
          p.tipo === "sos"
            ? {
                indicacao: String(p.sos_indicacao),
                limiteDiario: Number(p.sos_limite_diario),
                intervaloMinimoMin: Number(p.sos_intervalo_min),
              }
            : null,
      })),
      administracoes: administracoes.rows.map((a) => ({
        ocorridaEm: iso(a.ocorrida_em),
        registradaEm: iso(a.registrada_em),
        medicamento: String(a.nome_comercial),
        resultado: String(a.resultado),
        motivo: (a.motivo as string | null) ?? null,
        quantidade: (a.quantidade as string | null) ?? null,
        loteNumero: (a.numero_lote as string | null) ?? null,
        metodo: String(a.metodo),
        foraDaJanela: (a.fora_da_janela as string | null) ?? null,
        registradoPor: String(a.registrado_por),
        excecaoDeConferencia: a.excecao_motivo
          ? {
              motivo: String(a.excecao_motivo),
              justificativa: String(a.excecao_justificativa),
              liberadaPor: String(a.excecao_liberada_por),
            }
          : null,
        segundaValidacaoPor: (a.validador as string | null) ?? null,
      })),
      alteracoesDoCadastro: alteracoes.rows.map((a) => ({
        quando: iso(a.ocorrido_em),
        quem: (a.nome as string | null) ?? null,
        acao: String(a.acao),
      })),
    };

    await registrarAuditoria(c, {
      acao: "idoso.dados_exportados",
      entidade: "idoso",
      entidadeId: entrada.idosoId,
      depois: {
        alergias: exportacao.alergias.length,
        contatos: exportacao.contatosDeEmergencia.length,
        prescricoes: exportacao.prescricoes.length,
        administracoes: exportacao.administracoes.length,
      },
      ip: entrada.ip,
    });
    return { ok: true, exportacao } as const;
  });
}
