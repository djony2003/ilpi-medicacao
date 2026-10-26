// Limites da dose "se necessário" (SOS). Função pura: recebe as doses já dadas e o instante atual.
//
// O limite diário usa janela móvel de 24 horas, não o dia do calendário: com "no máximo 4 por dia",
// 4 doses entre 22h e 23h50 e mais 4 depois da meia-noite seriam 8 doses em duas horas e meia.
// A janela móvel é a leitura clínica segura.

const MIN = 60_000;
const DIA = 24 * 60 * MIN;

export type LimiteSos = { limiteDiario: number; intervaloMinimoMin: number };

export type ResultadoSos =
  | { permitido: true }
  | { permitido: false; motivo: "intervalo_minimo" | "limite_diario"; liberaEm: Date };

export function verificarLimiteSos(
  limite: LimiteSos,
  jaAdministradas: Date[],
  agora: Date,
): ResultadoSos {
  const doses = jaAdministradas
    .map((d) => d.getTime())
    .filter((t) => t <= agora.getTime())
    .sort((a, b) => a - b);

  const ultima = doses.at(-1);
  const porIntervalo =
    ultima !== undefined ? ultima + limite.intervaloMinimoMin * MIN : Number.NEGATIVE_INFINITY;

  const naJanela = doses.filter((t) => t > agora.getTime() - DIA);
  // Com N doses na janela e limite L, a próxima só cabe quando sobrarem L-1: some a (N-L+1)-ésima mais antiga.
  const porLimite =
    naJanela.length >= limite.limiteDiario
      ? (naJanela[naJanela.length - limite.limiteDiario] ?? 0) + DIA
      : Number.NEGATIVE_INFINITY;

  const bloqueioIntervalo = porIntervalo > agora.getTime();
  const bloqueioLimite = porLimite > agora.getTime();
  if (!bloqueioIntervalo && !bloqueioLimite) return { permitido: true };

  // Se os dois valem, o que libera por último é o que manda; o limite diário é o mais grave.
  if (bloqueioLimite && porLimite >= porIntervalo) {
    return { permitido: false, motivo: "limite_diario", liberaEm: new Date(porLimite) };
  }
  return { permitido: false, motivo: "intervalo_minimo", liberaEm: new Date(porIntervalo) };
}
