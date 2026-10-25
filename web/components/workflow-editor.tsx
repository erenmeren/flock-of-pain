"use client";

import { Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { IconTile } from "@/components/page";
import { INLINE_INPUT, TABLE_STYLE, accent } from "@/components/org/parts";
import { StepNumber } from "@/components/process/step-chain";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { IdInput, NumInput, ScheduleEditor, clamp, uniqueId } from "@/components/editor-fields";
import { type Company, type Dist, type Step, type Workflow, durationMean } from "@/lib/company";

const NONE = "__none__";

/** The duration written when the mean is edited: const stays const, anything else becomes lognormal_mean. */
function withMean(d: Dist, mean: number): Dist {
  if (d.kind === "const" || (d.kind === "lognormal" && d.b === 0)) return { kind: "const", a: mean }; // sigma 0 is deterministic; the loader rejects it
  return { kind: "lognormal_mean", mean, sigma: d.b ?? d.sigma ?? 0.4 };
}

export function WorkflowCard({ wf, company, onChange, onRemove }: { wf: Workflow; company: Company; onChange: (w: Workflow) => void; onRemove: () => void }) {
  const depts = company.departments;
  const skillsOf = (deptId: string) => [...new Set(depts.find((d) => d.id === deptId)?.resources.flatMap((r) => r.skills) ?? [])].sort();
  const systemItems = { [NONE]: "none", ...Object.fromEntries(company.systems.map((s) => [s.id, s.id])) };
  const setStep = (i: number, st: Step) => {
    const old = wf.steps[i];
    let steps = wf.steps.map((x, j) => (j === i ? st : x));
    if (old.id !== st.id && !wf.steps.some((x, j) => j !== i && x.id === st.id)) // references follow a step rename
      steps = steps.map((x) => ({ ...x, depends_on: x.depends_on?.map((d) => (d === old.id ? st.id : d)), rework_to: x.rework_to === old.id ? st.id : x.rework_to }));
    onChange({ ...wf, steps });
  };
  const removeStep = (i: number) => {
    const gone = wf.steps[i].id;
    onChange({ ...wf, steps: wf.steps.filter((_, j) => j !== i).map((x) => ({
      ...x, depends_on: x.depends_on?.filter((d) => d !== gone), rework_to: x.rework_to === gone ? null : x.rework_to })) });
  };
  const addStep = () => {
    const dept = depts[0];
    onChange({ ...wf, steps: [...wf.steps, { id: uniqueId("step", wf.steps), name: "New step", department_id: dept?.id ?? "", required_skill: skillsOf(dept?.id ?? "")[0] ?? "",
      duration: { kind: "lognormal_mean", mean: 10, sigma: 0.4 }, depends_on: wf.steps.length ? [wf.steps[wf.steps.length - 1].id] : [] }] });
  };

  return (
    <Card className="rise">
      <CardHeader className="flex flex-col gap-3">
        <div className="flex w-full flex-wrap items-center gap-3">
          <IconTile icon={WorkflowIcon} />
          <div className="flex min-w-60 flex-1 flex-col gap-0.5">
            <Input aria-label={`workflow name ${wf.id}`} className={`h-7 text-base! font-medium ${INLINE_INPUT}`} value={wf.name} onChange={(e) => onChange({ ...wf, name: e.target.value })} />
            {/* shortcut: a workflow rename does not follow into scenario overlays (arrival_multiplier.workflow_id), which live in the scenarios JSON */}
            <IdInput aria-label={`workflow id ${wf.id}`} className={`h-6 font-mono text-xs! text-muted-foreground ${INLINE_INPUT}`} value={wf.id} onCommit={(id) => onChange({ ...wf, id })} />
          </div>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onRemove}><Trash2 className="size-3.5" /> Remove</Button>
        </div>
        <div className="flex w-full flex-wrap items-start gap-3">
          <label className="flex flex-col gap-1.5 rounded-xl p-3 glass-inset text-[11px] uppercase tracking-wide text-muted-foreground">Arrivals / hour
            <NumInput min={0} aria-label={`arrival rate of ${wf.id}`} className="h-7 w-24 tabular-nums" value={wf.arrival.rate_per_hour}
              onCommit={(v) => onChange({ ...wf, arrival: { ...wf.arrival, rate_per_hour: v } })} />
          </label>
          <div className="flex flex-col gap-1.5 rounded-xl p-3 glass-inset">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Arrival window</span>
            <ScheduleEditor id={`arrivals of ${wf.id}`} schedule={wf.arrival.window} onChange={(window) => onChange({ ...wf, arrival: { ...wf.arrival, window } })} />
          </div>
        </div>
      </CardHeader>
      <CardContent className={`flex flex-col gap-3 ${TABLE_STYLE}`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead><TableHead>Department</TableHead><TableHead>Skill</TableHead>
              <TableHead className="text-right">Mean min</TableHead><TableHead>Depends on</TableHead><TableHead>System</TableHead><TableHead className="text-right">Prio</TableHead>
              <TableHead className="text-right">SLA min</TableHead><TableHead className="text-right">Fail %</TableHead><TableHead>Rework to</TableHead><TableHead className="text-right">Retries</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {wf.steps.map((st, i) => {
              const skills = skillsOf(st.department_id);
              const unskilled = !skills.includes(st.required_skill); // the engine would queue these tasks forever
              const skillValue = st.required_skill || NONE;
              const skillItems = Object.fromEntries([...(unskilled ? [[skillValue, st.required_skill || "(none)"]] : []), ...skills.map((s) => [s, s])]);
              const mean = durationMean(st.duration);
              const di = depts.findIndex((d) => d.id === st.department_id);
              const reworkItems = { [NONE]: "none", [st.id]: `${st.id} (self)`, ...Object.fromEntries((st.depends_on ?? []).map((d) => [d, d])) };
              return (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <StepNumber n={i + 1} color={di < 0 ? "oklch(0.5 0 0)" : accent(di)} />
                      <div className="flex flex-col gap-0.5">
                        <Input aria-label={`name of step ${st.id}`} className={`w-36 font-medium ${INLINE_INPUT}`} value={st.name} onChange={(e) => setStep(i, { ...st, name: e.target.value })} />
                        <IdInput aria-label={`id of step ${st.id}`} className={`h-6! w-36 font-mono text-xs! text-muted-foreground ${INLINE_INPUT}`} value={st.id} onCommit={(id) => setStep(i, { ...st, id })} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select items={Object.fromEntries(depts.map((d) => [d.id, d.id]))} value={st.department_id}
                      onValueChange={(v) => v && setStep(i, { ...st, department_id: v, required_skill: skillsOf(v).includes(st.required_skill) ? st.required_skill : (skillsOf(v)[0] ?? "") })}>
                      <SelectTrigger aria-label={`department of step ${st.id}`} className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>{depts.map((d) => <SelectItem key={d.id} value={d.id}>{d.id}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select items={skillItems} value={skillValue} onValueChange={(v) => v && v !== NONE && setStep(i, { ...st, required_skill: v })}>
                      <SelectTrigger aria-label={`skill of step ${st.id}`} className="w-32" aria-invalid={unskilled} title={unskilled ? "no resource in this department has this skill" : undefined}><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.keys(skillItems).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right">
                    {mean === null ? <span className="text-xs text-muted-foreground">{st.duration.kind}: JSON tab</span> : (
                      <NumInput min={0.01} lo={0.01} aria-label={`mean minutes of step ${st.id}`} className="ml-auto w-20 text-right tabular-nums" value={Number(mean.toFixed(2))}
                        onCommit={(v) => setStep(i, { ...st, duration: withMean(st.duration, v) })} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Input key={(st.depends_on ?? []).join(",")} aria-label={`dependencies of step ${st.id}`} className="w-36" placeholder="step ids, comma-separated" defaultValue={(st.depends_on ?? []).join(", ")}
                      onBlur={(e) => {
                        const ids = new Set(wf.steps.filter((x) => x.id !== st.id).map((x) => x.id));
                        const depends_on = [...new Set(e.target.value.split(",").map((s) => s.trim()).filter((d) => ids.has(d)))]; // unknown and self dropped
                        const rework_to = st.rework_to === st.id || (st.rework_to && depends_on.includes(st.rework_to)) ? st.rework_to : null;
                        setStep(i, { ...st, depends_on, rework_to });
                      }} />
                  </TableCell>
                  <TableCell>
                    <Select items={systemItems} value={st.system_id ?? NONE} onValueChange={(v) => setStep(i, { ...st, system_id: v && v !== NONE ? v : null })}>
                      <SelectTrigger aria-label={`system of step ${st.id}`} className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.entries(systemItems).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right"><NumInput lo={-1e9} hi={1e9} aria-label={`priority of step ${st.id}`} className="ml-auto w-16 text-right tabular-nums" value={st.priority ?? 0} onCommit={(v) => setStep(i, { ...st, priority: Math.floor(v) })} /></TableCell>
                  <TableCell className="text-right"><Input key={st.sla_minutes ?? "none"} type="number" min={0} aria-label={`sla minutes of step ${st.id}`} className="ml-auto w-20 text-right tabular-nums" defaultValue={st.sla_minutes ?? ""} placeholder="none"
                    onBlur={(e) => { const v = clamp(Number(e.target.value), 0, Infinity); setStep(i, { ...st, sla_minutes: v > 0 ? v : null }); }} /></TableCell>
                  <TableCell className="text-right"><NumInput hi={100} aria-label={`failure percent of step ${st.id}`} className="ml-auto w-16 text-right tabular-nums" value={Number(((st.failure_prob ?? 0) * 100).toFixed(2))}
                    onCommit={(v) => setStep(i, { ...st, failure_prob: v / 100 })} /></TableCell>
                  <TableCell>
                    <Select items={reworkItems} value={st.rework_to ?? NONE} onValueChange={(v) => setStep(i, { ...st, rework_to: v && v !== NONE ? v : null })}>
                      <SelectTrigger aria-label={`rework target of step ${st.id}`} className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.entries(reworkItems).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right"><NumInput aria-label={`retries of step ${st.id}`} className="ml-auto w-16 text-right tabular-nums" value={st.max_retries ?? 0} onCommit={(v) => setStep(i, { ...st, max_retries: Math.floor(v) })} /></TableCell>
                  <TableCell><Button variant="ghost" size="sm" aria-label={`remove step ${st.id}`} onClick={() => removeStep(i)}>Remove</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Button variant="outline" size="sm" className="self-start rounded-full" onClick={addStep} disabled={!depts.length}><Plus className="size-3.5" /> Add step</Button>
      </CardContent>
    </Card>
  );
}
