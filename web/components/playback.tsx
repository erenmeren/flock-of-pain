"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ScenarioResult, SimEvent } from "@/lib/api";
import { clock, snapshot } from "@/lib/playback";

const SPEEDS = { "10": "10 min/s", "60": "1 h/s", "480": "8 h/s", "1440": "1 day/s" };
const MAX_ROWS = 50;
const NO_EVENTS: SimEvent[] = [];

export function Playback({ scenarios }: { scenarios: ScenarioResult[] }) {
  const [si, setSi] = useState(0);
  const [ri, setRi] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("60");

  const scenario = scenarios[Math.min(si, scenarios.length - 1)];
  const run = scenario?.runs[Math.min(ri, scenario.runs.length - 1)];
  const events = run?.events ?? NO_EVENTS;
  const horizon = events.length ? Math.ceil(events[events.length - 1].t) : 0;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setT((x) => {
      const next = x + Number(speed) / 10;
      if (next >= horizon) setPlaying(false);
      return Math.min(next, horizon);
    }), 100);
    return () => clearInterval(id);
  }, [playing, speed, horizon]);

  const snap = useMemo(() => snapshot(events, t), [events, t]);
  const depts = Object.keys(snap.perDept).sort();
  const live = [...snap.tasks].sort((a, b) => a.since - b.since);

  if (!events.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Playback</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(si)} items={Object.fromEntries(scenarios.map((s, i) => [String(i), s.name]))} onValueChange={(v) => { if (v) { setSi(Number(v)); setRi(0); setT(0); setPlaying(false); } }}>
            <SelectTrigger aria-label="playback scenario" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>{scenarios.map((s, i) => <SelectItem key={s.id} value={String(i)}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={String(ri)} items={Object.fromEntries(scenario.runs.map((r, i) => [String(i), `seed ${r.seed}`]))} onValueChange={(v) => { if (v) { setRi(Number(v)); setT(0); setPlaying(false); } }}>
            <SelectTrigger aria-label="playback run" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{scenario.runs.map((r, i) => <SelectItem key={r.seed} value={String(i)}>seed {r.seed}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setPlaying((p) => !p)} disabled={t >= horizon && !playing}>{playing ? "Pause" : "Play"}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setT(0); setPlaying(false); }}>Reset</Button>
          <Select value={speed} items={SPEEDS} onValueChange={(v) => v && setSpeed(v)}>
            <SelectTrigger aria-label="playback speed" className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(SPEEDS).map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <span className="font-mono text-sm">{clock(t)}</span>
        </div>
        <Input type="range" aria-label="playback time" min={0} max={horizon} step={1} value={t} onChange={(e) => { setT(Number(e.target.value)); setPlaying(false); }} />
        <p className="text-sm">
          Workflows started {snap.started}, completed {snap.completed}, SLA breaches {snap.sla}
          {snap.outages.length > 0 && <>, systems down: {snap.outages.join(", ")}</>}
        </p>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Department</TableHead><TableHead>Queued</TableHead><TableHead>In progress</TableHead><TableHead>Blocked</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {depts.map((d) => (
              <TableRow key={d}>
                <TableCell>{d}</TableCell><TableCell>{snap.perDept[d].QUEUED}</TableCell><TableCell>{snap.perDept[d].IN_PROGRESS}</TableCell><TableCell>{snap.perDept[d].BLOCKED}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Task</TableHead><TableHead>State</TableHead><TableHead>Reason</TableHead><TableHead>Resource</TableHead><TableHead>Since</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {live.slice(0, MAX_ROWS).map((x) => (
              <TableRow key={x.task_id}>
                <TableCell className="font-mono text-xs">{x.task_id}</TableCell><TableCell>{x.state}</TableCell>
                <TableCell>{x.reason ?? ""}</TableCell><TableCell>{x.resource_id ?? ""}</TableCell><TableCell>{clock(x.since)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {live.length > MAX_ROWS && <p className="text-xs">{live.length - MAX_ROWS} more tasks not shown</p>}
      </CardContent>
    </Card>
  );
}
