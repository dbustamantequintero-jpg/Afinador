/**
 * Prueba del algoritmo YIN de src/lib/tuner/audio.ts con señales sintéticas:
 * - seno puro en cada frecuencia de cuerda
 * - señal con armónicos (como cuerda pulsada) + ruido
 * - señales que deben rechazarse (silencio, ruido puro)
 */
import {
  detectPitch,
  GUITAR_STRINGS,
  nearestString,
  centsBetween,
  nearestNote,
} from "../src/lib/tuner/audio";

const SR = 44100;
const N = 2048;

function makeSine(freq: number, phase = 0): Float32Array {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    buf[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  }
  return buf;
}

/** Cuerda pulsada: fundamental + armónicos decayentes + ruido ligero */
function makeStringLike(freq: number): Float32Array {
  const buf = new Float32Array(N);
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1073741823) / 1073741823;
  };
  const harmonics: Array<[number, number]> = [
    [1, 1.0],
    [2, 0.55],
    [3, 0.3],
    [4, 0.18],
    [5, 0.1],
    [6, 0.06],
  ];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = 0;
    for (const [mult, amp] of harmonics) {
      v += amp * Math.sin(2 * Math.PI * freq * mult * t);
    }
    buf[i] = 0.4 * v + 0.004 * rand();
  }
  return buf;
}

let pass = 0;
let fail = 0;
const results: string[] = [];

function expect(freq: number, buf: Float32Array, label: string) {
  const res = detectPitch(buf, SR);
  if (res.frequency < 0) {
    fail++;
    results.push(`FAIL ${label}: sin detección (clarity=${res.clarity.toFixed(2)})`);
    return;
  }
  const err = Math.abs(res.frequency - freq);
  const cents = centsBetween(res.frequency, freq);
  const ok = err < Math.max(0.35, freq * 0.004); // < 0.4 Hz o < 0.4%
  if (ok) {
    pass++;
    results.push(
      `PASS ${label}: esperado=${freq.toFixed(2)} detectado=${res.frequency.toFixed(2)} err=${err.toFixed(3)}Hz (${cents >= 0 ? "+" : ""}${cents.toFixed(1)}¢) clarity=${res.clarity.toFixed(2)}`,
    );
  } else {
    fail++;
    results.push(`FAIL ${label}: esperado=${freq.toFixed(2)} detectado=${res.frequency.toFixed(2)} err=${err.toFixed(2)}Hz`);
  }
}

// 1) Seno puro en cada cuerda
for (const s of GUITAR_STRINGS) expect(s.frequency, makeSine(s.frequency), `seno ${s.note}${s.octave}`);

// 2) Señal tipo cuerda (con armónicos) en cada cuerda
for (const s of GUITAR_STRINGS) expect(s.frequency, makeStringLike(s.frequency), `cuerda ${s.note}${s.octave}`);

// 3) Desafinaciones típicas: ±20 y ±45 cents sobre A2
for (const cents of [-45, -20, 20, 45]) {
  const f = 110 * Math.pow(2, cents / 1200);
  expect(f, makeStringLike(f), `A2 ${cents >= 0 ? "+" : ""}${cents}¢`);
}

// 4) Casos que deben rechazarse
const silence = new Float32Array(N);
const rSil = detectPitch(silence, SR);
if (rSil.frequency === -1) { pass++; results.push("PASS silencio: rechazado"); } else { fail++; results.push(`FAIL silencio: detectó ${rSil.frequency}`); }

const noise = new Float32Array(N);
let seed = 7;
for (let i = 0; i < N; i++) { seed = (seed * 16807) % 2147483647; noise[i] = ((seed - 1073741823) / 1073741823) * 0.3; }
const rNoise = detectPitch(noise, SR);
if (rNoise.frequency === -1) { pass++; results.push("PASS ruido puro: rechazado"); } else { fail++; results.push(`FAIL ruido puro: detectó ${rNoise.frequency.toFixed(1)}`); }

// 5) Nearest string: comprobar que 110.5 Hz mapea a A2 y 82.0 a E2 con cents correctos
const mA = nearestString(110.5);
if (mA && mA.string.id === "a2" && Math.abs(mA.cents - centsBetween(110.5, 110)) < 0.1) { pass++; results.push(`PASS nearestString(110.5) = ${mA.string.id} (${mA.cents.toFixed(1)}¢)`); } else { fail++; results.push(`FAIL nearestString(110.5) = ${mA?.string.id} ${mA?.cents}`); }

const mE = nearestString(82.0);
if (mE && mE.string.id === "e2") { pass++; results.push(`PASS nearestString(82.0) = ${mE.string.id} (${mE.cents.toFixed(1)}¢)`); } else { fail++; results.push(`FAIL nearestString(82.0) = ${mE?.string.id} ${mE?.cents}`); }

// 6) nearestNote para la nota mostrada
const nn = nearestNote(146.9);
if (nn.name === "D" && nn.octave === 3) { pass++; results.push("PASS nearestNote(146.9) = D3"); } else { fail++; results.push(`FAIL nearestNote(146.9) = ${nn.name}${nn.octave}`); }

console.log(results.join("\n"));
console.log(`\n${pass} pasan, ${fail} fallan`);
if (fail > 0) process.exit(1);
