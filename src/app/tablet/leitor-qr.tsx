"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

// Leitura de QR pela câmera traseira do tablet. Usa o leitor nativo do navegador quando existe
// (BarcodeDetector, rápido e econômico no Chrome do Android) e, se não, decodifica os quadros com
// jsQR. Sempre há a saída de digitar o código impresso embaixo do QR, para etiqueta gasta ou
// câmera negada.
//
// A câmera fica ligada enquanto o leitor está na tela; `desativado` só pausa a entrega de leituras
// (enquanto o servidor confere a anterior), sem desligar a câmera, que demora a voltar em tablet
// modesto. Um mesmo código só é entregue de novo depois de 3 segundos. `ignorar` é o código que
// acabou de ser recusado: a pulseira errada continua na frente da câmera, e relê-la a cada quadro
// inundaria o servidor (e a trilha de auditoria) de bloqueios iguais.

type Detector = { detect(fonte: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type ConstrutorDeDetector = new (opcoes: { formats: string[] }) => Detector;

const QUADROS_POR_SEGUNDO = 8;
const REPETIR_O_MESMO_APOS_MS = 3000;

export function LeitorQr({
  instrucao,
  rotuloDoCodigo,
  aoLer,
  desativado = false,
  ignorar = [],
}: {
  /** O que a pessoa deve apontar: "Aponte para a pulseira do paciente". */
  instrucao: string;
  /** "Código da pulseira" ou "Código da etiqueta", para a digitação manual. */
  rotuloDoCodigo: string;
  aoLer: (texto: string) => void;
  desativado?: boolean;
  /** Códigos a não entregar: o recém-recusado e o que já foi aceito no passo anterior. */
  ignorar?: Array<string | null>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const tela = useRef<HTMLCanvasElement>(null);
  const aoLerRef = useRef(aoLer);
  const ignorarRef = useRef(ignorar);
  const pausadoRef = useRef(desativado);
  const ultima = useRef<{ texto: string; em: number } | null>(null);
  const [situacao, setSituacao] = useState<"iniciando" | "lendo" | "sem_camera">("iniciando");
  const [digitando, setDigitando] = useState(false);
  const [codigo, setCodigo] = useState("");

  useEffect(() => {
    aoLerRef.current = aoLer;
    ignorarRef.current = ignorar;
    pausadoRef.current = desativado;
  }, [aoLer, ignorar, desativado]);

  useEffect(() => {
    if (digitando) return;
    let fluxo: MediaStream | null = null;
    let parado = false;
    let espera: number | undefined;

    const Nativo = (globalThis as unknown as { BarcodeDetector?: ConstrutorDeDetector })
      .BarcodeDetector;
    const detector = Nativo ? new Nativo({ formats: ["qr_code"] }) : null;

    async function ler(): Promise<string | null> {
      const v = video.current;
      const c = tela.current;
      if (!v || !c || v.readyState < 2) return null;
      if (detector) {
        try {
          const achados = await detector.detect(v);
          if (achados[0]?.rawValue) return achados[0].rawValue;
          return null;
        } catch {
          // segue para o jsQR
        }
      }
      // Quadro reduzido: QR de pulseira e etiqueta ocupa boa parte da imagem, e menos pixels
      // significa leitura mais rápida em tablet modesto.
      const escala = Math.min(1, 640 / Math.max(v.videoWidth, 1));
      c.width = Math.round(v.videoWidth * escala);
      c.height = Math.round(v.videoHeight * escala);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      return (
        jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null
      );
    }

    async function laco() {
      if (parado) return;
      const texto = pausadoRef.current ? null : await ler();
      if (parado) return;
      const agora = Date.now();
      const repetida =
        ultima.current?.texto === texto && agora - ultima.current.em < REPETIR_O_MESMO_APOS_MS;
      if (texto && !ignorarRef.current.includes(texto) && !repetida && !pausadoRef.current) {
        ultima.current = { texto, em: agora };
        aoLerRef.current(texto);
      }
      espera = window.setTimeout(() => void laco(), 1000 / QUADROS_POR_SEGUNDO);
    }

    (async () => {
      try {
        fluxo = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (parado || !video.current) return;
        video.current.srcObject = fluxo;
        await video.current.play();
        setSituacao("lendo");
        void laco();
      } catch {
        if (!parado) setSituacao("sem_camera");
      }
    })();

    return () => {
      parado = true;
      if (espera !== undefined) window.clearTimeout(espera);
      fluxo?.getTracks().forEach((t) => t.stop());
    };
  }, [digitando]);

  const enviarCodigo = (e: React.FormEvent) => {
    e.preventDefault();
    const limpo = codigo.trim();
    if (limpo.length > 0) aoLer(limpo);
  };

  if (digitando || situacao === "sem_camera") {
    return (
      <form className="leitor leitor--digitar" onSubmit={enviarCodigo}>
        {situacao === "sem_camera" && !digitando && (
          <p className="leitor__aviso">
            A câmera não abriu. Permita o uso da câmera nas configurações do navegador, ou digite o
            código impresso embaixo do QR.
          </p>
        )}
        <label className="campo">
          <span className="campo__rotulo">{rotuloDoCodigo}</span>
          <input
            className="campo__entrada campo__entrada--codigo"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCDE-FGHJK-MNPQR-STUVW"
            maxLength={30}
            autoFocus
          />
        </label>
        <div className="acoes">
          <button type="submit" className="botao botao--principal" disabled={desativado}>
            Conferir código
          </button>
          {situacao !== "sem_camera" && (
            <button type="button" className="botao" onClick={() => setDigitando(false)}>
              Voltar para a câmera
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="leitor">
      <div className="leitor__visor" aria-hidden="true">
        <video ref={video} className="leitor__video" muted playsInline />
        <span className="leitor__mira" />
      </div>
      <canvas ref={tela} hidden />
      <p className="leitor__instrucao" role="status">
        {situacao === "iniciando" ? "Abrindo a câmera…" : instrucao}
      </p>
      <button type="button" className="botao botao--discreto" onClick={() => setDigitando(true)}>
        O QR não lê? Digitar o código
      </button>
    </div>
  );
}
