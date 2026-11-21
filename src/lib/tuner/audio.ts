/**
 * Utilidades de afinación: detección de tono (algoritmo YIN),
 * matemática de notas y datos de las cuerdas de la guitarra.
 * Todo el procesamiento ocurre en el navegador (client-side).
 */

export interface GuitarString {
  id: string;
  note: string;
  octave: number;
  /** Número de cuerda: 1 = la más aguda (E4), 6 = la más grave (E2) */
  number: number;
  /** Frecuencia de referencia en Hz (afinación estándar, A4 = 440 Hz) */
  frequency: number;
}

export const GUITAR_STRINGS: GuitarString[] = [
  { id: "e2", note: "E", octave: 2, number: 6, frequency: 82.41 },
  { id: "a2", note: "A", octave: 2, number: 5, frequency: 110.0 },
  { id: "d3", note: "D", octave: 3, number: 4, frequency: 146.83 },
  { id: "g3", note: "G", octave: 3, number: 3, frequency: 196.0 },
  { id: "b3", note: "B", octave: 3, number: 2, frequency: 246.94 },
  { id: "e4", note: "E", octave: 4, number: 1, frequency: 329.63 },
];

export const A4 = 440;
export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/** Convierte frecuencia (Hz) a número MIDI */
export function freqToMidi(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / A4);
}

/** Convierte número MIDI a frecuencia (Hz) */
export function midiToFreq(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

/** Diferencia en cents entre dos frecuencias (positivo = más agudo) */
export function centsBetween(frequency: number, reference: number): number {
  return 1200 * Math.log2(frequency / reference);
}

export interface NearestNote {
  midi: number;
  name: string;
  octave: number;
  frequency: number;
}

/** Nota cromática más cercana a una frecuencia dada */
export function nearestNote(frequency: number): NearestNote {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return { midi: 0, name: "—", octave: 0, frequency: 0 };
  }
  const midi = Math.round(freqToMidi(frequency));
  return {
    midi,
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    frequency: midiToFreq(midi),
  };
}

/** Cuerda cuya frecuencia de referencia está más cerca de la señal */
export function nearestString(frequency: number): {
  string: GuitarString;
  cents: number;
} | null {
  let best: GuitarString | null = null;
  let bestCents = Infinity;
  for (const s of GUITAR_STRINGS) {
    const cents = centsBetween(frequency, s.frequency);
    if (Math.abs(cents) < Math.abs(bestCents)) {
      bestCents = cents;
      best = s;
    }
  }
  return best ? { string: best, cents: bestCents } : null;
}

export function stringById(id: string): GuitarString | undefined {
  return GUITAR_STRINGS.find((s) => s.id === id);
}

export interface PitchResult {
  /** Frecuencia detectada en Hz; -1 si no hay tono claro */
  frequency: number;
  /** 0..1 — confianza de la detección */
  clarity: number;
  /** Nivel RMS de la señal 0..1 */
  rms: number;
}

/**
 * Detecta el tono fundamental de un buffer temporal usando YIN
 * (diferencia de cuadrados + normalización acumulativa + umbral absoluto),
 * con interpolación parabólica para precisión sub-muestra.
 * Rango de búsqueda: 65–700 Hz (cubre todas las cuerdas y armónicos).
 */
export function detectPitch(
  buf: Float32Array,
  sampleRate: number,
): PitchResult {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.004) return { frequency: -1, clarity: 0, rms };

  const minFreq = 65;
  const maxFreq = 700;
  const maxTau = Math.min(Math.floor(sampleRate / minFreq), n - 2);
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  const windowSize = Math.min(n - maxTau, n >> 1);
  if (windowSize < minTau * 2) return { frequency: -1, clarity: 0, rms };

  // 1) Función de diferencia d(tau) = Σ (x[i] - x[i+tau])²
  const diff = new Float32Array(maxTau + 1);
  for (let tau = minTau; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const delta = buf[i] - buf[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // 2) Diferencia normalizada acumulativa d'(tau)
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[minTau] = 1;
  let runningSum = 0;
  for (let tau = minTau; tau <= maxTau; tau++) {
    runningSum += diff[tau];
    cmnd[tau] =
      runningSum === 0 ? 1 : (diff[tau] * (tau - minTau + 1)) / runningSum;
  }

  // 3) Umbral absoluto: primer mínimo local por debajo del umbral
  const threshold = 0.12;
  let tauEstimate = -1;
  for (let tau = minTau + 1; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  // Si nada baja del umbral, aceptar el mínimo global si es suficientemente bueno
  if (tauEstimate === -1) {
    let minVal = Infinity;
    let minIdx = -1;
    for (let tau = minTau + 1; tau <= maxTau; tau++) {
      if (cmnd[tau] < minVal) {
        minVal = cmnd[tau];
        minIdx = tau;
      }
    }
    if (minIdx > 0 && minVal < 0.45) {
      tauEstimate = minIdx;
    } else {
      const safe = minVal === Infinity ? 1 : minVal;
      return { frequency: -1, clarity: 1 - Math.min(1, safe), rms };
    }
  }

  // 4) Interpolación parabólica alrededor del mínimo
  const x = tauEstimate;
  const y1 = cmnd[x - 1] ?? cmnd[x];
  const y2 = cmnd[x];
  const y3 = cmnd[x + 1] ?? cmnd[x];
  let betterTau = x;
  const denom = y1 + y3 - 2 * y2;
  if (denom !== 0) {
    const shift = (y1 - y3) / (2 * denom);
    if (Math.abs(shift) < 1) betterTau = x + shift;
  }

  const frequency = sampleRate / betterTau;
  if (!Number.isFinite(frequency) || frequency < minFreq || frequency > maxFreq) {
    return { frequency: -1, clarity: 0, rms };
  }
  return { frequency, clarity: 1 - Math.min(1, cmnd[tauEstimate]), rms };
}
