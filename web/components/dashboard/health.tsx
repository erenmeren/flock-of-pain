"use client";

import { cn } from "cn";

const R = 50, CX = 60, CY = 62, LEN = Math.PI * R;

/** Half-ring gauge with a red→green sweep; `score` null draws an empty ring. */
export function Gauge({ score, label, className }: { score: number | null; label: string; className?: string }) {
  const s = score ?? 0;
  const angle = Math.PI * (1 - s / 100);
  const dot = { x: CX + R * Math.cos(angle), y: CY - R * Math.sin(angle) };
  return (
    <div className={cn("relative mx-auto w-full max-w-56", className)}>
      <svg viewBox="0 0 120 70" className="block w-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id="gauge-sweep" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--chart-4)" /><stop offset="0.5" stopColor="var(--chart-2)" /><stop offset="1" stopColor="var(--chart-3)" />
          </linearGradient>
        </defs>
        <path d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`} fill="none" stroke="oklch(1 0 0 / 0.1)" strokeWidth="10" strokeLinecap="round" />
        {score !== null && (
          <>
            <path d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`} fill="none" stroke="url(#gauge-sweep)" strokeWidth="10" strokeLinecap="round"
              strokeDasharray={LEN} strokeDashoffset={LEN * (1 - s / 100)} style={{ transition: "stroke-dashoffset 600ms var(--ease-out)", filter: "drop-shadow(0 0 6px oklch(0.7 0.17 150 / 0.5))" }} />
            <circle cx={dot.x} cy={dot.y} r="5" fill="white" style={{ transition: "cx 600ms var(--ease-out), cy 600ms var(--ease-out)", filter: "drop-shadow(0 0 6px white)" }} />
          </>
        )}
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center leading-none">
        <span className="text-4xl font-semibold tabular-nums tracking-tight">{score ?? "–"}</span>
        <span className="mt-1 text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}
