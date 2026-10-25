import type { LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent } from "@/components/ui/card";

/** Page title row shared by every screen. */
export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** Small rounded square holding an icon; `color` tints the icon (defaults to the primary blue). */
export function IconTile({ icon: Icon, color, className }: { icon: LucideIcon; color?: string; className?: string }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg glass-inset", className)} style={{ color: color ?? "var(--primary)" }} aria-hidden>
      <Icon className="size-4" />
    </span>
  );
}

/** Tiny bar sparkline; `baseline` mutes the first bar. */
export function Bars({ values, color = "var(--chart-1)", baseline = true, className }: { values: number[]; color?: string; baseline?: boolean; className?: string }) {
  const max = Math.max(...values.map(Math.abs), 1e-9);
  return (
    <div className={cn("flex h-9 items-end gap-1", className)} aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="w-2 rounded-[3px] transition-[height] duration-300"
          style={{ height: `${Math.max(10, (Math.abs(v) / max) * 100)}%`, background: baseline && i === 0 ? "oklch(1 0 0 / 0.22)" : color, boxShadow: baseline && i === 0 ? undefined : `0 0 8px ${color}` }} />
      ))}
    </div>
  );
}

/** One number with a label. `delta` is a signed percentage vs the baseline; `bars` draws a sparkline beside the value. */
export function StatCard({ icon, label, value, hint, delta, bars, className }: { icon?: LucideIcon; label: string; value: React.ReactNode; hint?: React.ReactNode; delta?: number | null; bars?: number[]; className?: string }) {
  const good = delta !== undefined && delta !== null && delta > 0;
  return (
    <Card size="sm" className={cn("rise", className)}>
      <CardContent className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon && <IconTile icon={icon} className="size-6 rounded-md [&_svg]:size-3.5" />}
          {label}
        </span>
        <span className="flex items-end justify-between gap-3">
          <span className="text-3xl font-semibold tabular-nums leading-none tracking-tight">{value}</span>
          {bars && <Bars values={bars} />}
        </span>
        {delta !== undefined && delta !== null && (
          <span className={cn("text-xs tabular-nums", good ? "text-emerald-400" : delta < 0 ? "text-rose-400" : "text-muted-foreground")}>
            {delta > 0 ? "+" : ""}{delta.toFixed(1)}% vs baseline
          </span>
        )}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  );
}

export const fmt = (n: number | undefined | null, digits = 1) => (n === undefined || n === null || !Number.isFinite(n) ? "–" : n.toFixed(digits));
