"use client";

import { BarChart3, Loader2, Play, ShieldAlert } from "lucide-react";
import { cn } from "cn";
import { Delta, KPI_LABEL, LedgerTable, NoResult, Panel, fmtKpi, resultKey, sourceLabel } from "@/components/dashboard/kpi";
import { Interval, Recommendations, ResultActions } from "@/components/dashboard/results";
import { NumInput } from "@/components/editor-fields";
import { Hint } from "@/components/hint";
import { PageHeader } from "@/components/page";
import { RunProgress } from "@/components/shell/run-progress";
import { Playback } from "@/components/playback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDays as countRunDays } from "@/lib/company";
import { type Config, POLICIES, useTwin } from "@/lib/store";

const POLICY_LABEL: Record<string, string> = { edd: "Earliest due date" };
const NUMBERS: [keyof Config, string][] = [["seed", "Seed"], ["days", "Days"], ["warmup_days", "Warm-up days"], ["replications", "Replications"]];
const FIELD = "flex flex-col items-start gap-1.5 rounded-xl glass-inset p-3 text-[11px] font-normal uppercase tracking-wide text-muted-foreground";
const TOGGLE = "flex cursor-pointer items-center gap-3 rounded-xl glass-inset px-3 py-2.5 text-sm font-normal hover:bg-white/[0.05]";
const HEAD = "[&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground";
const LiveDot = () => <span className="size-2.5 shrink-0 rounded-full bg-rose-500 shadow-[0_0_10px_#f43f5e]" aria-hidden />;

export default function Simulation() {
  const { company, scenarios, config, setConfig, result, resultSource, run, busy, viewer, limits } = useTwin();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const runDays = countRunDays(config, scenarios.length);
  const cap = limits.max_event_run_days;
  const over = runDays > cap && config.include_events;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Simulation" subtitle={`${company.name} · ${scenarios.length} scenarios`} />

      <Panel title={<span className="flex items-center gap-2.5"><LiveDot />Simulation Controls</span>}
        subtitle={`${scenarios.map((s) => s.name).join(" · ")} · ${config.days} ${config.days === 1 ? "day" : "days"}${config.warmup_days ? ` + ${config.warmup_days} warm-up` : ""} × ${config.replications} reps`}>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {NUMBERS.map(([k, label]) => (
              <Label key={k} className={FIELD}>
                <span className="flex items-center gap-1">{label}<Hint id={k} /></span>
                <NumInput lo={k === "seed" || k === "warmup_days" ? 0 : 1} value={(config[k] as number | undefined) ?? 0} className="h-8 text-sm tabular-nums normal-case tracking-normal"
                  onCommit={(v) => setConfig({ ...config, [k]: k === "days" || k === "warmup_days" ? v : Math.floor(v) })} />
              </Label>
            ))}
            <Label className={FIELD}>
              <span className="flex items-center gap-1">Policy<Hint id="policy" /></span>
              <Select value={config.policy} items={Object.fromEntries(POLICIES.map((p) => [p, POLICY_LABEL[p] ?? p]))} onValueChange={(v) => v && setConfig({ ...config, policy: v })}>
                <SelectTrigger aria-label="policy" className="w-full normal-case tracking-normal"><SelectValue /></SelectTrigger>
                <SelectContent>{POLICIES.map((p) => <SelectItem key={p} value={p}>{POLICY_LABEL[p] ?? p}</SelectItem>)}</SelectContent>
              </Select>
            </Label>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Label className={TOGGLE}>
              <Checkbox aria-label="common random numbers" checked={config.crn} onCheckedChange={(c) => setConfig({ ...config, crn: !!c })} />
              <span className="flex flex-1 flex-col">
                <span className="flex items-center gap-1">Common random numbers<Hint id="crn" /></span>
                <span className="text-xs text-muted-foreground">Same arrivals and durations in every scenario</span>
              </span>
            </Label>
            <Label className={TOGGLE}>
              <Checkbox aria-label="include events" checked={config.include_events} onCheckedChange={(c) => setConfig({ ...config, include_events: !!c })} />
              <span className="flex flex-1 flex-col">
                <span className="flex items-center gap-1">Include events for playback<Hint id="include_events" /></span>
                <span className="text-xs text-muted-foreground">At most {cap} run-days: (days + warm-up) × reps × scenarios</span>
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-xs tabular-nums", over ? "bg-rose-400/15 text-rose-400" : "bg-white/5 text-muted-foreground")}>
                run-days {runDays} / {cap}
              </span>
            </Label>
            {!viewer && <Label className={TOGGLE}>
              <Checkbox aria-label="save run" checked={config.save} onCheckedChange={(c) => setConfig({ ...config, save: !!c })} />
              <span className="flex flex-1 flex-col">
                <span className="flex items-center gap-1">Save to run history<Hint id="save_run" /></span>
                <span className="text-xs text-muted-foreground">Shows up on the Analysis page</span>
              </span>
            </Label>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={run} disabled={busy} size="lg" className="rounded-full px-5">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 fill-current" />} Run Simulation
            </Button>
            {over && <span className="flex items-center gap-1.5 text-xs text-rose-400"><ShieldAlert className="size-3.5" /> Over the event budget: lower days or reps, or untick events.</span>}
            <RunProgress className="min-w-56 flex-1" />
          </div>
        </div>
      </Panel>

      {result ? (
        <>
          <Panel title="KPIs" subtitle={<>{sourceLabel(resultSource)} · mean and its 95% interval · {result.disclaimer} <Hint id="significance" /></>} icon={BarChart3}
            action={<ResultActions result={result} source={resultSource} />}>
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
                    {result.scenarios.map((s, i) => {
                      const st = s.summary[k];
                      return (
                        <TableCell key={s.id} className="text-right tabular-nums">
                          <span className="font-medium">{fmtKpi(k, st?.mean)}</span>
                          <span className="flex flex-col items-end gap-0.5">
                            <Interval k={k} st={st} />
                            {i > 0 && <span className="text-xs"><Delta k={k} value={st?.mean} base={result.scenarios[0].summary[k]?.mean} cmp={s.comparison?.[k]} /></span>}
                          </span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <Recommendations result={result} company={company} />
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
