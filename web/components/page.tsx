import { cn } from "cn";
import { Card, CardContent } from "@/components/ui/card";

/** Page title row shared by every screen. */
export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** One number with a label; `delta` is a signed percentage vs the baseline. */
export function StatCard({ label, value, hint, delta, className }: { label: string; value: React.ReactNode; hint?: string; delta?: number | null; className?: string }) {
  const good = delta !== undefined && delta !== null && delta > 0;
  return (
    <Card size="sm" className={cn("bg-[radial-gradient(circle_at_top_left,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_60%)]", className)}>
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
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
