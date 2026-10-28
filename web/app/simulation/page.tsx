"use client";

import { BarChart3, Loader2, Play, ShieldAlert } from "lucide-react";
import { cn } from "cn";
import { KPI_LABEL, LedgerTable, NoResult, Panel, fmtKpi, resultKey, sourceLabel } from "@/components/dashboard/kpi";
import { NumInput } from "@/components/editor-fields";
import { Hint } from "@/components/hint";
import { PageHeader } from "@/components/page";
import { Playback } from "@/components/playback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Config, POLICIES, useTwin } from "@/lib/store";

const NUMBERS: [keyof Config, string][] = [["seed", "Seed"], ["days", "Days"], ["replications", "Replications"]];
const FIELD = "flex flex-col items-start gap-1.5 rounded-xl glass-inset p-3 text-[11px] font-normal uppercase tracking-wide text-muted-foreground";
const TOGGLE = "flex cursor-pointer items-center gap-3 rounded-xl glass-inset px-3 py-2.5 text-sm font-normal hover:bg-white/[0.05]";
const HEAD = "[&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground";
const LiveDot = () => <span className="size-2.5 shrink-0 rounded-full bg-rose-500 shadow-[0_0_10px_#f43f5e]" aria-hidden />;

export default function Simulation() {
  const { company, scenarios, config, setConfig, result, resultSource, run, busy } = useTwin();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const runDays = config.days * config.replications * scenarios.length;
  const over = runDays > 30 && config.include_events;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Simulation" subtitle={`${company.name} · ${scenarios.length} scenarios`} />

      <Panel title={<span className="flex items-center gap-2.5"><LiveDot />Simulation Controls</span>}
        subtitle={`${scenarios.map((s) => s.name).join(" · ")} · ${config.days} ${config.days === 1 ? "day" : "days"} × ${config.replications} reps`}>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {NUMBERS.map(([k, label]) => (
              <Label key={k} className={FIELD}>
                <span className="flex items-center gap-1">{label}<Hint id={k} /></span>
                <NumInput lo={k === "seed" ? 0 : 1} value={config[k] as number} className="h-8 text-sm tabular-nums normal-case tracking-normal"
                  onCommit={(v) => setConfig({ ...config, [k]: k === "days" ? v : Math.floor(v) })} />
              </Label>
            ))}
            <Label className={FIELD}>
              <span className="flex items-center gap-1">Policy<Hint id="policy" /></span>
              <Select value={config.policy} items={Object.fromEntries(POLICIES.map((p) => [p, p]))} onValueChange={(v) => v && setConfig({ ...config, policy: v })}>
                <SelectTrigger aria-label="policy" className="w-full normal-case tracking-normal"><SelectValue /></SelectTrigger>
                <SelectContent>{POLICIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </Label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Label className={TOGGLE}>
              <Checkbox aria-label="include events" checked={config.include_events} onCheckedChange={(c) => setConfig({ ...config, include_events: !!c })} />
              <span className="flex flex-1 flex-col">
                <span className="flex items-center gap-1">Include events for playback<Hint id="include_events" /></span>
                <span className="text-xs text-muted-foreground">At most 30 run-days: days × reps × scenarios</span>
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-xs tabular-nums", over ? "bg-rose-400/15 text-rose-400" : "bg-white/5 text-muted-foreground")}>
                run-days {runDays} / 30
              </span>
            </Label>
            <Label className={TOGGLE}>
              <Checkbox aria-label="save run" checked={config.save} onCheckedChange={(c) => setConfig({ ...config, save: !!c })} />
              <span className="flex flex-1 flex-col">
                <span className="flex items-center gap-1">Save to run history<Hint id="save_run" /></span>
                <span className="text-xs text-muted-foreground">Shows up on the Analysis page</span>
              </span>
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={run} disabled={busy} size="lg" className="rounded-full px-5">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 fill-current" />} Run Simulation
            </Button>
            {over && <span className="flex items-center gap-1.5 text-xs text-rose-400"><ShieldAlert className="size-3.5" /> Over the event budget: lower days or reps, or untick events.</span>}
          </div>
        </div>
      </Panel>

      {result ? (
        <>
          <Panel title="KPIs" subtitle={<>{sourceLabel(resultSource)} · mean (p10–p90) · {result.disclaimer}</>} icon={BarChart3}>
            <Table>
              <TableHeader className={HEAD}>
                <TableRow>
                  <TableHead>KPI</TableHead>
                  {result.scenarios.map((s) => <TableHead key={s.id} className="text-right">{s.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.kpi_keys.map((k) => (
                  <TableRow key={k} className="hover:bg-white/[0.03]">
                    <TableCell className="text-muted-foreground">{KPI_LABEL[k] ?? k}</TableCell>
                    {result.scenarios.map((s) => {
                      const st = s.summary[k];
                      return (
                        <TableCell key={s.id} className="text-right tabular-nums">
                          <span className="font-medium">{fmtKpi(k, st?.mean)}</span>
                          {st && <span className="ml-1.5 text-xs text-muted-foreground">{fmtKpi(k, st.p10)}–{fmtKpi(k, st.p90)}</span>}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <Playback key={resultKey(result)} scenarios={result.scenarios} />
          <div className="grid gap-4 lg:grid-cols-2">
            {result.scenarios.map((s) => (
              <Panel key={s.id} title={`Blocked time: ${s.name}`} icon={ShieldAlert} contentClassName={HEAD}><LedgerTable s={s} /></Panel>
            ))}
          </div>
        </>
      ) : <NoResult run={run} busy={busy} />}
    </div>
  );
}
