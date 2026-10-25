"use client";

import { useState } from "react";
import { Plus, Users } from "lucide-react";
import { PageHeader } from "@/components/page";
import { IdInput, NumInput, ScheduleEditor, uniqueId } from "@/components/editor-fields";
import { Avatar, DeptMark, INLINE_INPUT, Loading, OrgNav, SkillsInput, TableCard } from "@/components/org/parts";
import { type Loc, addResource, allResources, isPool, movePerson, removeResource, setResource } from "@/components/org/ops";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Resource, renameInScenarios, scenarioRefs, weekdays9to5 } from "@/lib/company";
import { useTwin } from "@/lib/store";

const ALL = "__all__";
const NONE = "__none__";

export default function PeoplePage() {
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const [filter, setFilter] = useState(ALL);
  if (!company) return <Loading />;
  const resources = allResources(company);
  const people = company.departments.flatMap((d, di) => d.resources.map((r, ri) => ({ r, loc: { di, ri } as Loc })))
    .filter(({ r, loc }) => !isPool(r) && (filter === ALL || company.departments[loc.di].id === filter));
  const deptItems = Object.fromEntries(company.departments.map((d) => [d.id, d.name]));
  const poolById = new Map(resources.filter(isPool).map((p) => [p.id, p]));
  const inScenarios = scenarioRefs(scenarios).resources;

  const addPerson = () => {
    const di = Math.max(0, company.departments.findIndex((d) => d.id === filter));
    const dept = company.departments[di];
    if (!dept) return;
    const person: Resource = { id: uniqueId("emp", resources), skills: [], cost_per_hour: 0, schedule: weekdays9to5() };
    const withPerson = addResource(company, di, person);
    const pool = dept.resources.find(isPool);
    // joining the first pool goes through setResource so the pool grows by one and capacity stays unchanged
    setCompany(pool ? setResource(withPerson, { di, ri: dept.resources.length }, { ...person, skills: pool.skills, cost_per_hour: pool.cost_per_hour, schedule: null, pool_id: pool.id }) : withPerson);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="People" subtitle={`${people.length} named people`} />
      <OrgNav />
      <TableCard title="Named people" subtitle="Individuals with their own skills, cost, speed and schedule" icon={Users} action={
        <>
          <Select value={filter} items={{ [ALL]: "All departments", ...deptItems }} onValueChange={(v) => setFilter(v ?? ALL)}>
            <SelectTrigger aria-label="filter by department" size="sm" className="w-44 rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {company.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="rounded-full" disabled={!company.departments.length} onClick={addPerson}><Plus /> Add person</Button>
        </>
      }>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead><TableHead>Department · pool</TableHead><TableHead>Skills (comma)</TableHead>
              <TableHead className="text-right">Cost/h</TableHead><TableHead className="text-right">Speed</TableHead><TableHead>Schedule</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map(({ r, loc }) => {
              const set = (next: Resource) => {
                const out = setResource(company, loc, next);
                const id = out.departments[loc.di].resources[loc.ri].id; // setResource may reject the new id
                setCompany(out);
                if (id !== r.id) setScenarios(renameInScenarios(scenarios, "resource_id", r.id, id));
              };
              const dept = company.departments[loc.di];
              const poolItems: Record<string, string> = { [NONE]: "standalone", ...Object.fromEntries(dept.resources.filter(isPool).map((p) => [p.id, p.id])) };
              if (r.pool_id && !(r.pool_id in poolItems)) poolItems[r.pool_id] = `${r.pool_id} (other department)`;
              const setPool = (v: string | null) => set(v && v !== NONE ? { ...r, pool_id: v, schedule: null }
                : { ...r, pool_id: undefined, schedule: r.schedule ?? poolById.get(r.pool_id ?? "")?.schedule ?? weekdays9to5() });
              return (
                <TableRow key={`${loc.di}:${loc.ri}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={r.name || r.id} />
                      <div className="flex flex-col gap-0.5">
                        <Input aria-label={`name of ${r.id}`} className={`w-36 font-medium ${INLINE_INPUT}`} value={r.name ?? ""} onChange={(e) => set({ ...r, name: e.target.value || undefined })} />
                        <IdInput aria-label={`id of ${r.id}`} className={`h-6! w-36 font-mono text-xs! text-muted-foreground ${INLINE_INPUT}`} value={r.id} onCommit={(id) => set({ ...r, id })} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <DeptMark index={loc.di} size="size-6" />
                      <div className="flex flex-col gap-1">
                        <Select value={dept.id} items={deptItems} onValueChange={(v) => {
                          const to = company.departments.findIndex((d) => d.id === v);
                          if (to >= 0) setCompany(movePerson(company, loc, to));
                        }}>
                          <SelectTrigger aria-label={`department of ${r.id}`} className="w-40"><SelectValue /></SelectTrigger>
                          <SelectContent>{company.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
                        </Select>
                        <Select items={poolItems} value={r.pool_id ?? NONE} onValueChange={setPool}>
                          <SelectTrigger aria-label={`pool of ${r.id}`} className="w-40 text-muted-foreground"><SelectValue /></SelectTrigger>
                          <SelectContent>{Object.entries(poolItems).map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><SkillsInput id={r.id} skills={r.skills} onCommit={(skills) => set({ ...r, skills })} /></TableCell>
                  <TableCell className="text-right"><NumInput aria-label={`cost per hour of ${r.id}`} className="ml-auto w-20 text-right tabular-nums" value={r.cost_per_hour} onCommit={(v) => set({ ...r, cost_per_hour: v })} /></TableCell>
                  <TableCell className="text-right"><NumInput aria-label={`speed factor of ${r.id}`} className="ml-auto w-16 text-right tabular-nums" lo={0.01} value={r.speed_factor ?? 1} onCommit={(v) => set({ ...r, speed_factor: v })} /></TableCell>
                  <TableCell>
                    {r.pool_id !== undefined && (
                      <Label className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Checkbox aria-label={`${r.id} inherits pool schedule`} checked={r.schedule === null}
                          onCheckedChange={(c) => set({ ...r, schedule: c ? null : poolById.get(r.pool_id ?? "")?.schedule ?? weekdays9to5() })} /> inherit pool
                      </Label>
                    )}
                    {r.schedule ? <ScheduleEditor id={r.id} schedule={r.schedule} onChange={(s) => set({ ...r, schedule: s })} />
                      : r.pool_id === undefined && <Button variant="outline" size="sm" onClick={() => set({ ...r, schedule: weekdays9to5() })}>Add schedule</Button>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" aria-label={`remove ${r.id}`} disabled={inScenarios.has(r.id)} title={inScenarios.has(r.id) ? "referenced by a scenario" : undefined}
                      onClick={() => confirm(`Remove "${r.id}"?`) && setCompany(removeResource(company, loc))}>Remove</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {people.length === 0 && <p className="mt-2 rounded-2xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">No named people{filter === ALL ? "" : " in this department"}.</p>}
      </TableCard>
    </div>
  );
}
