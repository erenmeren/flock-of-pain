"use client";

import { Loader2, Play } from "lucide-react";
import { KPI_LABEL, LedgerTable, NoResult, Panel, fmtKpi, resultKey, sourceLabel } from "@/components/dashboard/kpi";
import { NumInput } from "@/components/editor-fields";
import { PageHeader } from "@/components/page";
import { Playback } from "@/components/playback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Config, POLICIES, useTwin } from "@/lib/store";

const NUMBERS: [keyof Config, string][] = [["seed", "Seed"], ["days", "Days"], ["replications", "Replications"]];

export default function Simulation() {
  const { company, scenarios, config, setConfig, result, resultSource, run, busy } = useTwin();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const runDays = config.days * config.replications * scenarios.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Simulation" subtitle={`${company.name} · ${scenarios.length} scenarios`} />

      <Panel title="Simulation Controls">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {NUMBERS.map(([k, label]) => (
              <Label key={k} className="flex flex-col items-start gap-1.5 text-xs text-muted-foreground">
                {label}
                <NumInput lo={k === "seed" ? 0 : 1} value={config[k] as number}
                  onCommit={(v) => setConfig({ ...config, [k]: k === "days" ? v : Math.floor(v) })} />
              </Label>
            ))}
            <Label className="flex flex-col items-start gap-1.5 text-xs text-muted-foreground">
              Policy
              <Select value={config.policy} items={Object.fromEntries(POLICIES.map((p) => [p, p]))} onValueChange={(v) => v && setConfig({ ...config, policy: v })}>
                <SelectTrigger aria-label="policy" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{POLICIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </Label>
          </div>
          <Label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox aria-label="include events" checked={config.include_events} onCheckedChange={(c) => setConfig({ ...config, include_events: !!c })} />
            Include events for playback (at most 30 run-days: days × reps × scenarios)
            <span className={runDays > 30 && config.include_events ? "text-rose-400" : "text-muted-foreground"}>· now {runDays}</span>
          </Label>
          <Label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox aria-label="save run" checked={config.save} onCheckedChange={(c) => setConfig({ ...config, save: !!c })} />
            Save the result to run history
          </Label>
          <div>
            <Button onClick={run} disabled={busy} className="shadow-[0_0_18px_-2px_var(--primary)]">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run Simulation
            </Button>
          </div>
        </div>
      </Panel>

      {result ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{sourceLabel(resultSource)}</p>
            <p className="text-xs text-muted-foreground">{result.disclaimer}</p>
          </div>
          <Panel title="KPIs: mean (p10–p90)">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>KPI</TableHead>
                  {result.scenarios.map((s) => <TableHead key={s.id}>{s.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.kpi_keys.map((k) => (
                  <TableRow key={k}>
                    <TableCell className="text-muted-foreground">{KPI_LABEL[k] ?? k}</TableCell>
                    {result.scenarios.map((s) => {
                      const st = s.summary[k];
                      return (
                        <TableCell key={s.id} className="tabular-nums">
                          {fmtKpi(k, st?.mean)} {st && <span className="text-xs text-muted-foreground">({fmtKpi(k, st.p10)}–{fmtKpi(k, st.p90)})</span>}
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
              <Panel key={s.id} title={`Blocked time: ${s.name}`}><LedgerTable s={s} /></Panel>
            ))}
          </div>
        </>
      ) : <NoResult run={run} busy={busy} />}
    </div>
  );
}
