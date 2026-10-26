"use client";

import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NumInput, ScheduleEditor, clamp } from "@/components/editor-fields";
import { renameInflow, stepIssues } from "@/components/process/graph";
import { type Company, type Dist, type Inflow, type Step, type Workflow, durationMean, idFor } from "@/lib/company";

const NONE = "__none__";

/** The duration written when the mean is edited: const stays const, anything else becomes lognormal_mean. */
export function withMean(d: Dist, mean: number): Dist {
  if (d.kind === "const" || (d.kind === "lognormal" && d.b === 0)) return { kind: "const", a: mean }; // sigma 0 is deterministic; the loader rejects it
  return { kind: "lognormal_mean", mean, sigma: d.b ?? d.sigma ?? 0.4 };
}

type Props = { wf: Workflow; company: Company; onChange: (w: Workflow) => void; onRemove: () => void };

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="flex flex-col gap-1"><Label className="text-xs text-muted-foreground">{label}</Label>{children}</div>;
const Pick = ({ label, items, value, onChange }: { label: string; items: Record<string, string>; value: string; onChange: (v: string) => void }) => (
  <Select items={items} value={value} onValueChange={(v) => v && onChange(v)}>
    <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
    <SelectContent>{Object.entries(items).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
  </Select>
);
const RemoveBtn = ({ onRemove }: { onRemove: () => void }) => <Button variant="ghost" size="sm" className="self-start rounded-full" onClick={onRemove}><Trash2 className="size-3.5" /> Remove</Button>;

function StepPanel({ wf, company, st, onChange, onRemove }: Props & { st: Step }) {
  const id = st.id;
  const set = (patch: Partial<Step>) => onChange({ ...wf, steps: wf.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const skillsOf = (deptId: string) => [...new Set(company.departments.find((d) => d.id === deptId)?.resources.flatMap((r) => r.skills) ?? [])].sort();
  const skills = skillsOf(st.department_id);
  const mean = durationMean(st.duration);
  const deptItems = { [NONE]: "— none —", ...Object.fromEntries(company.departments.map((d) => [d.id, d.name])) };
  const systemItems = { [NONE]: "none", ...Object.fromEntries(company.systems.map((s) => [s.id, s.id])) };
  const reworkItems = { [NONE]: "none", [id]: `${id} (self)`, ...Object.fromEntries((st.depends_on ?? []).map((d) => [d, d])) };
  const waits = (st.depends_on ?? []).map((d) => wf.steps.find((s) => s.id === d)?.name ?? d).join(", ");
  const commitSkill = (e: React.FocusEvent<HTMLInputElement>) => { const v = e.target.value.trim(); if (v !== st.required_skill) set({ required_skill: v }); };
  return (
    <>
      {stepIssues(company, wf, st).map((i) => <p key={i.text} className="text-xs text-amber-400">{i.text.startsWith("Nobody in") ? `${i.text}. Typing a skill here does not give it to anyone; add it on the People page.` : i.text}</p>)}
      <Field label="Department">
        <Pick label={`department of step ${id}`} items={deptItems} value={st.department_id || NONE} onChange={(v) => {
          if (v === NONE) return set({ department_id: "" });
          const ks = skillsOf(v);
          set({ department_id: v, required_skill: ks.includes(st.required_skill) ? st.required_skill : ks.length === 1 ? ks[0] : "" });
        }} />
      </Field>
      <Field label="Skill">
        <Input key={`${st.department_id}:${st.required_skill}`} aria-label={`skill of step ${id}`} list={`skills-${id}`} defaultValue={st.required_skill} onBlur={commitSkill} />
        <datalist id={`skills-${id}`}>{skills.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field label="Mean duration (min)">
        {mean === null ? <span className="text-xs text-muted-foreground">duration kind `{st.duration.kind}`: edit in the JSON tab</span>
          : <NumInput min={0.01} lo={0.01} aria-label={`mean minutes of step ${id}`} className="w-full tabular-nums" value={Number(mean.toFixed(2))} onCommit={(v) => set({ duration: withMean(st.duration, v) })} />}
      </Field>
      <Field label="System"><Pick label={`system of step ${id}`} items={systemItems} value={st.system_id ?? NONE} onChange={(v) => set({ system_id: v === NONE ? null : v })} /></Field>
      <Field label="SLA minutes">
        <Input key={st.sla_minutes ?? "none"} type="number" min={0} aria-label={`sla minutes of step ${id}`} className="w-full tabular-nums" defaultValue={st.sla_minutes ?? ""} placeholder="none"
          onBlur={(e) => { const v = clamp(Number(e.target.value), 0, Infinity) || null; if (v !== (st.sla_minutes ?? null)) set({ sla_minutes: v }); }} />
      </Field>
      <p className="text-xs text-muted-foreground">Waits for: {waits || "nothing (entry step)"}</p>
      <details className="flex flex-col gap-3 text-sm [&>summary]:cursor-pointer [&[open]>summary]:mb-3">
        <summary>Advanced</summary>
        <div className="flex flex-col gap-3">
          <Field label="Priority"><NumInput lo={-1e9} hi={1e9} aria-label={`priority of step ${id}`} className="w-full tabular-nums" value={st.priority ?? 0} onCommit={(v) => set({ priority: Math.floor(v) })} /></Field>
          <Field label="Fail %"><NumInput hi={100} aria-label={`failure percent of step ${id}`} className="w-full tabular-nums" value={Number(((st.failure_prob ?? 0) * 100).toFixed(2))} onCommit={(v) => set({ failure_prob: v / 100 })} /></Field>
          <Field label="Rework to"><Pick label={`rework target of step ${id}`} items={reworkItems} value={st.rework_to ?? NONE} onChange={(v) => set({ rework_to: v === NONE ? null : v })} /></Field>
          <Field label="Retries"><NumInput aria-label={`retries of step ${id}`} className="w-full tabular-nums" value={st.max_retries ?? 0} onCommit={(v) => set({ max_retries: Math.floor(v) })} /></Field>
          {st.duration.kind === "lognormal_mean" && mean !== null && (
            <Field label="Sigma"><NumInput lo={0.05} hi={3} aria-label={`sigma of step ${id}`} className="w-full tabular-nums" value={st.duration.sigma ?? 0.4} onCommit={(v) => set({ duration: { kind: "lognormal_mean", mean, sigma: v } })} /></Field>
          )}
        </div>
      </details>
      <RemoveBtn onRemove={onRemove} />
    </>
  );
}

function InflowPanel({ wf, inflow, onChange, onRemove, onRenamed }: Omit<Props, "company"> & { inflow: Inflow; onRenamed: (id: string) => void }) {
  const set = (patch: Partial<Inflow>) => onChange({ ...wf, inflows: wf.inflows!.map((i) => (i.id === inflow.id ? { ...i, ...patch } : i)) });
  const otherIds = [...wf.steps.map((s) => s.id), ...wf.inflows!.filter((i) => i.id !== inflow.id).map((i) => i.id)];
  const enters = inflow.entry.map((e) => wf.steps.find((s) => s.id === e)?.name ?? e).join(", ");
  return (
    <>
      <Field label="Name">
        <Input key={inflow.name} aria-label={`name of inflow ${inflow.id}`} defaultValue={inflow.name} onBlur={(e) => {
          const name = e.target.value.trim();
          if (!name) e.target.value = inflow.name;
          else if (name !== inflow.name) {
            const to = idFor(name, otherIds, "inflow", inflow.id);
            onChange(renameInflow({ ...wf, inflows: wf.inflows!.map((i) => (i.id === inflow.id ? { ...i, name } : i)) }, inflow.id, to));
            onRenamed(to); // the canvas selection follows the id
          }
        }} />
      </Field>
      <Field label="Rate per hour"><NumInput min={0} aria-label={`rate per hour of inflow ${inflow.id}`} className="w-full tabular-nums" value={inflow.rate_per_hour} onCommit={(v) => set({ rate_per_hour: v })} /></Field>
      <Field label="Window"><ScheduleEditor id={`inflow ${inflow.id}`} schedule={inflow.window} onChange={(window) => set({ window })} /></Field>
      <p className="text-xs text-muted-foreground">Enters at: {enters || "no step yet"}</p>
      <RemoveBtn onRemove={onRemove} />
    </>
  );
}

/** Side panel for the selected canvas node; `wf` is in inflows form. */
export function DetailPanel({ wf, company, selected, onChange, onClose, onRemove, onRenamed }: Props & { selected: string; onClose: () => void; onRenamed: (id: string) => void }) {
  const st = wf.steps.find((s) => s.id === selected);
  const inflow = wf.inflows?.find((i) => i.id === selected);
  if (!st && !inflow) return null;
  return (
    <aside aria-label="detail panel" className="glass rise relative flex flex-col gap-3 self-start overflow-y-auto rounded-2xl p-4">
      <Button variant="ghost" size="icon-sm" aria-label="close panel" className="absolute top-2 right-2" onClick={onClose}><X className="size-4" /></Button>
      <h3 className="pr-6 text-sm font-medium">{st?.name ?? inflow!.name}</h3>
      {st ? <StepPanel wf={wf} company={company} st={st} onChange={onChange} onRemove={onRemove} /> : <InflowPanel wf={wf} inflow={inflow!} onChange={onChange} onRemove={onRemove} onRenamed={onRenamed} />}
    </aside>
  );
}
