"use client";

import { useState } from "react";
import { Hint } from "@/components/hint";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Hours, type Schedule, DAYS, editAbsence, mergeWindows, orderWindows, sameEveryDay, setDayHours, splitAt, windowsOf } from "@/lib/company";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** Read-only id under a name field; ids derive from names (lib/company.ts idFor). */
export function IdTag({ id, className }: { id: string; className?: string }) {
  return <span className={`truncate px-1.5 font-mono text-[11px] text-muted-foreground ${className ?? ""}`} title="id">{id}</span>;
}

/** Uncontrolled number committed on blur; the box keeps what was typed until then. An empty box is rejected. */
export function NumInput({ value, onCommit, lo = 0, hi = Infinity, ...props }: { value: number; onCommit: (v: number) => void; lo?: number; hi?: number } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "type">) {
  return <Input key={value} type="number" step="any" defaultValue={value} onBlur={(e) => {
    const t = e.currentTarget.value;
    const v = t.trim() === "" ? value : clamp(Number(t), lo, hi);
    if (v !== value) onCommit(v);
    e.currentTarget.value = String(v); // show what was stored: the clamped value, or the old one when rejected
  }} {...props} />;
}

/** Optional number committed on blur: an empty box commits undefined ("none"). */
export function OptNumInput({ value, onCommit, lo = 0, hi = Infinity, ...props }: { value?: number; onCommit: (v: number | undefined) => void; lo?: number; hi?: number } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "type">) {
  return <Input key={value ?? "none"} type="number" step="any" placeholder="none" defaultValue={value ?? ""} onBlur={(e) => {
    const t = e.currentTarget.value.trim();
    const v = t === "" ? undefined : clamp(Number(t), lo, hi);
    if (v !== value) onCommit(v);
    e.currentTarget.value = v === undefined ? "" : String(v);
  }} {...props} />;
}

/** Plain Select over {value: label}; base-ui may hand back null. */
export function Pick({ label, value, items, onChange, className = "w-48", placeholder = "select…" }: { label: string; value: string; items: Record<string, string>; onChange: (v: string) => void; className?: string; placeholder?: string }) {
  return (
    <Select value={value || null} items={items} onValueChange={(v) => v !== null && onChange(v)}>
      <SelectTrigger aria-label={label} className={className}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{Object.entries(items).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/** Days and hours. The simple form sets the same one or two windows on every working day; per-day mode edits one day at a time and leaves every other day exactly as stored. */
export function ScheduleEditor({ id, schedule, onChange }: { id: string; schedule: Schedule; onChange: (s: Schedule) => void }) {
  const hours = schedule.weekday_hours;
  const days = Object.keys(hours);
  const [kept, setKept] = useState<Hours[]>([[9, 17]]); // hours survive unchecking every day
  const [perDay, setPerDay] = useState(() => !sameEveryDay(schedule)); // stays on after edits happen to make the days equal
  const uniform = sameEveryDay(schedule);
  const showDays = perDay || !uniform;
  const wins = days.map((k) => windowsOf(hours[k])).find((w) => w.length) ?? kept;
  const rebuild = (keys: string[], ws: Hours[]) => {
    ws = orderWindows(ws, 1);
    setKept(ws);
    onChange({ ...schedule, weekday_hours: Object.fromEntries(keys.sort().map((k) => [k, ws.length === 1 ? ws[0] : ws])) });
  };
  const setDay = (k: string, ws: Hours[] | null) => onChange(setDayHours(schedule, k, ws));
  const at = (i: number, j: 0 | 1, v: number) => rebuild(days, wins.map((w, k) => (k === i ? (j ? [w[0], v] : [v, w[1]]) : w)));
  const [s0, e0] = wins[0];
  const btn = "press self-start rounded-full border border-border px-2 py-0.5 hover:bg-muted";
  const toggle = (
    <Label className="flex items-center gap-1 text-[11px] font-normal">
      <Checkbox aria-label={`different hours per day for ${id}`} checked={showDays} onCheckedChange={(c) => {
        setPerDay(!!c);
        if (!c && !uniform) rebuild(days.filter((k) => windowsOf(hours[k]).length), wins.slice(0, 2));
      }} /> Different per day<Hint id="per_day" />
    </Label>
  );
  if (showDays) return (
    <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
      {DAYS.map((name, d) => {
        const k = String(d);
        const ws = k in hours ? windowsOf(hours[k]) : [];
        return (
          <div key={d} className="flex flex-wrap items-center gap-1">
            <Label className="flex w-12 items-center gap-1 text-[11px] font-normal">
              <Checkbox aria-label={`${name} for ${id}`} checked={ws.length > 0} onCheckedChange={(c) => setDay(k, c ? [wins[0]] : null)} /> {name}
            </Label>
            {ws.map(([s, e], i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && "+"}
                <NumInput aria-label={`${name} window ${i + 1} start hour of ${id}`} className="h-7 w-14 px-1 tabular-nums" hi={23.75} value={s} onCommit={(v) => setDay(k, ws.map((w, j) => (j === i ? [v, w[1]] : w)))} />
                to
                <NumInput aria-label={`${name} window ${i + 1} end hour of ${id}`} className="h-7 w-14 px-1 tabular-nums" lo={s + 0.25} hi={s + 24} value={e} onCommit={(v) => setDay(k, ws.map((w, j) => (j === i ? [w[0], v] : w)))} />
              </span>
            ))}
            {ws.length === 2 && <button type="button" className={btn} onClick={() => setDay(k, [[ws[0][0], ws[1][1]]])}>Remove break</button>}
            {ws.length === 1 && ws[0][1] - ws[0][0] >= 3 && <button type="button" className={btn} onClick={() => setDay(k, windowsOf(splitAt({ weekday_hours: { [k]: ws[0] } }, clamp(13, ws[0][0] + 1, ws[0][1] - 2)).weekday_hours[k]))}>Add break</button>}
          </div>
        );
      })}
      <span className="text-muted-foreground/80">Hours past 24 run overnight.</span>
      {toggle}
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap gap-x-1.5 gap-y-1">
        {DAYS.map((name, d) => (
          <Label key={d} className="flex items-center gap-1 text-[11px] font-normal">
            <Checkbox aria-label={`${name} for ${id}`} checked={days.includes(String(d))}
              onCheckedChange={(c) => rebuild(c ? [...days, String(d)] : days.filter((k) => k !== String(d)), wins)} /> {name}
          </Label>
        ))}
      </div>
      {wins.map(([start, end], i) => {
        const which = i ? "second shift" : "shift";
        return (
          <div key={i} className="flex flex-wrap items-center gap-1">
            <span className="flex items-center gap-1">
              <Input key={`s${start}`} type="number" min={0} max={23} aria-label={`${which} start hour of ${id}`} className="h-7 w-16 px-1 tabular-nums" defaultValue={start} onBlur={(e) => (e.target.value.trim() === "" ? (e.target.value = String(start)) : at(i, 0, Number(e.target.value)))} />
              to
              <Input key={`e${end}`} type="number" min={start + 1} max={start + 24} aria-label={`${which} end hour of ${id}`} className="h-7 w-16 px-1 tabular-nums" defaultValue={end} onBlur={(e) => (e.target.value.trim() === "" ? (e.target.value = String(end)) : at(i, 1, Number(e.target.value)))} />
            </span>
            {i ? "h after the break" : "h (overnight: end past 24)"}
          </div>
        );
      })}
      {days.length > 0 && (wins.length === 2
        ? <button type="button" className={btn} onClick={() => onChange(mergeWindows(schedule))}>Remove break</button>
        : e0 - s0 >= 3 && <button type="button" className={btn} onClick={() => onChange(splitAt(schedule, clamp(13, s0 + 1, e0 - 2)))}>Add break</button>)}
      {toggle}
    </div>
  );
}

const dayOf = (m: number) => Math.floor(m / 1440);
const hourOf = (m: number) => Number(((m - dayOf(m) * 1440) / 60).toFixed(2));

/** A person's absences as day and hour; stored as minutes from time zero, in the schedule. */
export function AbsencesEditor({ id, schedule, onChange }: { id: string; schedule: Schedule; onChange: (s: Schedule) => void }) {
  const list = schedule.absences ?? [];
  const write = (absences: Hours[]) => {
    const next = { ...schedule };
    if (absences.length) next.absences = absences; else delete next.absences;
    onChange(next);
  };
  const edit = (i: number, part: "start" | "end", day: number, hour: number) => write(list.map((a, j) => (j === i ? editAbsence(a, part, day, hour) : a)));
  const box = "h-7 w-14 px-1 tabular-nums";
  return (
    <details className="text-[11px] text-muted-foreground [&>summary]:cursor-pointer">
      <summary>Absences ({list.length}) <Hint id="absences" /></summary>
      <div className="mt-1 flex flex-col gap-1">
        {list.map(([start, end], i) => (
          <div key={i} className="flex flex-wrap items-center gap-1">
            {([["from", "start", start], ["to", "end", end]] as const).map(([word, part, m]) => (
              <span key={part} className="flex items-center gap-1">
                {word} day
                <NumInput aria-label={`absence ${i + 1} ${part} day of ${id}`} className={box} value={dayOf(m)} onCommit={(v) => edit(i, part, Math.floor(v), hourOf(m))} />
                hour
                <NumInput aria-label={`absence ${i + 1} ${part} hour of ${id}`} className={box} hi={24} value={hourOf(m)} onCommit={(v) => edit(i, part, dayOf(m), v)} />
                <span title="weekday">{DAYS[dayOf(m) % 7]}</span>
              </span>
            ))}
            <button type="button" aria-label={`remove absence ${i + 1} of ${id}`} className="press rounded-full border border-border px-2 py-0.5 hover:bg-muted" onClick={() => write(list.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className="press self-start rounded-full border border-border px-2 py-0.5 hover:bg-muted" onClick={() => {
          const d = list.length ? dayOf(list[list.length - 1][1]) + 1 : 0;
          write([...list, [d * 1440 + 540, d * 1440 + 1020]]);
        }}>Add absence</button>
      </div>
    </details>
  );
}
