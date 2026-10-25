"use client";

import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Loader2, Play } from "lucide-react";
import { cn } from "cn";
import { fmt } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ScenarioResult } from "@/lib/api";
import type { ResultSource } from "@/lib/store";

/** KPIs every result carries; any other key is a per-department utilization. */
export const BASE_KPIS = [
  "throughput_per_day", "completion_rate", "cycle_p50", "cycle_p90", "wait_p90",
  "sla_breach_rate", "rework_rate", "mean_dept_utilization", "labor_cost",
];

export const KPI_LABEL: Record<string, string> = {
  throughput_per_day: "Throughput / day",
  completion_rate: "Completion rate",
  cycle_p50: "Cycle time p50 (min)",
  cycle_p90: "Cycle time p90 (min)",
  wait_p90: "Wait p90 (min)",
  sla_breach_rate: "SLA breach rate",
  rework_rate: "Rework rate",
  mean_dept_utilization: "Mean utilization",
  labor_cost: "Labor cost",
};

/** +1 when a bigger number is better, -1 otherwise. */
export const direction = (k: string) => (k === "throughput_per_day" || k === "completion_rate" ? 1 : -1);

/** Fractions shown as percentages: rates and utilizations. */
export const isPct = (k: string) => k.endsWith("_rate") || k.includes("utilization") || !BASE_KPIS.includes(k);

export const fmtKpi = (k: string, v: number | undefined) =>
  v === undefined ? "–" : isPct(k) ? `${fmt(v * 100)}%` : k === "labor_cost" ? Math.round(v).toLocaleString() : fmt(v);

export function sourceLabel(s: ResultSource | null) {
  if (!s) return "";
  return s.kind === "run" ? `Last run: ${s.name}` : `History run #${s.run_id}: ${s.name}`;
}

/** Change vs baseline: percentage points for fractions, relative % otherwise (null when the baseline is 0). */
export function Delta({ k, value, base }: { k: string; value?: number; base?: number }) {
  if (value === undefined || base === undefined) return <span className="text-muted-foreground">–</span>;
  const pct = isPct(k);
  const d = pct ? (value - base) * 100 : base === 0 ? null : ((value - base) / Math.abs(base)) * 100;
  if (d === null) return <span className="text-muted-foreground">–</span>;
  const score = Math.sign(value - base) * direction(k);
  const Icon = d > 0 ? ArrowUpRight : d < 0 ? ArrowDownRight : ArrowRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums", score > 0 ? "text-emerald-400" : score < 0 ? "text-rose-400" : "text-muted-foreground")}>
      <Icon className="size-3.5" />
      {d > 0 ? "+" : ""}{d.toFixed(1)}{pct ? " pp" : "%"}
    </span>
  );
}

/** Tiny bar sparkline: first value is the baseline (muted), the rest use --chart-1. */
export function MiniBars({ values }: { values: number[] }) {
  const max = Math.max(...values.map(Math.abs), 1e-9);
  return (
    <div className="flex h-8 items-end gap-1" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className={cn("w-2.5 rounded-sm", i === 0 ? "bg-muted-foreground/40" : "bg-chart-1 shadow-[0_0_6px_var(--chart-1)]")}
          style={{ height: `${Math.max(6, (Math.abs(v) / max) * 100)}%` }} />
      ))}
    </div>
  );
}

/** Card with a title and an optional "open" link in the corner. */
export function Panel({ title, href, linkLabel = "Open", className, children }: { title: string; href?: string; linkLabel?: string; className?: string; children: React.ReactNode }) {
  return (
    <Card className={cn("bg-card/80 backdrop-blur", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {href && <CardAction><Link href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>{linkLabel} <ArrowRight className="size-3.5" /></Link></CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function NoResult({ run, busy, disabled }: { run: () => void; busy: boolean; disabled?: boolean }) {
  return (
    <Card className="border border-dashed border-border bg-transparent ring-0">
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">No simulation result yet. Run the scenarios to see KPIs, deltas and the blocked-time ledger.</p>
        <Button onClick={run} disabled={busy || disabled} className="shadow-[0_0_18px_-2px_var(--primary)]">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run Simulation
        </Button>
      </CardContent>
    </Card>
  );
}

export function LedgerTable({ s }: { s: ScenarioResult }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Off-shift minutes: <span className="tabular-nums text-foreground">{fmt(s.off_shift_minutes)}</span></p>
      {s.ledger.length === 0 ? <p className="text-sm text-muted-foreground">No blocked time.</p> : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>Department</TableHead><TableHead>Reason</TableHead><TableHead>Blocker</TableHead><TableHead className="text-right">Minutes</TableHead><TableHead className="text-right">Count</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {s.ledger.map((r, i) => (
              <TableRow key={i}>
                <TableCell>{r.department_id}</TableCell><TableCell>{r.reason ?? ""}</TableCell><TableCell>{r.blocker_id ?? ""}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.minutes)}</TableCell><TableCell className="text-right tabular-nums">{r.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

const resultIds = new WeakMap<object, number>();
let nextResultId = 0;
/** Stable key per result object, so children with local state (Playback) reset on every new result. */
export function resultKey(result: object) {
  if (!resultIds.has(result)) resultIds.set(result, ++nextResultId);
  return String(resultIds.get(result));
}
