"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { IdInput, ScheduleEditor, uniqueId } from "@/components/company-editor";
import { type Company, type Step, type Workflow, durationMean, weekdays9to5 } from "@/lib/company";

const NONE = "__none__";
const num = (v: string, lo = 0) => Math.max(lo, Number(v) || 0);

export function WorkflowsEditor({ company, onChange }: { company: Company; onChange: (c: Company) => void }) {
  const setWf = (i: number, w: Workflow) => onChange({ ...company, workflows: company.workflows.map((x, j) => (j === i ? w : x)) });
  return (
    <>
      {company.workflows.map((w, i) => (
        <WorkflowCard key={i} wf={w} company={company} onChange={(x) => setWf(i, x)}
          onRemove={() => onChange({ ...company, workflows: company.workflows.filter((_, j) => j !== i) })} />
      ))}
      <Button variant="outline" onClick={() => onChange({ ...company, workflows: [...company.workflows, {
        id: uniqueId("workflow", company.workflows), name: "New workflow", arrival: { rate_per_hour: 1, window: weekdays9to5() }, steps: [] }] })}>
        Add workflow
      </Button>
    </>
  );
}

function WorkflowCard({ wf, company, onChange, onRemove }: { wf: Workflow; company: Company; onChange: (w: Workflow) => void; onRemove: () => void }) {
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
    <Card>
      <CardHeader>
        <div className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
          <IdInput aria-label={`workflow id ${wf.id}`} value={wf.id} onCommit={(id) => onChange({ ...wf, id })} />
          <Input aria-label={`workflow name ${wf.id}`} value={wf.name} onChange={(e) => onChange({ ...wf, name: e.target.value })} />
          <label className="flex items-center gap-1 text-xs">arrivals/h
            <Input type="number" step="any" min={0} aria-label={`arrival rate of ${wf.id}`} className="w-20" value={wf.arrival.rate_per_hour}
              onChange={(e) => onChange({ ...wf, arrival: { ...wf.arrival, rate_per_hour: num(e.target.value) } })} />
          </label>
          <Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
        </div>
        <div className="text-xs">Arrival window: <ScheduleEditor id={`arrivals of ${wf.id}`} schedule={wf.arrival.window} onChange={(window) => onChange({ ...wf, arrival: { ...wf.arrival, window } })} /></div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Id</TableHead><TableHead>Name</TableHead><TableHead>Department</TableHead><TableHead>Skill</TableHead>
              <TableHead>Mean min</TableHead><TableHead>Depends on (comma)</TableHead><TableHead>System</TableHead><TableHead>Prio</TableHead>
              <TableHead>SLA min</TableHead><TableHead>Fail %</TableHead><TableHead>Rework to</TableHead><TableHead>Retries</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {wf.steps.map((st, i) => {
              const skills = skillsOf(st.department_id);
              const skillItems = Object.fromEntries((skills.includes(st.required_skill) ? skills : [st.required_skill, ...skills]).map((s) => [s, s]));
              const mean = durationMean(st.duration);
              const reworkItems = { [NONE]: "none", [st.id]: `${st.id} (self)`, ...Object.fromEntries((st.depends_on ?? []).map((d) => [d, d])) };
              return (
                <TableRow key={i}>
                  <TableCell><IdInput aria-label={`id of step ${st.id}`} className="w-24" value={st.id} onCommit={(id) => setStep(i, { ...st, id })} /></TableCell>
                  <TableCell><Input aria-label={`name of step ${st.id}`} className="w-28" value={st.name} onChange={(e) => setStep(i, { ...st, name: e.target.value })} /></TableCell>
                  <TableCell>
                    <Select items={Object.fromEntries(depts.map((d) => [d.id, d.id]))} value={st.department_id}
                      onValueChange={(v) => v && setStep(i, { ...st, department_id: v, required_skill: skillsOf(v).includes(st.required_skill) ? st.required_skill : (skillsOf(v)[0] ?? "") })}>
                      <SelectTrigger aria-label={`department of step ${st.id}`} className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>{depts.map((d) => <SelectItem key={d.id} value={d.id}>{d.id}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select items={skillItems} value={st.required_skill} onValueChange={(v) => v && setStep(i, { ...st, required_skill: v })}>
                      <SelectTrigger aria-label={`skill of step ${st.id}`} className="w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.keys(skillItems).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {mean === null ? <span className="text-xs">{st.duration.kind}: JSON tab</span> : (
                      <Input type="number" step="any" min={0} aria-label={`mean minutes of step ${st.id}`} className="w-20" value={Number(mean.toFixed(2))}
                        onChange={(e) => setStep(i, { ...st, duration: { kind: "lognormal_mean", mean: num(e.target.value, 0.01), sigma: st.duration.kind === "lognormal" ? st.duration.b : st.duration.sigma ?? 0.4 } })} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Input key={(st.depends_on ?? []).join(",")} aria-label={`dependencies of step ${st.id}`} className="w-32" defaultValue={(st.depends_on ?? []).join(", ")}
                      onBlur={(e) => setStep(i, { ...st, depends_on: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                  </TableCell>
                  <TableCell>
                    <Select items={systemItems} value={st.system_id ?? NONE} onValueChange={(v) => setStep(i, { ...st, system_id: v && v !== NONE ? v : null })}>
                      <SelectTrigger aria-label={`system of step ${st.id}`} className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.entries(systemItems).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell><Input type="number" aria-label={`priority of step ${st.id}`} className="w-16" value={st.priority ?? 0} onChange={(e) => setStep(i, { ...st, priority: Math.floor(Number(e.target.value) || 0) })} /></TableCell>
                  <TableCell><Input type="number" min={0} aria-label={`sla minutes of step ${st.id}`} className="w-20" value={st.sla_minutes ?? ""} placeholder="none"
                    onChange={(e) => setStep(i, { ...st, sla_minutes: e.target.value === "" ? null : num(e.target.value) })} /></TableCell>
                  <TableCell><Input type="number" min={0} max={100} step="any" aria-label={`failure percent of step ${st.id}`} className="w-16" value={Number(((st.failure_prob ?? 0) * 100).toFixed(2))}
                    onChange={(e) => setStep(i, { ...st, failure_prob: Math.min(100, num(e.target.value)) / 100 })} /></TableCell>
                  <TableCell>
                    <Select items={reworkItems} value={st.rework_to ?? NONE} onValueChange={(v) => setStep(i, { ...st, rework_to: v && v !== NONE ? v : null })}>
                      <SelectTrigger aria-label={`rework target of step ${st.id}`} className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.entries(reworkItems).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell><Input type="number" min={0} aria-label={`retries of step ${st.id}`} className="w-16" value={st.max_retries ?? 0} onChange={(e) => setStep(i, { ...st, max_retries: Math.floor(num(e.target.value)) })} /></TableCell>
                  <TableCell><Button variant="ghost" size="sm" aria-label={`remove step ${st.id}`} onClick={() => removeStep(i)}>Remove</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Button variant="outline" size="sm" onClick={addStep} disabled={!depts.length}>Add step</Button>
      </CardContent>
    </Card>
  );
}
