"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardCheck, Download, Lightbulb, Printer } from "lucide-react";
import { cn } from "cn";
import { KPI_LABEL, Panel, fmtKpi, isPct, sourceLabel } from "@/components/dashboard/kpi";
import { OptNumInput, Pick } from "@/components/editor-fields";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Recommendation, SimulateResponse, Stat } from "@/lib/api";
import { type Company, slug } from "@/lib/company";
import { realityRows, resultsCsv, setActual } from "@/lib/results";
import type { ResultSource } from "@/lib/store";

/** The 95% interval of a mean; nothing for an old run, or one replication, where there is no interval. */
export function Interval({ k, st }: { k: string; st?: Stat }) {
  if (!st || typeof st.ci_low !== "number" || typeof st.ci_high !== "number" || st.ci_low === st.ci_high) return null;
  return <span className="whitespace-nowrap text-[11px] font-normal tabular-nums text-muted-foreground" title="95% interval of the mean">95% {fmtKpi(k, st.ci_low)}–{fmtKpi(k, st.ci_high)}</span>;
}

/** Download CSV and Print report. The report is a client-side navigation: the result lives in the TwinProvider, a new tab would lose it. */
export function ResultActions({ result, source }: { result: SimulateResponse; source: ResultSource | null }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob(["﻿", resultsCsv(result)], { type: "text/csv;charset=utf-8" })); // the BOM makes Excel read UTF-8
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(source?.name ?? "") || "results"}-results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <span className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" className="rounded-full" onClick={download}><Download className="size-3.5" /> Download CSV</Button>
      <Button variant="outline" size="sm" className="rounded-full" render={<Link href="/report" />} nativeButton={false}><Printer className="size-3.5" /> Print report</Button>
    </span>
  );
}

const SEVERITY: Record<Recommendation["severity"], string> = {
  high: "bg-rose-400/15 text-rose-400",
  medium: "bg-amber-400/15 text-amber-400",
  info: "bg-primary/15 text-primary",
};

export function RecommendationList({ items, company }: { items: Recommendation[]; company: Company | null }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">Nothing stands out in this scenario.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((r, i) => {
        const dept = r.department_id && (company?.departments.find((d) => d.id === r.department_id)?.name ?? r.department_id);
        return (
          <li key={i} className="flex flex-wrap items-baseline gap-2 rounded-xl glass-inset p-2.5 text-sm">
            <span className={cn("rounded-full px-2 py-0.5 text-xs", SEVERITY[r.severity] ?? SEVERITY.info)}>{r.severity}</span>
            {dept && <span className="font-medium">{dept}</span>}
            <span className="min-w-0 flex-1 basis-60">{r.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Recommendations of one picked scenario, in the order sent. Runs saved before they existed show no panel. */
export function Recommendations({ result, company }: { result: SimulateResponse; company: Company | null }) {
  const [picked, setPicked] = useState("");
  const scenarios = result.scenarios.filter((s) => s.recommendations);
  const s = scenarios.find((x) => x.id === picked) ?? scenarios[0];
  if (!s) return null;
  return (
    <Panel title="Recommendations" subtitle="Rule-based reading of this result" icon={Lightbulb}
      action={scenarios.length > 1 && <Pick label="recommendations scenario" value={s.id} items={Object.fromEntries(scenarios.map((x) => [x.id, x.name]))} onChange={setPicked} />}>
      <RecommendationList items={s.recommendations ?? []} company={company} />
    </Panel>
  );
}

const shown = (k: string, v: number) => (isPct(k) ? Number((v * 100).toFixed(4)) : v);
const VERDICT = { inside: "bg-emerald-400/15 text-emerald-400", outside: "bg-amber-400/15 text-amber-400" };

/** Observed values, kept in company.actuals, against the shown result's first scenario. */
export function RealityCheck({ result, source, company, setCompany }: { result: SimulateResponse; source: ResultSource | null; company: Company; setCompany: (c: Company) => void }) {
  const base = result.scenarios[0];
  if (!base) return null;
  const label = (k: string) => {
    const d = k.startsWith("util_") ? company.departments.find((x) => `util_${x.id}` === k) : undefined;
    return d ? `Utilization: ${d.name}` : KPI_LABEL[k] ?? k;
  };
  return (
    <Panel title={<span className="flex items-center gap-1">Reality check<Hint id="reality_check" /></span>} subtitle={`${base.name} · ${sourceLabel(source)} · against what you observed`} icon={ClipboardCheck} contentClassName="overflow-x-auto">
      <Table>
        <TableHeader className="[&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
          <TableRow><TableHead>KPI</TableHead><TableHead className="text-right">Observed</TableHead><TableHead className="text-right">Simulated</TableHead><TableHead className="text-right">95% interval</TableHead><TableHead className="text-right">Difference</TableHead><TableHead /></TableRow>
        </TableHeader>
        <TableBody>
          {realityRows(result.kpi_keys, base.summary, company.actuals).map(({ kpi, actual, stat, diff, verdict }) => (
            <TableRow key={kpi} className="hover:bg-white/[0.03]">
              <TableCell className="text-muted-foreground">{label(kpi)}</TableCell>
              <TableCell className="text-right">
                <span className="inline-flex items-center gap-1">
                  <OptNumInput aria-label={`observed ${kpi}`} className="h-7 w-24 text-right tabular-nums" hi={isPct(kpi) ? 100 : Infinity} value={actual === undefined ? undefined : shown(kpi, actual)}
                    onCommit={(v) => setCompany(setActual(company, kpi, v === undefined ? undefined : isPct(kpi) ? v / 100 : v))} />
                  <span className="w-3 text-xs text-muted-foreground">{isPct(kpi) ? "%" : ""}</span>
                </span>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{fmtKpi(kpi, stat?.mean)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{stat?.ci_low !== undefined && stat.ci_high !== undefined ? `${fmtKpi(kpi, stat.ci_low)}–${fmtKpi(kpi, stat.ci_high)}` : "–"}</TableCell>
              <TableCell className="text-right tabular-nums">{diff === undefined ? "" : `${diff > 0 ? "+" : ""}${fmtKpi(kpi, diff)}`}</TableCell>
              <TableCell className="text-right">{verdict && <span className={cn("rounded-full px-2 py-0.5 text-xs", VERDICT[verdict])}>{verdict}</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
