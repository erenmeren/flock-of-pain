"use client";

import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon, Loader2, Play } from "lucide-react";
import { cn } from "cn";
import { IconTile, fmt } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  cost_per_completed: "Cost per completed",
};

/** +1 when a bigger number is better, -1 otherwise. */
export const direction = (k: string) => (k === "throughput_per_day" || k === "completion_rate" ? 1 : -1);

/** Fractions shown as percentages: rates and utilizations. */
export const isPct = (k: string) => k.endsWith("_rate") || k.includes("utilization") || k.startsWith("util_");

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

/** Glass card with an icon tile, title, optional subtitle, and either a link or custom `action` top right. */
export function Panel({ title, subtitle, icon, href, linkLabel = "Open", action, className, contentClassName, children }:
  { title: React.ReactNode; subtitle?: React.ReactNode; icon?: LucideIcon; href?: string; linkLabel?: string; action?: React.ReactNode; className?: string; contentClassName?: string; children: React.ReactNode }) {
  return (
    <Card className={cn("rise", className)}>
      <CardHeader className="items-center">
        <div className="flex items-center gap-3">
          {icon && <IconTile icon={icon} />}
          <div className="flex flex-col">
            <CardTitle>{title}</CardTitle>
            {subtitle && <CardDescription className="text-xs">{subtitle}</CardDescription>}
          </div>
        </div>
        {(action || href) && (
          <CardAction className="row-span-1 self-center">
            {action ?? <Link href={href!} className={buttonVariants({ variant: "outline", size: "sm", className: "rounded-full" })}>{linkLabel} <ArrowRight className="size-3.5" /></Link>}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

export function NoResult({ run, busy, disabled }: { run: () => void; busy: boolean; disabled?: boolean }) {
  return (
    <div className="rise rounded-2xl border border-dashed border-border">
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">No simulation result yet. Run the scenarios to see KPIs, deltas and the blocked-time ledger.</p>
        <Button onClick={run} disabled={busy || disabled}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run Simulation
        </Button>
      </div>
    </div>
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
