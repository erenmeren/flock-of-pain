"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IdInput, NumInput, ScheduleEditor } from "@/components/editor-fields";
import { type Company, type Overlay, DAYS, OVERLAY_TYPES, weekdays9to5 } from "@/lib/company";

export const DAY = 1440;
const ALL = "__all__";

/** Virtual minutes from Monday 00:00 as "Wed 10:00" (week suffix past the first week). */
export function minuteLabel(m: number): string {
  const day = Math.floor(m / DAY);
  const rest = m - day * DAY;
  const hh = String(Math.floor(rest / 60)).padStart(2, "0");
  const mm = String(Math.floor(rest % 60)).padStart(2, "0");
  return `${DAYS[day % 7]}${day >= 7 ? ` (wk ${Math.floor(day / 7) + 1})` : ""} ${hh}:${mm}`;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground [&>*]:normal-case [&>*]:tracking-normal">{label}{children}</label>;
}

/** start < end in whole minutes; each box shows the weekday clock time it means. */
export function MinuteRange({ label, start, end, onChange }: { label: string; start: number; end: number; onChange: (start: number, end: number) => void }) {
  return (
    <>
      <Field label={`Start min · ${minuteLabel(start)}`}>
        <NumInput aria-label={`start minute of ${label}`} className="w-28" value={start} hi={end - 1} onCommit={(v) => onChange(Math.floor(v), end)} />
      </Field>
      <Field label={`End min · ${minuteLabel(end)}`}>
        <NumInput aria-label={`end minute of ${label}`} className="w-28" value={end} lo={start + 1} onCommit={(v) => onChange(start, Math.ceil(v))} />
      </Field>
    </>
  );
}

const resources = (c: Company) => c.departments.flatMap((d) => d.resources.map((r) => ({ r, d })));
export const systemItems = (c: Company) => Object.fromEntries(c.systems.map((s) => [s.id, s.name ? `${s.id} · ${s.name}` : s.id]));

/** A fresh overlay of `type` filled from the first matching company entity. */
export function newOverlay(type: (typeof OVERLAY_TYPES)[number], c: Company): Overlay {
  const all = resources(c);
  switch (type) {
    case "arrival_multiplier": return { type, factor: 1.5, workflow_id: null };
    case "system_outage": return { type, system_id: c.systems[0]?.id ?? "", start: 2 * DAY + 600, end: 2 * DAY + 720 };
    case "add_employee": {
      const d = c.departments[0];
      return { type, department_id: d?.id ?? "", employee: { id: "new_employee", name: "New employee", skills: d?.resources[0]?.skills ?? [], cost_per_hour: 30, speed_factor: 1, schedule: weekdays9to5() } };
    }
    case "remove_resource": return { type, resource_id: all[0]?.r.id ?? "" };
    case "set_pool_headcount": {
      const p = all.find((x) => x.r.headcount !== undefined)?.r;
      return { type, pool_id: p?.id ?? "", headcount: p?.headcount ?? 1 };
    }
    case "absence": return { type, resource_id: all[0]?.r.id ?? "", start: 600, end: 1020 };
  }
}

export function OverlayEditor({ o, company: c, onChange, onRemove }: { o: Overlay; company: Company; onChange: (o: Overlay) => void; onRemove: () => void }) {
  const resItems = Object.fromEntries(resources(c).map(({ r, d }) => [r.id, `${r.id} (${d.id})${r.headcount !== undefined ? ` ×${r.headcount}` : ""}`]));
  let body: React.ReactNode;
  switch (o.type) {
    case "arrival_multiplier":
      body = <>
        <Field label="Factor"><NumInput aria-label="arrival factor" className="w-24" value={o.factor} lo={0.01} onCommit={(factor) => onChange({ ...o, factor })} /></Field>
        <Field label="Workflow">
          <Pick label="multiplied workflow" value={o.workflow_id ?? ALL} items={{ [ALL]: "all workflows", ...Object.fromEntries(c.workflows.map((w) => [w.id, w.name])) }}
            onChange={(v) => onChange({ ...o, workflow_id: v === ALL ? null : v })} />
        </Field>
      </>;
      break;
    case "system_outage":
      body = <>
        <Field label="System"><Pick label="outage system" value={o.system_id} items={systemItems(c)} onChange={(system_id) => onChange({ ...o, system_id })} /></Field>
        <MinuteRange label="outage" start={o.start} end={o.end} onChange={(start, end) => onChange({ ...o, start, end })} />
      </>;
      break;
    case "add_employee": {
      const e = o.employee;
      const setE = (employee: typeof e) => onChange({ ...o, employee });
      body = <>
        <Field label="Department"><Pick label="new employee department" className="w-36" value={o.department_id} items={Object.fromEntries(c.departments.map((d) => [d.id, d.name || d.id]))} onChange={(department_id) => onChange({ ...o, department_id })} /></Field>
        <Field label="Employee id"><IdInput aria-label="new employee id" className="w-32" value={e.id} onCommit={(id) => setE({ ...e, id })} /></Field>
        <Field label="Name"><Input aria-label="new employee name" className="w-36" value={e.name ?? ""} onChange={(ev) => setE({ ...e, name: ev.target.value })} /></Field>
        <Field label="Skills (comma)">
          <Input key={e.skills.join(",")} aria-label="new employee skills" className="w-44" defaultValue={e.skills.join(", ")}
            onBlur={(ev) => setE({ ...e, skills: [...new Set(ev.target.value.split(",").map((s) => s.trim()).filter(Boolean))] })} />
        </Field>
        <Field label="Cost/h"><NumInput aria-label="new employee cost per hour" className="w-20" value={e.cost_per_hour} onCommit={(cost_per_hour) => setE({ ...e, cost_per_hour })} /></Field>
        <Field label="Speed"><NumInput aria-label="new employee speed factor" className="w-20" value={e.speed_factor ?? 1} lo={0.01} onCommit={(speed_factor) => setE({ ...e, speed_factor })} /></Field>
        <div className="flex basis-full flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground [&>*]:normal-case [&>*]:tracking-normal">Schedule
          <ScheduleEditor id="new employee" schedule={e.schedule ?? weekdays9to5()} onChange={(schedule) => setE({ ...e, schedule })} />
        </div>
      </>;
      break;
    }
    case "remove_resource":
      body = <Field label="Resource"><Pick label="removed resource" className="w-56" value={o.resource_id} items={resItems} onChange={(resource_id) => onChange({ ...o, resource_id })} /></Field>;
      break;
    case "set_pool_headcount": {
      const pools = Object.fromEntries(resources(c).filter(({ r }) => r.headcount !== undefined).map(({ r, d }) => [r.id, `${r.id} (${d.id}) ×${r.headcount}`]));
      body = <>
        <Field label="Pool"><Pick label="pool" className="w-56" value={o.pool_id} items={pools} onChange={(pool_id) => onChange({ ...o, pool_id })} /></Field>
        <Field label="Headcount"><NumInput aria-label="pool headcount" className="w-20" value={o.headcount} onCommit={(v) => onChange({ ...o, headcount: Math.floor(v) })} /></Field>
      </>;
      break;
    }
    case "absence":
      body = <>
        <Field label="Resource"><Pick label="absent resource" className="w-56" value={o.resource_id} items={resItems} onChange={(resource_id) => onChange({ ...o, resource_id })} /></Field>
        <MinuteRange label="absence" start={o.start} end={o.end} onChange={(start, end) => onChange({ ...o, start, end })} />
      </>;
      break;
  }
  return (
    <div className="rise flex flex-col gap-3 rounded-xl p-3 glass-inset">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-xs text-primary">{o.type}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={`remove ${o.type} overlay`} onClick={onRemove}><Trash2 className="size-3.5" /></Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">{body}</div>
    </div>
  );
}
