"use client";

import { cn } from "@/lib/utils";

interface GaugeProps {
  /** Desviación en cents, se recorta a [-50, 50] */
  cents: number;
  /** true si hay tono detectado recientemente */
  active: boolean;
  /** true si |cents| <= 3 (en la zona verde) */
  inTune: boolean;
}

const CX = 110;
const CY = 112;
const R = 88;
const MIN = -50;
const MAX = 50;

/** Polar a partir de cents: -50 = izquierda, 0 = arriba, +50 = derecha */
function polar(cents: number, radius: number): { x: number; y: number } {
  const angle = (cents / 50) * 90;
  const rad = ((angle - 90) * Math.PI) / 180;
  return {
    x: CX + radius * Math.cos(rad),
    y: CY + radius * Math.sin(rad),
  };
}

function arcPath(fromCents: number, toCents: number, radius: number): string {
  const a = polar(fromCents, radius);
  const b = polar(toCents, radius);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function TunerGauge({ cents, active, inTune }: GaugeProps) {
  const clamped = Math.min(MAX, Math.max(MIN, cents));
  const NEEDLE_LEN = R - 20;

  const minorTicks: number[] = [];
  for (let c = MIN; c <= MAX; c += 5) minorTicks.push(c);
  const majorTicks = [-50, -25, 0, 25, 50];

  return (
    <svg
      viewBox="0 0 220 126"
      className="w-full max-w-md"
      role="img"
      aria-label={`Medidor de afinación: desviación ${clamped >= 0 ? "+" : ""}${Math.round(clamped)} cents`}
    >
      {/* Arco de fondo */}
      <path
        d={arcPath(MIN, MAX, R)}
        fill="none"
        stroke="currentColor"
        className="text-zinc-800"
        strokeWidth={10}
        strokeLinecap="round"
      />
      {/* Zonas: lejos (rosado) y en tono (verde) */}
      <path
        d={arcPath(MIN, -6, R)}
        fill="none"
        className="stroke-rose-500/40"
        strokeWidth={10}
      />
      <path
        d={arcPath(6, MAX, R)}
        fill="none"
        className="stroke-rose-500/40"
        strokeWidth={10}
      />
      <path
        d={arcPath(-5, 5, R)}
        fill="none"
        className={cn(
          "stroke-emerald-500",
          active && inTune && "drop-shadow-[0_0_6px_rgba(16,185,129,0.8)]",
        )}
        strokeWidth={10}
        strokeLinecap="round"
      />

      {/* Marcas menores cada 5 cents */}
      {minorTicks.map((c) => {
        const a = polar(c, R - 9);
        const b = polar(c, R - 15);
        const isMajor = majorTicks.includes(c);
        if (isMajor) return null;
        return (
          <line
            key={c}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className="stroke-zinc-600"
            strokeWidth={1.5}
          />
        );
      })}

      {/* Marcas mayores cada 25 cents */}
      {majorTicks.map((c) => {
        const a = polar(c, R - 9);
        const b = polar(c, R - 18);
        return (
          <line
            key={c}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className="stroke-zinc-400"
            strokeWidth={2.5}
          />
        );
      })}

      {/* Etiquetas */}
      {majorTicks.map((c) => {
        const p = polar(c, R + 9);
        return (
          <text
            key={c}
            x={p.x}
            y={p.y + 3}
            textAnchor="middle"
            className="fill-zinc-500 text-[9px] font-medium"
          >
            {c > 0 ? `+${c}` : c}
          </text>
        );
      })}
      <text
        x={CX}
        y={122}
        textAnchor="middle"
        className="fill-zinc-600 text-[8px]"
      >
        desviación en cents
      </text>

      {/* Aguja */}
      <g
        style={{
          transform: `rotate(${(clamped / 50) * 90}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          transition: "transform 120ms linear",
        }}
        className={cn(
          active ? "opacity-100" : "opacity-35",
          inTune && active ? "stroke-emerald-400" : "stroke-zinc-200",
        )}
      >
        <line
          x1={CX}
          y1={CY}
          x2={CX}
          y2={CY - NEEDLE_LEN}
          strokeWidth={3.5}
          strokeLinecap="round"
        />
      </g>

      {/* Pivote */}
      <circle
        cx={CX}
        cy={CY}
        r={6}
        className={cn(
          active
            ? inTune
              ? "fill-emerald-400"
              : "fill-amber-400"
            : "fill-zinc-600",
        )}
      />
    </svg>
  );
}
