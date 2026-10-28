"use client";

import { useState } from "react";
import { BarChart3, Gauge, History, ListTree, RefreshCw, Workflow } from "lucide-react";
import { cn } from "cn";
import { workflowMeans } from "@/components/dashboard/derive";
import { BASE_KPIS, Delta, KPI_LABEL, LedgerTable, NoResult, Panel, fmtKpi, resultKey, sourceLabel } from "@/components/dashboard/kpi";
import { DeptMark } from "@/components/org/parts";
import { Hint } from "@/components/hint";
import { PageHeader } from "@/components/page";
import { channelLabels } from "@/components/process/graph";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SimulateResponse, WorkflowMetrics } from "@/lib/api";
import { type ResultSource, useTwin } from "@/lib/store";

const HEAD = "[&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground";
const ROW = "hover:bg-white/[0.03]";
/** Bar colour per scenario index; the baseline stays muted. */
const barColor = (i: number) => (i === 0 ? "oklch(1 0 0 / 0.28)" : `var(--chart-${(i % 5) + 1})`);

/** Per-workflow metric keys the breakdown can show; completion_rate is derived from completed / started. */
const WF_KPIS = ["throughput_per_day", "completion_rate", "cycle_p50", "cycle_p90", "wait_p90", "sla_breach_rate", "rework_rate", "cost_per_completed"];
const wfValue = (m: WorkflowMetrics | undefined, k: string) =>
  m === undefined ? undefined : k === "completion_rate" ? (m.started ? m.completed / m.started : 0) : m[k as keyof WorkflowMetrics];

/** One row per engine workflow (one per inflow when a workflow has 2+), columns per scenario, delta vs baseline. */
function WorkflowBreakdown({ result, labels }: { result: SimulateResponse; labels: Record<string, string> }) {
  const [k, setK] = useState(WF_KPIS[0]);
  const means = result.scenarios.map(workflowMeans);
  const ids = [...new Set(means.flatMap(Object.keys))];
  const base = means[0];
  return (
    <Panel title="Workflow Breakdown" subtitle="Mean per engine workflow; a workflow with several inflows shows one row per inflow" icon={Workflow}
      action={
        <Select value={k} items={Object.fromEntries(WF_KPIS.map((x) => [x, KPI_LABEL[x] ?? x]))} onValueChange={(v) => v && setK(v)}>
          <SelectTrigger aria-label="workflow metric" className="w-52 rounded-full"><SelectValue /></SelectTrigger>
          <SelectContent>{WF_KPIS.map((x) => <SelectItem key={x} value={x}>{KPI_LABEL[x] ?? x}</SelectItem>)}</SelectContent>
        </Select>
      }>
      {ids.length === 0 ? <p className="text-sm text-muted-foreground">No workflow ran.</p> : (
        <Table>
          <TableHeader className={HEAD}>
            <TableRow>
              <TableHead>Workflow</TableHead>
              {result.scenarios.map((s) => <TableHead key={s.id} className="text-right">{s.name}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ids.map((id) => (
              <TableRow key={id} className={ROW}>
                <TableCell>{labels[id] ?? <span className="font-mono text-xs">{id}</span>}</TableCell>
                {result.scenarios.map((s, i) => {
                  const v = wfValue(means[i][id], k);
                  return (
                    <TableCell key={s.id} className="text-right tabular-nums">
                      {fmtKpi(k, v)}
                      {i > 0 && <span className="ml-2 text-xs"><Delta k={k} value={v} base={wfValue(base[id], k)} /></span>}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** Names from the draft only when the result came from it; a history run may belong to another company. */
const labelsFor = (src: ResultSource | null, company: { id: string } | null) =>
  src?.kind === "run" && company && src.company_id === company.id ? channelLabels(company as Parameters<typeof channelLabels>[0]) : {};

export default function Analysis() {
  const { runs, showRun, refreshLists, result, resultSource, run, busy, company } = useTwin();
  const base = result?.scenarios[0];
  const kpis = result ? BASE_KPIS.filter((k) => result.kpi_keys.includes(k)) : [];
  const deptKeys = result ? result.kpi_keys.filter((k) => !BASE_KPIS.includes(k)) : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Analysis" subtitle={result ? sourceLabel(resultSource) : "Compare scenarios against the baseline"}>
        <Button variant="outline" size="sm" className="rounded-full" onClick={refreshLists} disabled={busy}><RefreshCw className="size-3.5" /> Refresh</Button>
      </PageHeader>

      <Panel title="Run History" subtitle={`${runs.length} saved ${runs.length === 1 ? "run" : "runs"}`} icon={History}>
        {runs.length === 0 ? <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No saved runs. Tick &quot;Save the result to run history&quot; on the Simulation page.</p> : (
          <Table>
            <TableHeader className={HEAD}>
              <TableRow><TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Company</TableHead><TableHead>When (UTC)</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const shown = resultSource?.kind === "history" && resultSource.run_id === r.id;
                return (
                  <TableRow key={r.id} className={cn(ROW, shown && "bg-primary/10 hover:bg-primary/15")}>
                    <TableCell className="tabular-nums text-muted-foreground">#{r.id}</TableCell>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <span className={cn("size-2 rounded-full", shown ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/20")} />{r.name}
                        {shown && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-normal text-primary">shown</span>}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.company_id ?? ""}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{r.created_at.replace("T", " ").replace("+00:00", "")}</TableCell>
                    <TableCell className="text-right"><Button variant="outline" size="sm" className="rounded-full" aria-label={`show run ${r.id}`} onClick={() => showRun(r.id)} disabled={busy}>Show</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      {result && base ? (
        <>
          <Panel title="Scenario Comparison" subtitle={`Mean per KPI · baseline: ${base.name}`} icon={BarChart3}
            action={<span className="hidden flex-wrap gap-3 sm:flex">{result.scenarios.map((s, i) => <span key={s.id} className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 rounded-full" style={{ background: barColor(i) }} />{s.name}</span>)}</span>}>
            <div className="grid gap-3 xl:grid-cols-2">
              {kpis.map((k) => {
                const vals = result.scenarios.map((s) => s.summary[k]?.mean ?? 0);
                const max = Math.max(...vals.map(Math.abs), 1e-9);
                return (
                  <div key={k} className="flex flex-col gap-2 rounded-xl glass-inset p-3">
                    <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">{KPI_LABEL[k] ?? k}<Hint id={k} /></span>
                    {result.scenarios.map((s, i) => (
                      <div key={s.id} className="grid grid-cols-[5rem_1fr_4.5rem_4rem] sm:grid-cols-[8rem_1fr_6rem_5.5rem] items-center gap-3 text-sm">
                        <span className="truncate text-xs text-muted-foreground" title={s.name}>{s.name}</span>
                        <div className="h-2 rounded-full bg-white/[0.06]">
                          <div className="h-full rounded-full motion-safe:transition-[width] duration-300"
                            style={{ width: `${(Math.abs(vals[i]) / max) * 100}%`, background: barColor(i), boxShadow: i === 0 ? undefined : `0 0 10px ${barColor(i)}` }} />
                        </div>
                        <span className="text-right font-medium tabular-nums">{fmtKpi(k, s.summary[k]?.mean)}</span>
                        <span className="text-right text-xs">{i === 0 ? <span className="text-muted-foreground">baseline</span> : <Delta k={k} value={s.summary[k]?.mean} base={base.summary[k]?.mean} />}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Panel>

          {deptKeys.length > 0 && (
            <Panel title="Department Utilization" subtitle="Mean busy share per department, delta vs baseline" icon={Gauge}>
              <Table>
                <TableHeader className={HEAD}>
                  <TableRow>
                    <TableHead>Department</TableHead>
                    {result.scenarios.map((s) => <TableHead key={s.id} className="text-right">{s.name}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deptKeys.map((k) => (
                    <TableRow key={k} className={ROW}>
                      <TableCell>{(() => {
                        const id = k.replace(/^util_/, "");
                        const di = company?.departments.findIndex((d) => d.id === id) ?? -1;
                        return <span className="flex items-center gap-2.5">{di >= 0 && <DeptMark index={di} size="size-6" />}{company?.departments[di]?.name ?? k}</span>;
                      })()}</TableCell>
                      {result.scenarios.map((s, i) => (
                        <TableCell key={s.id} className="text-right tabular-nums">
                          {fmtKpi(k, s.summary[k]?.mean)}
                          {i > 0 && <span className="ml-2 text-xs"><Delta k={k} value={s.summary[k]?.mean} base={base.summary[k]?.mean} /></span>}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          )}

          <WorkflowBreakdown key={resultKey(result)} result={result} labels={labelsFor(resultSource, company)} />

          <Panel title="Blocked-time Ledger" subtitle="Where tasks waited, per scenario" icon={ListTree}>
            <Tabs key={resultKey(result)} defaultValue={base.id}>
              <TabsList className="h-9 rounded-full glass-inset bg-transparent p-1">{result.scenarios.map((s) => <TabsTrigger key={s.id} value={s.id} className="rounded-full px-3 data-active:bg-primary/15 data-active:text-primary dark:data-active:border-transparent dark:data-active:bg-primary/15 dark:data-active:text-primary">{s.name}</TabsTrigger>)}</TabsList>
              {result.scenarios.map((s) => <TabsContent key={s.id} value={s.id} className={cn("pt-3", HEAD)}><LedgerTable s={s} /></TabsContent>)}
            </Tabs>
          </Panel>
        </>
      ) : <NoResult run={run} busy={busy} disabled={!company} />}
    </div>
  );
}
