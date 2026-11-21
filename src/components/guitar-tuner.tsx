"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Guitar,
  LoaderCircle,
  Mic,
  MicOff,
  Play,
  Square,
  Target,
  Volume2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TunerGauge } from "@/components/tuner/gauge";
import {
  GUITAR_STRINGS,
  centsBetween,
  detectPitch,
  nearestNote,
  nearestString,
  stringById,
  type GuitarString,
} from "@/lib/tuner/audio";

type MicState = "idle" | "starting" | "on" | "error";

interface Reading {
  active: boolean;
  frequency: number;
  cents: number;
  noteName: string;
  noteOctave: number;
  level: number;
}

const IDLE_READING: Reading = {
  active: false,
  frequency: 0,
  cents: 0,
  noteName: "—",
  noteOctave: 0,
  level: 0,
};

const TONE_HOLD_MS = 4000;

export default function GuitarTuner() {
  const [micState, setMicState] = useState<MicState>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading>(IDLE_READING);
  const [manualId, setManualId] = useState<string | null>(null);
  const [autoId, setAutoId] = useState<string | null>(null);
  const [tonePlayingId, setTonePlayingId] = useState<string | null>(null);

  // Referencias de audio y bucle de detección
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const rafRef = useRef<number>(0);
  const lastUiRef = useRef<number>(0);
  const smoothRef = useRef({ cents: 0, freq: 0, hadPitch: false });
  const holdRef = useRef({ lastPitchAt: 0, candidateId: "", candidateCount: 0 });
  const manualRef = useRef<string | null>(null);
  const autoRef = useRef<string | null>(null);
  const toneRef = useRef<{
    osc: OscillatorNode | null;
    gain: GainNode | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ osc: null, gain: null, timer: null });

  useEffect(() => {
    manualRef.current = manualId;
  }, [manualId]);
  useEffect(() => {
    autoRef.current = autoId;
  }, [autoId]);

  /** Detiene el tono de referencia (si está sonando) */
  const stopTone = useCallback(() => {
    const t = toneRef.current;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (t.osc) {
      try {
        t.osc.stop();
        t.osc.disconnect();
      } catch {
        // ya estaba detenido
      }
    }
    if (t.gain) t.gain.disconnect();
    t.osc = null;
    t.gain = null;
    setTonePlayingId(null);
  }, []);

  /** Reproduce la frecuencia de una cuerda como tono de referencia */
  const playTone = useCallback(
    (s: GuitarString) => {
      stopTone();
      const ctx = ensureAudioContext(ctxRef);
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = s.frequency;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.03);
      gain.gain.setValueAtTime(0.25, now + TONE_HOLD_MS / 1000 - 0.25);
      gain.gain.linearRampToValueAtTime(0, now + TONE_HOLD_MS / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      const timer = setTimeout(stopTone, TONE_HOLD_MS);
      toneRef.current = { osc, gain, timer };
      setTonePlayingId(s.id);
    },
    [stopTone],
  );

  /** Detiene el micrófono y el bucle de detección */
  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    setReading(IDLE_READING);
    setAutoId(null);
    holdRef.current = { lastPitchAt: 0, candidateId: "", candidateCount: 0 };
    smoothRef.current = { cents: 0, freq: 0, hadPitch: false };
    setMicState("idle");
  }, []);

  /** Activa el micrófono y arranca el bucle de detección */
  const startMic = useCallback(async () => {
    setMicError(null);
    setMicState("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(
          "Este navegador no expone acceso al micrófono.",
          "NotSupportedError",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const ctx = ensureAudioContext(ctxRef);
      if (!ctx) throw new Error("No se pudo crear el contexto de audio.");

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      analyserRef.current = analyser;
      bufRef.current = new Float32Array(analyser.fftSize);
      setMicState("on");

      const loop = (now: number) => {
        rafRef.current = requestAnimationFrame(loop);
        if (now - lastUiRef.current < 50) return; // ~20 Hz de actualización
        lastUiRef.current = now;
        const an = analyserRef.current;
        const buf = bufRef.current;
        const audioCtx = ctxRef.current;
        if (!an || !buf || !audioCtx) return;

        an.getFloatTimeDomainData(buf);
        const res = detectPitch(buf, audioCtx.sampleRate);
        const hold = holdRef.current;

        if (res.frequency > 0 && res.clarity > 0.55) {
          hold.lastPitchAt = now;
          const match = nearestString(res.frequency);
          if (match) {
            if (hold.candidateId === match.string.id) hold.candidateCount++;
            else {
              hold.candidateId = match.string.id;
              hold.candidateCount = 1;
            }
            if (hold.candidateCount >= 2 && autoRef.current !== match.string.id) {
              setAutoId(match.string.id);
            }
          }

          // Referencia: cuerda fijada manualmente, si no la detectada
          const manual = manualRef.current ? stringById(manualRef.current) : null;
          const refFreq = manual
            ? manual.frequency
            : (match?.string.frequency ?? nearestNote(res.frequency).frequency);
          const rawCents = centsBetween(res.frequency, refFreq);

          const sm = smoothRef.current;
          if (!sm.hadPitch) {
            sm.cents = rawCents;
            sm.freq = res.frequency;
            sm.hadPitch = true;
          } else {
            sm.cents += (rawCents - sm.cents) * 0.45;
            sm.freq += (res.frequency - sm.freq) * 0.35;
          }

          const note = nearestNote(sm.freq);
          setReading({
            active: true,
            frequency: sm.freq,
            cents: sm.cents,
            noteName: note.name,
            noteOctave: note.octave,
            level: Math.min(1, res.rms * 4),
          });
        } else if (now - hold.lastPitchAt > 350) {
          smoothRef.current.hadPitch = false;
          setReading((prev) =>
            prev.active || prev.level > 0.01
              ? { ...prev, active: false, level: res.rms * 4 }
              : { ...prev, level: res.rms * 4 },
          );
        }
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      const e = err as DOMException;
      let msg: string;
      switch (e.name) {
        case "NotAllowedError":
        case "SecurityError":
          msg =
            "Permiso de micrófono denegado. Haz clic en el icono de cámara/micrófono de la barra de direcciones y permite el acceso.";
          break;
        case "NotFoundError":
        case "OverconstrainedError":
          msg = "No se encontró ningún micrófono conectado.";
          break;
        default:
          msg =
            "No se pudo acceder al micrófono. Si estás en la vista previa integrada, abre la app en una pestaña nueva e inténtalo de nuevo.";
      }
      setMicError(msg);
      setMicState("error");
      stopMic();
    }
  }, [stopMic]);

  // Limpieza al desmontar
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      stopTone();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stopTone]);

  const micOn = micState === "on";
  const manualString = manualId ? stringById(manualId) : null;
  const detectedString = manualString ?? (autoId ? stringById(autoId) : null);
  const inTune = reading.active && Math.abs(reading.cents) <= 3;
  const centsLabel = reading.active
    ? `${reading.cents >= 0 ? "+" : "−"}${Math.abs(Math.round(reading.cents))}¢`
    : "—";
  const freqLabel = reading.active
    ? `${reading.frequency.toFixed(1)} Hz`
    : "— Hz";

  function statusMessage(): { text: string; className: string } {
    if (!micOn) {
      return { text: "Activa el micrófono para empezar", className: "bg-zinc-800 text-zinc-400" };
    }
    if (!reading.active) {
      return { text: "Toca una cuerda y déjala sonar", className: "bg-zinc-800 text-zinc-400" };
    }
    if (inTune) {
      return { text: "¡Afinada!", className: "bg-emerald-500 text-emerald-950" };
    }
    const far = Math.abs(reading.cents) > 25;
    if (reading.cents < 0) {
      return {
        text: "Muy grave · aprieta la clavija",
        className: far ? "bg-rose-500/90 text-rose-950" : "bg-amber-400 text-amber-950",
      };
    }
    return {
      text: "Muy aguda · afloja la clavija",
      className: far ? "bg-rose-500/90 text-rose-950" : "bg-amber-400 text-amber-950",
    };
  }
  const status = statusMessage();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Encabezado */}
      <header className="border-b border-zinc-800/80 bg-zinc-900/60">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
            <Guitar className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Afinador de Guitarra</h1>
            <p className="text-xs text-zinc-400">
              Afinación estándar E·A·D·G·B·E — procesado local en tu navegador
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 flex flex-col gap-5">
        {/* Medidor */}
        <section
          aria-label="Medidor de afinación"
          className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6 flex flex-col items-center gap-2"
        >
          <TunerGauge cents={reading.cents} active={reading.active} inTune={inTune} />

          <div
            className={cn(
              "flex items-baseline gap-2 transition-opacity",
              reading.active ? "opacity-100" : "opacity-50",
            )}
          >
            <span
              className={cn(
                "text-6xl sm:text-7xl font-extrabold tracking-tight leading-none",
                inTune ? "text-emerald-400" : "text-zinc-100",
              )}
            >
              {reading.noteName}
            </span>
            {reading.active && (
              <span className="text-xl sm:text-2xl font-semibold text-zinc-400">
                {reading.noteOctave}
              </span>
            )}
          </div>

          <p className="text-sm font-mono text-zinc-400" aria-live="polite">
            {freqLabel} · {centsLabel}
          </p>

          <div
            role="status"
            className={cn(
              "mt-1 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors",
              status.className,
            )}
          >
            {status.text}
          </div>

          {/* Nivel de señal */}
          <div className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500/70 transition-[width] duration-100"
              style={{ width: `${Math.min(100, reading.level * 100)}%` }}
            />
          </div>

          {/* Control de micrófono */}
          <button
            type="button"
            onClick={() => (micOn ? stopMic() : startMic())}
            disabled={micState === "starting"}
            className={cn(
              "mt-4 inline-flex min-h-11 items-center gap-2 rounded-full px-6 text-sm font-bold transition-colors",
              micOn
                ? "bg-rose-500/90 text-rose-950 hover:bg-rose-500"
                : "bg-emerald-500 text-emerald-950 hover:bg-emerald-400",
              micState === "starting" && "opacity-60",
            )}
            aria-pressed={micOn}
          >
            {micState === "starting" ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                Activando…
              </>
            ) : micOn ? (
              <>
                <MicOff className="h-4 w-4" aria-hidden="true" />
                Detener micrófono
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" aria-hidden="true" />
                Activar micrófono
              </>
            )}
          </button>

          {micError && (
            <div
              role="alert"
              className="mt-2 w-full rounded-xl border border-rose-900/60 bg-rose-950/50 px-4 py-3 text-sm text-rose-200"
            >
              {micError}
            </div>
          )}
        </section>

        {/* Cuerdas */}
        <section aria-label="Cuerdas de la guitarra" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-300">
              Cuerdas {micOn ? "" : "(pulsa una para fijar el objetivo)"}
            </h2>
            {manualString ? (
              <button
                type="button"
                onClick={() => setManualId(null)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-3 text-xs font-semibold text-amber-400 hover:bg-amber-500/20"
              >
                <Target className="h-3.5 w-3.5" aria-hidden="true" />
                Fijada: {manualString.note}
                {manualString.octave} · quitar
              </button>
            ) : (
              <span className="rounded-full border border-emerald-700/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400">
                Detección automática
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {GUITAR_STRINGS.map((s) => {
              const isAuto = !manualId && autoId === s.id && micOn;
              const isManual = manualId === s.id;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "overflow-hidden rounded-xl border bg-zinc-900/70 transition-colors",
                    isManual
                      ? "border-amber-500/70 ring-1 ring-amber-500/50"
                      : isAuto
                        ? "border-emerald-500/70 ring-1 ring-emerald-500/40"
                        : "border-zinc-800",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setManualId(isManual ? null : s.id)}
                    className="flex min-h-24 w-full flex-col items-center justify-center gap-0.5 px-2 py-2"
                    aria-pressed={isManual}
                    aria-label={`Fijar objetivo en cuerda ${s.number}, ${s.note}${s.octave}`}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                      {s.number}ª
                    </span>
                    <span className="text-2xl font-extrabold leading-none">
                      {s.note}
                      <span className="text-sm font-bold text-zinc-500">{s.octave}</span>
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">
                      {s.frequency.toFixed(1)} Hz
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      tonePlayingId === s.id ? stopTone() : playTone(s)
                    }
                    className={cn(
                      "flex min-h-9 w-full items-center justify-center gap-1.5 border-t text-[11px] font-semibold transition-colors",
                      tonePlayingId === s.id
                        ? "border-emerald-700/60 bg-emerald-500/20 text-emerald-300"
                        : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200",
                    )}
                    aria-label={
                      tonePlayingId === s.id
                        ? `Detener tono de referencia de la cuerda ${s.number}`
                        : `Reproducir tono de referencia de la cuerda ${s.number}, ${s.note}${s.octave}`
                    }
                  >
                    {tonePlayingId === s.id ? (
                      <>
                        <Square className="h-3 w-3" aria-hidden="true" /> Detener
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-3 w-3" aria-hidden="true" /> Tono
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {detectedString && (
            <p className="text-center text-xs text-zinc-500">
              {manualString
                ? `Objetivo fijado en la cuerda ${manualString.number}ª (${manualString.note}${manualString.octave})`
                : `Cuerda detectada: ${detectedString.number}ª (${detectedString.note}${detectedString.octave})`}
            </p>
          )}
        </section>

        {/* Consejos */}
        <section
          aria-label="Consejos de afinación"
          className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4"
        >
          <h2 className="mb-2 text-sm font-semibold text-zinc-300">
            Consejos para afinar
          </h2>
          <ul className="list-inside list-disc space-y-1 text-sm text-zinc-400">
            <li>Toca una cuerda a la vez y déjala sonar; el medidor responderá enseguida.</li>
            <li>
              Si la aguja se queda a la izquierda (grave), aprieta la clavija; si se
              queda a la derecha (agudo), afloja un poco.
            </li>
            <li>Entra en la zona verde: la desviación es de ±3 cents o menos.</li>
            <li>
              Afina en un lugar silencioso y acércate al micrófono: capta cualquier
              ruido de fondo.
            </li>
            <li>
              ¿Oído entrenado? Pulsa «Tono» en una cuerda y afina comparando el
              sonido.
            </li>
          </ul>
        </section>
      </main>

      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-900/60">
        <p className="mx-auto max-w-2xl px-4 py-3 text-center text-xs text-zinc-500">
          El audio se procesa localmente en tu navegador con la Web Audio API.
          No se graba ni se envía nada.
        </p>
      </footer>
    </div>
  );
}

/** Crea (una única vez) el AudioContext compartido y lo reanuda si está suspendido */
function ensureAudioContext(
  ctxRef: React.RefObject<AudioContext | null>,
): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctxRef.current) ctxRef.current = new Ctor();
  if (ctxRef.current.state === "suspended") {
    ctxRef.current.resume().catch(() => {});
  }
  return ctxRef.current;
}
