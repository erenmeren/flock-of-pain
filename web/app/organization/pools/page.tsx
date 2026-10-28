"use client";

import { useState } from "react";
import { Boxes, Plus } from "lucide-react";
import { PageHeader } from "@/components/page";
import { IdTag, NumInput, ScheduleEditor } from "@/components/editor-fields";
import { DeptMark, INLINE_INPUT, Loading, OrgNav, SkillsInput, TableCard } from "@/components/org/parts";
import { type Loc, addResource, allResources, isPool, membersOf, removeResource, setResource } from "@/components/org/ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { idFor, renameInScenarios, scenarioRefs, slug, weekdays9to5 } from "@/lib/company";
import { useConfirm } from "@/lib/confirm";
import { useTwin } from "@/lib/store";

export default function PoolsPage() {
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const confirm = useConfirm();
  const [target, setTarget] = useState(""); // department id new pools go to ("" = first)
  if (!company) return <Loading />;
  const pools = company.departments.flatMap((d, di) => d.resources.map((r, ri) => ({ r, loc: { di, ri } as Loc })).filter((x) => isPool(x.r)));
  const deptItems = Object.fromEntries(company.departments.map((d) => [d.id, d.name]));
  const inScenarios = scenarioRefs(scenarios).resources;
  const di = Math.max(0, company.departments.findIndex((d) => d.id === target));
  const add = () => {
    const d = company.departments[di];
    setCompany(addResource(company, di, { id: idFor("", allResources(company).map((x) => x.id), `${slug(d.id) || "dept"}_pool`), skills: [], cost_per_hour: 0, schedule: weekdays9to5(), headcount: 1 }));
  };
  const action = company.departments.length ? (
    <>
      <Select value={company.departments[di].id} items={deptItems} onValueChange={(v) => v && setTarget(v)}>
        <SelectTrigger aria-label="department for new pool" size="sm" className="w-40 rounded-full"><SelectValue /></SelectTrigger>
        <SelectContent>{company.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="outline" size="sm" className="rounded-full" onClick={add}><Plus /> Add pool</Button>
    </>
  ) : undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Pools" subtitle={`${pools.length} pools, ${pools.reduce((n, p) => n + (p.r.headcount ?? 0), 0)} heads`} />
      <OrgNav />
      <TableCard title="Pools" subtitle="Interchangeable staff sharing skills, cost and a schedule" icon={Boxes} action={action}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pool</TableHead><TableHead className="text-right">Headcount</TableHead><TableHead className="text-right">Members</TableHead>
              <TableHead>Skills (comma)</TableHead><TableHead className="text-right">Cost/h</TableHead><TableHead>Schedule</TableHead><TableHead />
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
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <DeptMark index={loc.di} size="size-8" />
                      <div className="flex flex-col gap-0.5">
                        <Input aria-label={`name of ${r.id}`} placeholder="Pool name" className={`w-40 font-medium ${INLINE_INPUT}`} value={r.name ?? ""}
                          onChange={(e) => set({ ...r, name: e.target.value || undefined, id: idFor(e.target.value, allResources(company).filter((x) => x !== r).map((x) => x.id), `${slug(d.id) || "dept"}_pool`, r.id) })} />
                        <span className="flex gap-2 px-1.5 text-xs text-muted-foreground"><IdTag id={r.id} className="px-0" /> · {d.name}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <NumInput aria-label={`headcount of ${r.id}`} className="ml-auto w-20 text-right tabular-nums" lo={members} value={r.headcount ?? 0}
                      title={members ? `at least ${members}: named members are carved out of the pool` : undefined}
                      onCommit={(v) => set({ ...r, headcount: Math.floor(v) })} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{members}</TableCell>
                  <TableCell><SkillsInput id={r.id} skills={r.skills} onCommit={(skills) => set({ ...r, skills })} /></TableCell>
                  <TableCell className="text-right"><NumInput aria-label={`cost per hour of ${r.id}`} className="ml-auto w-20 text-right tabular-nums" value={r.cost_per_hour} onCommit={(v) => set({ ...r, cost_per_hour: v })} /></TableCell>
                  <TableCell>
                    {r.schedule ? <ScheduleEditor id={r.id} schedule={r.schedule} onChange={(s) => set({ ...r, schedule: s })} />
                      : <Button variant="outline" size="sm" onClick={() => set({ ...r, schedule: weekdays9to5() })}>Add schedule</Button>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="destructive" size="sm" aria-label={`remove ${r.id}`} disabled={inScenarios.has(r.id)}
                      title={inScenarios.has(r.id) ? "referenced by a scenario" : members ? "members become standalone with this pool's schedule" : undefined}
                      onClick={async () => {
                        if (members && !(await confirm(`Its ${members} members become standalone with this pool's schedule.`, { title: `Remove pool "${r.id}"?`, action: "Remove", destructive: true }))) return;
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
