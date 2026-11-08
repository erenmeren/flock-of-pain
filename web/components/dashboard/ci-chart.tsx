"use client";

import { cn } from "cn";

export type CiPoint = { label: string; mean?: number; low?: number; high?: number; muted?: boolean; note?: string };

/** Hand-rolled columns in the style of Bars: mean as a glowing bar, 95% interval as a whisker, optional dashed target line. */
export function CiChart({ title, points, fmtV, color = "var(--chart-1)", target }: { title: string; points: CiPoint[]; fmtV: (v: number | undefined) => string; color?: string; target?: number }) {
  const max = Math.max(...points.flatMap((p) => [p.mean ?? 0, p.high ?? 0]), target ?? 0, 1e-9);
  const pos = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl glass-inset p-3" role="img"
      aria-label={`${title}: ${points.map((p) => `${p.label} ${fmtV(p.mean)}`).join(", ")}${target === undefined ? "" : `; target ${fmtV(target)}`}`}>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</span>
      <div className="flex gap-1 overflow-x-auto" aria-hidden>
        {points.map((p, i) => (
          <div key={i} className="flex min-w-12 flex-1 flex-col items-center gap-1 text-[11px]">
            <span className="whitespace-nowrap tabular-nums">{fmtV(p.mean)}</span>
            <div className="relative h-28 w-full border-b border-border">
              {p.mean !== undefined && (
                <span className="absolute bottom-0 left-1/2 w-3 -translate-x-1/2 rounded-t-[3px] motion-safe:transition-[height] motion-safe:duration-300"
                  style={{ height: pos(p.mean), background: p.muted ? "oklch(1 0 0 / 0.22)" : color, boxShadow: p.muted ? undefined : `0 0 8px ${color}` }} />
              )}
              {p.low !== undefined && p.high !== undefined && p.high > p.low && (
                <span className="absolute left-1/2 w-2 -translate-x-1/2 border-y border-foreground/80" style={{ bottom: pos(p.low), height: `calc(${pos(p.high)} - ${pos(p.low)})` }}>
                  <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-foreground/80" />
                </span>
              )}
              {target !== undefined && <span className="absolute inset-x-0 border-t border-dashed border-amber-400/80" style={{ bottom: pos(target) }} />}
            </div>
            <span className="max-w-full truncate tabular-nums text-muted-foreground" title={p.label}>{p.label}</span>
            {p.note && <span className={cn("text-center text-[10px] leading-tight", p.note === "significant" ? "text-foreground" : "text-muted-foreground")}>{p.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
