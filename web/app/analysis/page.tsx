"use client";

import { RefreshCw } from "lucide-react";
import { cn } from "cn";
import { BASE_KPIS, Delta, KPI_LABEL, LedgerTable, NoResult, Panel, fmtKpi, resultKey, sourceLabel } from "@/components/dashboard/kpi";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTwin } from "@/lib/store";

export default function Analysis() {
  const { runs, showRun, refreshLists, result, resultSource, run, busy, company } = useTwin();
  const base = result?.scenarios[0];
  const kpis = result ? BASE_KPIS.filter((k) => result.kpi_keys.includes(k)) : [];
  const deptKeys = result ? result.kpi_keys.filter((k) => !BASE_KPIS.includes(k)) : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Analysis" subtitle={result ? sourceLabel(resultSource) : "Compare scenarios against the baseline"}>
        <Button variant="outline" size="sm" onClick={refreshLists} disabled={busy}><RefreshCw className="size-3.5" /> Refresh</Button>
      </PageHeader>

      <Panel title="Run History">
        {runs.length === 0 ? <p className="text-sm text-muted-foreground">No saved runs. Tick &quot;Save the result to run history&quot; on the Simulation page.</p> : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Company</TableHead><TableHead>When (UTC)</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const shown = resultSource?.kind === "history" && resultSource.run_id === r.id;
                return (
                  <TableRow key={r.id} className={cn(shown && "bg-primary/10")}>
                    <TableCell className="tabular-nums">{r.id}</TableCell><TableCell>{r.name}</TableCell><TableCell>{r.company_id ?? ""}</TableCell>
                    <TableCell className="tabular-nums">{r.created_at.replace("T", " ").replace("+00:00", "")}</TableCell>
                    <TableCell className="text-right"><Button variant="ghost" size="sm" aria-label={`show run ${r.id}`} onClick={() => showRun(r.id)} disabled={busy}>Show</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      {result && base ? (
        <>
          <Panel title={`Scenario Comparison (baseline: ${base.name})`}>
            <div className="flex flex-col gap-5">
              {kpis.map((k) => {
                const vals = result.scenarios.map((s) => s.summary[k]?.mean ?? 0);
                const max = Math.max(...vals.map(Math.abs), 1e-9);
                return (
                  <div key={k} className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">{KPI_LABEL[k] ?? k}</span>
                    {result.scenarios.map((s, i) => (
                      <div key={s.id} className="grid grid-cols-[8rem_1fr_6rem_5.5rem] items-center gap-3 text-sm">
                        <span className="truncate text-xs" title={s.name}>{s.name}</span>
                        <div className="h-2.5 rounded-full bg-muted/40">
                          <div className={cn("h-full rounded-full", i === 0 ? "bg-muted-foreground/40" : "bg-chart-1 shadow-[0_0_8px_var(--chart-1)]")}
                            style={{ width: `${(Math.abs(vals[i]) / max) * 100}%` }} />
                        </div>
                        <span className="text-right tabular-nums">{fmtKpi(k, s.summary[k]?.mean)}</span>
                        <span className="text-right text-xs">{i === 0 ? <span className="text-muted-foreground">baseline</span> : <Delta k={k} value={s.summary[k]?.mean} base={base.summary[k]?.mean} />}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Panel>

          {deptKeys.length > 0 && (
            <Panel title="Department Utilization">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Department</TableHead>
                    {result.scenarios.map((s) => <TableHead key={s.id} className="text-right">{s.name}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deptKeys.map((k) => (
                    <TableRow key={k}>
                      <TableCell className="text-muted-foreground">{k}</TableCell>
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

          <Panel title="Blocked-time Ledger">
            <Tabs key={resultKey(result)} defaultValue={base.id}>
              <TabsList>{result.scenarios.map((s) => <TabsTrigger key={s.id} value={s.id}>{s.name}</TabsTrigger>)}</TabsList>
              {result.scenarios.map((s) => <TabsContent key={s.id} value={s.id} className="pt-3"><LedgerTable s={s} /></TabsContent>)}
            </Tabs>
          </Panel>
        </>
      ) : <NoResult run={run} busy={busy} disabled={!company} />}
    </div>
  );
}
