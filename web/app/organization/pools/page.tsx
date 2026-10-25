"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page";
import { IdInput, NumInput, ScheduleEditor, uniqueId } from "@/components/editor-fields";
import { Loading, OrgNav, SkillsInput, TableCard, accent } from "@/components/org/parts";
import { type Loc, addResource, allResources, isPool, membersOf, removeResource, setResource } from "@/components/org/ops";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { renameInScenarios, scenarioRefs, slug, weekdays9to5 } from "@/lib/company";
import { useTwin } from "@/lib/store";

export default function PoolsPage() {
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const [target, setTarget] = useState(""); // department id new pools go to ("" = first)
  if (!company) return <Loading />;
  const pools = company.departments.flatMap((d, di) => d.resources.map((r, ri) => ({ r, loc: { di, ri } as Loc })).filter((x) => isPool(x.r)));
  const deptItems = Object.fromEntries(company.departments.map((d) => [d.id, d.name]));
  const inScenarios = scenarioRefs(scenarios).resources;
  const di = Math.max(0, company.departments.findIndex((d) => d.id === target));
  const add = () => {
    const d = company.departments[di];
    setCompany(addResource(company, di, { id: uniqueId(`${slug(d.id) || "dept"}_pool`, allResources(company)), skills: [], cost_per_hour: 0, schedule: weekdays9to5(), headcount: 1 }));
  };
  const action = company.departments.length ? (
    <>
      <Select value={company.departments[di].id} items={deptItems} onValueChange={(v) => v && setTarget(v)}>
        <SelectTrigger aria-label="department for new pool" size="sm" className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>{company.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="sm" onClick={add}><Plus /> Add pool</Button>
    </>
  ) : undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Pools" subtitle={`${pools.length} pools, ${pools.reduce((n, p) => n + (p.r.headcount ?? 0), 0)} heads`} />
      <OrgNav />
      <TableCard title="Pools" action={action}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Id</TableHead><TableHead>Department</TableHead><TableHead>Headcount</TableHead><TableHead className="text-right">Members</TableHead>
              <TableHead>Skills (comma)</TableHead><TableHead>Cost/h</TableHead><TableHead>Schedule</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {pools.map(({ r, loc }) => {
              const set = (next: typeof r) => {
                const out = setResource(company, loc, next);
                const id = out.departments[loc.di].resources[loc.ri].id; // setResource may reject the new id
                setCompany(out);
                if (id !== r.id) setScenarios(renameInScenarios(renameInScenarios(scenarios, "pool_id", r.id, id), "resource_id", r.id, id));
              };
              const members = membersOf(company, r.id);
              const d = company.departments[loc.di];
              return (
                <TableRow key={`${loc.di}:${loc.ri}`}>
                  <TableCell><IdInput aria-label={`id of ${r.id}`} className="w-32" value={r.id} onCommit={(id) => set({ ...r, id })} /></TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: accent(loc.di) }} />{d.name}</span>
                  </TableCell>
                  <TableCell>
                    <NumInput aria-label={`headcount of ${r.id}`} className="w-20" lo={members} value={r.headcount ?? 0}
                      title={members ? `at least ${members}: named members are carved out of the pool` : undefined}
                      onCommit={(v) => set({ ...r, headcount: Math.floor(v) })} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{members}</TableCell>
                  <TableCell><SkillsInput id={r.id} skills={r.skills} onCommit={(skills) => set({ ...r, skills })} /></TableCell>
                  <TableCell><NumInput aria-label={`cost per hour of ${r.id}`} className="w-20" value={r.cost_per_hour} onCommit={(v) => set({ ...r, cost_per_hour: v })} /></TableCell>
                  <TableCell>
                    {r.schedule ? <ScheduleEditor id={r.id} schedule={r.schedule} onChange={(s) => set({ ...r, schedule: s })} />
                      : <Button variant="outline" size="sm" onClick={() => set({ ...r, schedule: weekdays9to5() })}>Add schedule</Button>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" aria-label={`remove ${r.id}`} disabled={inScenarios.has(r.id)}
                      title={inScenarios.has(r.id) ? "referenced by a scenario" : members ? "members become standalone with this pool's schedule" : undefined}
                      onClick={() => {
                        if (members && !confirm(`Remove pool "${r.id}"? Its ${members} members become standalone with this pool's schedule.`)) return;
                        setCompany(removeResource(company, loc));
                      }}>Remove</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>
    </div>
  );
}
