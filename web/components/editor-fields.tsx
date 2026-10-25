"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Schedule, DAYS } from "@/lib/company";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** Uncontrolled id field committed on blur, so intermediate ids never rename references. */
export function IdInput({ value, onCommit, ...props }: { value: string; onCommit: (id: string) => void } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur">) {
  return <Input key={value} defaultValue={value} onBlur={(e) => e.target.value !== value && onCommit(e.target.value)} {...props} />;
}

/** Uncontrolled number committed on blur; the box keeps what was typed until then. */
export function NumInput({ value, onCommit, lo = 0, hi = Infinity, ...props }: { value: number; onCommit: (v: number) => void; lo?: number; hi?: number } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "type">) {
  return <Input key={value} type="number" step="any" defaultValue={value} onBlur={(e) => { const v = clamp(Number(e.target.value), lo, hi); if (v !== value) onCommit(v); }} {...props} />;
}

export function uniqueId(base: string, items: { id: string }[]): string {
  const ids = new Set(items.map((x) => x.id));
  let n = 1;
  while (ids.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// shortcut: one [start, end] for every working day; per-day hours and absences are edited in the JSON tab
export function ScheduleEditor({ id, schedule, onChange }: { id: string; schedule: Schedule; onChange: (s: Schedule) => void }) {
  const days = Object.keys(schedule.weekday_hours);
  const [kept, setKept] = useState<[number, number]>([9, 17]); // hours survive unchecking every day
  const [start, end] = days.length ? schedule.weekday_hours[days[0]] : kept;
  const uniform = days.every((k) => schedule.weekday_hours[k][0] === start && schedule.weekday_hours[k][1] === end);
  if (!uniform) return <p className="text-xs">per-day hours: edit in the JSON tab</p>;
  const rebuild = (keys: string[], s: number, e: number) => {
    s = clamp(Math.floor(s), 0, 23);
    e = clamp(Math.floor(e), s + 1, s + 24); // loader rule: 0 <= start < 24, start < end <= start + 24
    setKept([s, e]);
    onChange({ ...schedule, weekday_hours: Object.fromEntries(keys.sort().map((k) => [k, [s, e] as [number, number]])) });
  };
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex gap-2">
        {DAYS.map((name, d) => (
          <Label key={d} className="flex items-center gap-1">
            <Checkbox aria-label={`${name} for ${id}`} checked={days.includes(String(d))}
              onCheckedChange={(c) => rebuild(c ? [...days, String(d)] : days.filter((k) => k !== String(d)), start, end)} /> {name}
          </Label>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Input key={`s${start}`} type="number" min={0} max={23} aria-label={`shift start hour of ${id}`} className="w-16" defaultValue={start} onBlur={(e) => rebuild(days, Number(e.target.value), end)} />
        to
        <Input key={`e${end}`} type="number" min={start + 1} max={start + 24} aria-label={`shift end hour of ${id}`} className="w-16" defaultValue={end} onBlur={(e) => rebuild(days, start, Number(e.target.value))} />
        h (overnight: end past 24)
      </div>
    </div>
  );
}
