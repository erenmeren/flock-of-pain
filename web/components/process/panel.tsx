"use client";

import { useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumInput, OptNumInput, Pick, ScheduleEditor, clamp } from "@/components/editor-fields";
import { fmt } from "@/components/page";
import { renameInflow, setBranch, stepIssues } from "@/components/process/graph";
import { type ApiError, fitArrivals, fitDurations } from "@/lib/api";
import { type Company, type Dist, type Inflow, type Profile, type Step, type Workflow, DAYS, durationMean, firstColumn, idFor, parseHoursList, setMultiplier } from "@/lib/company";
import { useTwin } from "@/lib/store";

const NONE = "__none__", WAIT = "__wait__";

/** The duration written when the mean is edited: const stays const, anything else becomes lognormal_mean. */
export function withMean(d: Dist, mean: number): Dist {
  if (d.kind === "const" || (d.kind === "lognormal" && d.b === 0)) return { kind: "const", a: mean }; // sigma 0 is deterministic; the loader rejects it
  return { kind: "lognormal_mean", mean, sigma: d.b ?? d.sigma ?? 0.4 };
}

type Props = { wf: Workflow; company: Company; onChange: (w: Workflow) => void; onRemove: () => void };

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => <div className="flex flex-col gap-1"><Label className="gap-1 text-xs text-muted-foreground">{label}{hint && <Hint id={hint} />}</Label>{children}</div>;
const RemoveBtn = ({ onRemove }: { onRemove: () => void }) => <Button variant="destructive" size="sm" className="self-start rounded-full" onClick={onRemove}><Trash2 className="size-3.5" /> Remove</Button>;

/** "Fit from CSV…": a hidden file input behind a button; hands the picked file's text on. */
function CsvButton({ label, onText }: { label: string; onText: (text: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="flex items-center gap-1">
      <input ref={ref} type="file" accept=".csv,.tsv,.txt,text/csv" hidden aria-label={label}
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onText(await f.text()); }} />
      <Button variant="outline" size="sm" className="rounded-full" onClick={() => ref.current?.click()}>Fit from CSV…</Button>
      <Hint id="fit_csv" />
    </span>
  );
}

/** Runs an API fit; the result note is kept per node id so it does not show on another step. */
function useFit(id: string) {
  const { setError } = useTwin();
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const run = async (fit: () => Promise<string>) => {
    try { setNote({ id, text: await fit() }); setError(null); } catch (e) { setError(e as ApiError); }
  };
  return { note: note?.id === id ? note.text : "", run };
}

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
  const wait = st.required_skill === null;
  const kids = wf.steps.filter((s) => s.depends_on?.includes(id));
  const fit = useFit(id);
  const fitDuration = (text: string) => fit.run(async () => {
    const { n, p50, p90, ...duration } = await fitDurations(firstColumn(text).map(Number).filter(Number.isFinite));
    set({ duration });
    return `n ${n} · p50 ${fmt(p50)} · p90 ${fmt(p90)} min`;
  });
  const hoursText = (st.release_hours ?? []).join(", ");
  const patienceMean = st.patience ? durationMean(st.patience) : undefined;
  return (
    <>
      {stepIssues(company, wf, st).map((i) => <p key={i.text} className="text-xs text-amber-400">{i.text.startsWith("Nobody in") ? `${i.text}. Typing a skill here does not give it to anyone; add it on the People page.` : i.text}</p>)}
      <Field label="Department" hint="step_department">
        <Pick className="w-full" label={`department of step ${id}`} items={deptItems} value={st.department_id || NONE} onChange={(v) => {
          if (v === NONE) return set({ department_id: "" });
          const ks = skillsOf(v);
          set({ department_id: v, required_skill: wait ? null : ks.includes(st.required_skill!) ? st.required_skill : ks.length === 1 ? ks[0] : "" });
        }} />
      </Field>
      <Field label="Skill" hint="step_skill">
        {/* a wait step has no worker, so no system, failures or rework (loader rule) */}
        <Pick className="w-full" label={`work kind of step ${id}`} items={{ [WAIT]: "Waiting (nobody works)", [NONE]: "Someone with a skill" }} value={wait ? WAIT : NONE}
          onChange={(v) => (v === WAIT ? !wait && set({ required_skill: null, system_id: null, failure_prob: 0, rework_to: null, release_hours: undefined, patience: undefined }) : wait && set({ required_skill: skills.length === 1 ? skills[0] : "" }))} />
        {!wait && <>
          <Input key={`${st.department_id}:${st.required_skill}`} aria-label={`skill of step ${id}`} list={`skills-${id}`} defaultValue={st.required_skill ?? ""} onBlur={commitSkill} />
          <datalist id={`skills-${id}`}>{skills.map((s) => <option key={s} value={s} />)}</datalist>
        </>}
      </Field>
      <Field label="Mean duration (min)" hint="duration">
        {mean === null ? <span className="text-xs text-muted-foreground">duration kind `{st.duration.kind}`: edit in the JSON tab</span>
          : <NumInput min={0.01} lo={0.01} aria-label={`mean minutes of step ${id}`} className="w-full tabular-nums" value={Number(mean.toFixed(2))} onCommit={(v) => set({ duration: withMean(st.duration, v) })} />}
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><CsvButton label={`duration csv of step ${id}`} onText={fitDuration} />{fit.note}</span>
      </Field>
      {!wait && <Field label="System" hint="step_system"><Pick className="w-full" label={`system of step ${id}`} items={systemItems} value={st.system_id ?? NONE} onChange={(v) => set({ system_id: v === NONE ? null : v })} /></Field>}
      <Field label="SLA minutes" hint="sla">
        <Input key={st.sla_minutes ?? "none"} type="number" min={0} aria-label={`sla minutes of step ${id}`} className="w-full tabular-nums" defaultValue={st.sla_minutes ?? ""} placeholder="none"
          onBlur={(e) => { const v = clamp(Number(e.target.value), 0, Infinity) || null; if (v !== (st.sla_minutes ?? null)) set({ sla_minutes: v }); }} />
      </Field>
      <p className="text-xs text-muted-foreground">Waits for: {waits || "nothing (entry step)"}</p>
      {kids.length > 0 && (
        <Field label="Branches: chance in %" hint="branches">
          {kids.map((k) => {
            const p = st.branches?.find((b) => b.to === k.id)?.prob;
            return (
              <div key={k.id} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate">{k.name}</span>
                <Input key={p ?? "always"} type="number" min={0} max={100} aria-label={`branch percent from ${id} to ${k.id}`} className="h-7 w-20 tabular-nums" placeholder="always"
                  defaultValue={p === undefined ? "" : Number((p * 100).toFixed(2))}
                  onBlur={(e) => { const v = clamp(Number(e.target.value), 0, 100) / 100 || null; if (v !== (p ?? null)) onChange({ ...wf, steps: wf.steps.map((s) => (s.id === id ? setBranch(s, k.id, v) : s)) }); }} />
              </div>
            );
          })}
        </Field>
      )}
      <details className="flex flex-col gap-3 text-sm [&>summary]:cursor-pointer [&[open]>summary]:mb-3">
        <summary>Advanced</summary>
        <div className="flex flex-col gap-3">
          <Field label="Priority" hint="priority"><NumInput lo={-1e9} hi={1e9} aria-label={`priority of step ${id}`} className="w-full tabular-nums" value={st.priority ?? 0} onCommit={(v) => set({ priority: Math.floor(v) })} /></Field>
          {!wait && <>
          <Field label="Fail %" hint="fail"><NumInput hi={100} aria-label={`failure percent of step ${id}`} className="w-full tabular-nums" value={Number(((st.failure_prob ?? 0) * 100).toFixed(2))} onCommit={(v) => set({ failure_prob: v / 100 })} /></Field>
          <Field label="Rework to" hint="rework_to"><Pick className="w-full" label={`rework target of step ${id}`} items={reworkItems} value={st.rework_to ?? NONE} onChange={(v) => set({ rework_to: v === NONE ? null : v })} /></Field>
          <Field label="Release at hours" hint="release_hours">
            <Input key={hoursText} aria-label={`release hours of step ${id}`} className="w-full tabular-nums" placeholder="none, e.g. 12, 17" defaultValue={hoursText} onBlur={(e) => {
              const hs = parseHoursList(e.target.value);
              if (hs === null) { e.target.value = hoursText; return; } // not hours of day: keep what was stored
              if (hs.join(", ") !== hoursText) set({ release_hours: hs.length ? hs : undefined });
            }} />
          </Field>
          <Field label="Patience (min)" hint="patience">
            {patienceMean === null ? <span className="text-xs text-muted-foreground">patience kind `{st.patience!.kind}`: edit in the JSON tab</span>
              : <OptNumInput lo={0.01} aria-label={`patience minutes of step ${id}`} className="w-full tabular-nums" value={patienceMean === undefined ? undefined : Number(patienceMean.toFixed(2))}
                onCommit={(v) => set({ patience: v === undefined ? undefined : withMean(st.patience ?? { kind: "lognormal_mean", sigma: 0.6 }, v) })} />}
          </Field>
          <Field label="Retries" hint="retries"><NumInput aria-label={`retries of step ${id}`} className="w-full tabular-nums" value={st.max_retries ?? 0} onCommit={(v) => set({ max_retries: Math.floor(v) })} /></Field>
          </>}
          {st.duration.kind === "lognormal_mean" && mean !== null && (
            <Field label="Sigma" hint="sigma"><NumInput lo={0.05} hi={3} aria-label={`sigma of step ${id}`} className="w-full tabular-nums" value={st.duration.sigma ?? 0.4} onCommit={(v) => set({ duration: { kind: "lognormal_mean", mean, sigma: v } })} /></Field>
          )}
        </div>
      </details>
      <RemoveBtn onRemove={onRemove} />
    </>
  );
}

/** Hour-of-day and weekday multipliers on the rate; 1 everywhere writes no profile. */
function ProfileEditor({ id, profile, onChange, fit }: { id: string; profile?: Profile; onChange: (p: Profile | undefined) => void; fit: React.ReactNode }) {
  const row = (key: keyof Profile, labels: string[], cols: string) => (
    <div className={`grid gap-1 ${cols}`}>
      {labels.map((l, k) => (
        <label key={k} className="flex flex-col text-[10px] text-muted-foreground">{l}
          <NumInput aria-label={`${key === "hours" ? "hour" : "weekday"} ${l} multiplier of ${id}`} className="h-7 px-0 text-center text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" value={Math.round((profile?.[key]?.[String(k)] ?? 1) * 100)}
            onCommit={(v) => onChange(setMultiplier(profile, key, String(k), v / 100))} />
        </label>
      ))}
    </div>
  );
  return (
    <details className="text-sm [&>summary]:cursor-pointer [&[open]>summary]:mb-2">
      <summary>Demand profile</summary>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">Percent of the normal rate by hour of day, then by weekday. 100 = normal, 200 doubles the rate, 0 stops arrivals.</p>
        {fit}
        {row("hours", Array.from({ length: 24 }, (_, h) => String(h)), "grid-cols-6")}
        {row("weekdays", DAYS, "grid-cols-7")}
      </div>
    </details>
  );
}

function InflowPanel({ wf, inflow, onChange, onRemove, onRenamed }: Omit<Props, "company"> & { inflow: Inflow; onRenamed: (id: string) => void }) {
  const set = (patch: Partial<Inflow>) => onChange({ ...wf, inflows: wf.inflows!.map((i) => (i.id === inflow.id ? { ...i, ...patch } : i)) });
  const otherIds = [...wf.steps.map((s) => s.id), ...wf.inflows!.filter((i) => i.id !== inflow.id).map((i) => i.id)];
  const enters = inflow.entry.map((e) => wf.steps.find((s) => s.id === e)?.name ?? e).join(", ");
  const fit = useFit(inflow.id);
  const fitInflow = (text: string) => fit.run(async () => {
    const ts = firstColumn(text).filter((x) => !Number.isNaN(Date.parse(x)));
    const r = await fitArrivals(ts);
    const m = Object.entries(r.profile).filter(([, v]) => v && Object.keys(v).length); // the fit may send empty maps
    set({ rate_per_hour: r.rate_per_hour, profile: m.length ? Object.fromEntries(m) : undefined });
    return `${ts.length} arrivals over ${r.observed_days} days`;
  });
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
      <Field label="Rate per hour" hint="rate"><NumInput min={0} aria-label={`rate per hour of inflow ${inflow.id}`} className="w-full tabular-nums" value={inflow.rate_per_hour} onCommit={(v) => set({ rate_per_hour: v })} /></Field>
      <Field label="Window" hint="window"><ScheduleEditor id={`inflow ${inflow.id}`} schedule={inflow.window} onChange={(window) => set({ window })} /></Field>
      <ProfileEditor id={`inflow ${inflow.id}`} profile={inflow.profile} onChange={(profile) => set({ profile })}
        fit={<span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><CsvButton label={`arrivals csv of inflow ${inflow.id}`} onText={fitInflow} />{fit.note}</span>} />
      <p className="flex items-center gap-1 text-xs text-muted-foreground">Enters at: {enters || "no step yet"}<Hint id="entry" /></p>
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
      <Button variant="outline" size="icon-sm" aria-label="close panel" className="absolute top-2 right-2" onClick={onClose}><X className="size-4" /></Button>
      <h3 className="pr-6 text-sm font-medium">{st?.name ?? inflow!.name}</h3>
      {st ? <StepPanel wf={wf} company={company} st={st} onChange={onChange} onRemove={onRemove} /> : <InflowPanel wf={wf} inflow={inflow!} onChange={onChange} onRemove={onRemove} onRenamed={onRenamed} />}
    </aside>
  );
}
