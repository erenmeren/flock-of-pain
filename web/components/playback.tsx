"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { cn } from "cn";
import { Panel } from "@/components/dashboard/kpi";
import { DeptMark } from "@/components/org/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ScenarioResult, SimEvent } from "@/lib/api";
import { clock, snapshot } from "@/lib/playback";
import { useTwin } from "@/lib/store";

const SPEEDS = { "10": "10 min/s", "60": "1 h/s", "480": "8 h/s", "1440": "1 day/s" };
const MAX_ROWS = 50;
const NO_EVENTS: SimEvent[] = [];
const HEAD = "[&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground";
const ROW = "hover:bg-white/[0.03]";
const STATE_TONE = { QUEUED: "bg-white/5 text-muted-foreground", IN_PROGRESS: "bg-primary/15 text-primary", BLOCKED: "bg-rose-400/15 text-rose-400" };
const SLIDER = "h-1.5 cursor-pointer appearance-none rounded-full border-0 bg-white/10 p-0 accent-[var(--primary)] shadow-none dark:bg-white/10 focus-visible:ring-0 " +
  "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_var(--primary),0_0_14px_var(--primary)] " +
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_0_0_3px_var(--primary),0_0_14px_var(--primary)] " +
  "focus-visible:[&::-webkit-slider-thumb]:shadow-[0_0_0_3px_var(--primary),0_0_0_7px_color-mix(in_oklch,var(--primary)_35%,transparent)]";

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl glass-inset px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("text-xl font-semibold tabular-nums tracking-tight", tone)}>{value}</span>
    </div>
  );
}

export function Playback({ scenarios }: { scenarios: ScenarioResult[] }) {
  const { company } = useTwin();
  const [si, setSi] = useState(0);
  const [ri, setRi] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("60");

  const scenario = scenarios[Math.min(si, scenarios.length - 1)];
  const run = scenario?.runs[Math.min(ri, scenario.runs.length - 1)];
  const events = run?.events ?? NO_EVENTS;
  const horizon = events.length ? Math.ceil(events[events.length - 1].t) : 0;

  const done = t >= horizon;
  const running = playing && !done; // the interval simply stops at the end; Play restarts from 0
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setT((x) => Math.min(x + Number(speed) / 10, horizon)), 100);
    return () => clearInterval(id);
  }, [running, speed, horizon]);

  const snap = useMemo(() => snapshot(events, t), [events, t]);
  const depts = Object.keys(snap.perDept).sort();
  const live = [...snap.tasks].sort((a, b) => a.since - b.since);
  const deptIndex = (id: string) => company?.departments.findIndex((d) => d.id === id) ?? -1;

  if (!events.length) return null;
  const nDays = Math.max(1, Math.ceil(horizon / 1440));
  const day = Math.min(nDays, Math.floor(t / 1440) + 1);
  const tickStep = Math.ceil(nDays / 8); // at most ~8 labels under the slider
  const ticks = Array.from({ length: nDays }, (_, i) => i).filter((i) => i % tickStep === 0);

  return (
    <Panel title="Playback" subtitle="Replay one run's event log" icon={Activity}
      action={<span className="rounded-full glass-inset px-3 py-1 font-mono text-xs tabular-nums">{clock(t)}</span>}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(si)} items={Object.fromEntries(scenarios.map((s, i) => [String(i), s.name]))} onValueChange={(v) => { if (v) { setSi(Number(v)); setRi(0); setT(0); setPlaying(false); } }}>
            <SelectTrigger aria-label="playback scenario" className="w-52 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>{scenarios.map((s, i) => <SelectItem key={s.id} value={String(i)}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={String(ri)} items={Object.fromEntries(scenario.runs.map((r, i) => [String(i), `seed ${r.seed}`]))} onValueChange={(v) => { if (v) { setRi(Number(v)); setT(0); setPlaying(false); } }}>
            <SelectTrigger aria-label="playback run" className="w-32 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>{scenario.runs.map((r, i) => <SelectItem key={r.seed} value={String(i)}>seed {r.seed}</SelectItem>)}</SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            Simulating {nDays} {nDays === 1 ? "day" : "days"} <span className="mx-1">·</span> Day {day} of {nDays}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Input type="range" aria-label="playback time" min={0} max={horizon} step={1} value={t} className={SLIDER}
            style={{ background: `linear-gradient(to right, var(--primary) ${(t / horizon) * 100}%, oklch(1 0 0 / 0.1) 0)` }}
            onChange={(e) => { setT(Number(e.target.value)); setPlaying(false); }} />
          <div className="relative h-4 text-[11px] text-muted-foreground tabular-nums" aria-hidden>
            {ticks.map((i) => (
              <span key={i} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${((i * 1440) / horizon) * 100}%` }}>D{i + 1}</span>
            ))}
            {nDays > 1 && <span className="absolute right-0">D{nDays}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <Button variant="outline" size="icon" className="size-10 rounded-full" aria-label="skip to start" onClick={() => { setT(0); setPlaying(false); }}>
            <SkipBack className="size-4" />
          </Button>
          <button type="button" aria-label={running ? "Pause" : "Play"} onClick={() => { if (done) setT(0); setPlaying(!running); }}
            className="press flex size-14 items-center justify-center rounded-full bg-gradient-to-b from-[color-mix(in_oklch,var(--primary),white_18%)] to-[var(--primary)] text-white glow-primary outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {running ? <Pause className="size-6 fill-current" /> : <Play className="size-6 translate-x-px fill-current" />}
          </button>
          <Button variant="outline" size="icon" className="size-10 rounded-full" aria-label="skip to end" onClick={() => { setT(horizon); setPlaying(false); }}>
            <SkipForward className="size-4" />
          </Button>
          <div role="group" aria-label="playback speed" className="flex items-center gap-1 rounded-full glass-inset p-1 sm:ml-4">
            {Object.entries(SPEEDS).map(([v, label]) => (
              <Button key={v} variant={speed === v ? "outline" : "ghost"} size="xs" aria-pressed={speed === v} onClick={() => setSpeed(v)}
                className={cn("rounded-full px-2.5", speed === v && "bg-primary/15 text-primary dark:bg-primary/15")}>
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl glass-inset p-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className={cn("size-2.5 shrink-0 rounded-full", running ? "bg-emerald-400 shadow-[0_0_10px_#34d399]" : "bg-muted-foreground/50")} />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{running ? "Live simulation" : done && t > 0 ? "Playback finished" : "Paused"}</span>
              <span className="truncate text-xs text-muted-foreground">
                {snap.outages.length > 0 ? <>Systems down: <span className="text-rose-400">{snap.outages.join(", ")}</span></> : "All systems up"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Started" value={snap.started} />
            <Stat label="Completed" value={snap.completed} tone="text-emerald-400" />
            <Stat label="SLA breaches" value={snap.sla} tone={snap.sla ? "text-rose-400" : undefined} />
          </div>
        </div>

        {live.length === 0 ? <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No tasks in flight at {clock(t)}.</p> : <>
        <Table>
          <TableHeader className={HEAD}>
            <TableRow><TableHead>Department</TableHead><TableHead className="text-right">Queued</TableHead><TableHead className="text-right">In progress</TableHead><TableHead className="text-right">Blocked</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {depts.map((d) => {
              const i = deptIndex(d);
              const c = snap.perDept[d];
              return (
                <TableRow key={d} className={ROW}>
                  <TableCell><span className="flex items-center gap-2.5">{i >= 0 && <DeptMark index={i} size="size-6" />}{company?.departments[i]?.name ?? d}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{c.QUEUED}</TableCell>
                  <TableCell className="text-right tabular-nums text-primary">{c.IN_PROGRESS}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", c.BLOCKED > 0 && "text-rose-400")}>{c.BLOCKED}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Table>
          <TableHeader className={HEAD}>
            <TableRow><TableHead>Task</TableHead><TableHead>State</TableHead><TableHead>Reason</TableHead><TableHead>Resource</TableHead><TableHead className="text-right">Since</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {live.slice(0, MAX_ROWS).map((x) => (
              <TableRow key={x.task_id} className={ROW}>
                <TableCell className="font-mono text-xs">{x.task_id}</TableCell>
                <TableCell><span className={cn("rounded-full px-2 py-0.5 text-xs", STATE_TONE[x.state])}>{x.state.replace("_", " ").toLowerCase()}</span></TableCell>
                <TableCell className="text-muted-foreground">{x.reason ?? ""}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{x.resource_id ?? ""}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{clock(x.since)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {live.length > MAX_ROWS && <p className="text-xs text-muted-foreground">{live.length - MAX_ROWS} more tasks not shown</p>}
        </>}
      </div>
    </Panel>
  );
}
