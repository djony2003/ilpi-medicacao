// Retorno sensorial da leitura: som curto e vibração. Um tom para "leu", outro (mais grave e
// duplo) para "bloqueou". Funciona sem arquivos de áudio (Web Audio) e falha calada se o aparelho
// não tiver som ou vibração.

let contexto: AudioContext | null = null;

function tom(frequencia: number, inicio: number, duracao: number) {
  if (!contexto) return;
  const osc = contexto.createOscillator();
  const ganho = contexto.createGain();
  osc.type = "sine";
  osc.frequency.value = frequencia;
  ganho.gain.setValueAtTime(0.0001, contexto.currentTime + inicio);
  ganho.gain.exponentialRampToValueAtTime(0.3, contexto.currentTime + inicio + 0.01);
  ganho.gain.exponentialRampToValueAtTime(0.0001, contexto.currentTime + inicio + duracao);
  osc.connect(ganho).connect(contexto.destination);
  osc.start(contexto.currentTime + inicio);
  osc.stop(contexto.currentTime + inicio + duracao + 0.02);
}

/** Precisa ser chamado num toque da pessoa (regra dos navegadores para liberar o som). */
export function prepararSom() {
  try {
    contexto ??= new AudioContext();
    if (contexto.state === "suspended") void contexto.resume();
  } catch {
    contexto = null;
  }
}

function vibrar(padrao: number | number[]) {
  try {
    navigator.vibrate?.(padrao);
  } catch {
    // aparelho sem vibração
  }
}

export function sinalDeLeitura() {
  tom(1320, 0, 0.12);
  vibrar(60);
}

export function sinalDeBloqueio() {
  tom(330, 0, 0.18);
  tom(260, 0.22, 0.28);
  vibrar([120, 80, 220]);
}

export function sinalDeConcluido() {
  tom(880, 0, 0.1);
  tom(1320, 0.12, 0.16);
  vibrar(80);
}
