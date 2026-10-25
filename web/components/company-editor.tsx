"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { IdInput, ScheduleEditor, clamp, uniqueId } from "@/components/editor-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkflowsEditor } from "@/components/workflow-editor";
import { type Company, type Department, type Resource, referencedIds, renameDepartment, renameSystem, slug, weekdays9to5 } from "@/lib/company";

type Props = { company: Company; onChange: (c: Company) => void };

const NONE = "__none__";

export function CompanyEditor({ company, onChange }: Props) {
  const set = (patch: Partial<Company>) => onChange({ ...company, ...patch });
  const refs = referencedIds(company);
  const allResources = company.departments.flatMap((d) => d.resources);

  const setDept = (i: number, d: Department) => {
    const old = company.departments[i];
    const taken = company.departments.some((x, j) => j !== i && x.id === d.id);
    const next = old.id !== d.id && !taken ? renameDepartment(company, old.id, d.id) : company; // a duplicate id stays a loader error
    onChange({ ...next, departments: next.departments.map((x, j) => (j === i ? d : x)) });
  };
  const setSystem = (i: number, patch: { id?: string; name?: string }) => {
    const old = company.systems[i];
    const taken = company.systems.some((x, j) => j !== i && x.id === patch.id);
    const next = patch.id !== undefined && patch.id !== old.id && !taken ? renameSystem(company, old.id, patch.id) : company;
    onChange({ ...next, systems: next.systems.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Company id"><Input value={company.id} onChange={(e) => set({ id: e.target.value })} /></Field>
        <Field label="Company name"><Input value={company.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      </div>

      <Card>
        <CardHeader><CardTitle>Systems</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {company.systems.map((s, i) => {
            const used = refs.systems.has(s.id);
            return (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <IdInput aria-label={`system id ${s.id}`} value={s.id} onCommit={(id) => setSystem(i, { id })} />
                <Input aria-label={`system name ${s.id}`} value={s.name} onChange={(e) => setSystem(i, { name: e.target.value })} />
                <Button variant="ghost" size="sm" disabled={used} title={used ? "referenced by a workflow step or outage" : undefined}
                  onClick={() => set({ systems: company.systems.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
            );
          })}
          <Button variant="outline" size="sm" onClick={() => set({ systems: [...company.systems, { id: uniqueId("system", company.systems), name: "New system" }] })}>Add system</Button>
        </CardContent>
      </Card>

      {company.departments.map((d, i) => (
        <DepartmentCard key={i} dept={d} allResources={allResources} used={refs.departments.has(d.id)}
          onChange={(x) => setDept(i, x)} onRemove={() => set({ departments: company.departments.filter((_, j) => j !== i) })} />
      ))}
      <Button variant="outline" onClick={() => set({ departments: [...company.departments, { id: uniqueId("dept", company.departments), name: "New department", resources: [] }] })}>
        Add department
      </Button>
      <WorkflowsEditor company={company} onChange={onChange} />
    </div>
  );
}

type DeptProps = {
  dept: Department; allResources: Resource[]; used: boolean;
  onChange: (d: Department) => void; onRemove: () => void;
};

// shortcut: pools and their members live in one department here (the loader allows cross-department pools; JSON tab)
function DepartmentCard({ dept, allResources, used, onChange, onRemove }: DeptProps) {
  const pools = dept.resources.filter((r) => r.headcount !== undefined);
  const members = (poolId: string) => dept.resources.filter((r) => r.pool_id === poolId).length;
  const setRes = (i: number, r: Resource) => {
    const old = dept.resources[i];
    let rs = dept.resources.map((x, j) => (j === i ? r : x));
    const taken = allResources.some((x) => x !== old && x.id === r.id);
    if (old.headcount !== undefined && old.id !== r.id && !taken) rs = rs.map((x) => (x.pool_id === old.id ? { ...x, pool_id: r.id } : x)); // members follow a pool rename
    onChange({ ...dept, resources: rs });
  };
  const remove = (i: number) => {
    const gone = dept.resources[i];
    const rs = dept.resources.filter((_, j) => j !== i)
      .map((x) => (x.pool_id === gone.id ? { ...x, pool_id: undefined, schedule: x.schedule ?? gone.schedule ?? weekdays9to5() } : x)); // orphans stand alone
    onChange({ ...dept, resources: rs });
  };
  const add = (r: Resource) => onChange({ ...dept, resources: [...dept.resources, r] });
  const addPerson = () => {
    const pool = pools[0];
    const id = uniqueId("emp", allResources);
    if (!pool) return add({ id, skills: [], cost_per_hour: 0, schedule: weekdays9to5() });
    // a member is carved out of the pool, so the pool grows by one to keep capacity unchanged
    const rs = dept.resources.map((x) => (x === pool ? { ...x, headcount: (x.headcount ?? 0) + 1 } : x));
    onChange({ ...dept, resources: [...rs, { id, skills: pool.skills, cost_per_hour: pool.cost_per_hour, schedule: null, pool_id: pool.id }] });
  };
  const poolItems = { [NONE]: "standalone", ...Object.fromEntries(pools.map((p) => [p.id, p.id])) };
  const itemsFor = (r: Resource) => (r.pool_id && !(r.pool_id in poolItems) ? { ...poolItems, [r.pool_id]: `${r.pool_id} (other department)` } : poolItems);

  return (
    <Card>
      <CardHeader>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <IdInput aria-label={`department id ${dept.id}`} value={dept.id} onCommit={(id) => onChange({ ...dept, id })} />
          <Input aria-label={`department name ${dept.id}`} value={dept.name} onChange={(e) => onChange({ ...dept, name: e.target.value })} />
          <Button variant="ghost" size="sm" disabled={used} title={used ? "referenced by a workflow step" : undefined} onClick={onRemove}>Remove</Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead><TableHead>Id</TableHead><TableHead>Name</TableHead><TableHead>Skills (comma)</TableHead>
              <TableHead>Cost/h</TableHead><TableHead>Headcount / pool</TableHead><TableHead>Schedule</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {dept.resources.map((r, i) => {
              const isPool = r.headcount !== undefined;
              const minHead = isPool ? members(r.id) : 0;
              return (
                <TableRow key={i}>
                  <TableCell>{isPool ? "Pool" : "Person"}</TableCell>
                  <TableCell><IdInput aria-label={`id of ${r.id}`} className="w-28" value={r.id} onCommit={(id) => setRes(i, { ...r, id })} /></TableCell>
                  <TableCell><Input aria-label={`name of ${r.id}`} className="w-32" value={r.name ?? ""} onChange={(e) => setRes(i, { ...r, name: e.target.value || undefined })} /></TableCell>
                  <TableCell>
                    {/* committed on blur so a trailing comma or space can be typed */}
                    <Input key={r.skills.join(",")} aria-label={`skills of ${r.id}`} className="w-48" defaultValue={r.skills.join(", ")}
                      onBlur={(e) => setRes(i, { ...r, skills: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                  </TableCell>
                  <TableCell><Input type="number" step="any" min={0} aria-label={`cost per hour of ${r.id}`} className="w-20" value={r.cost_per_hour}
                    onChange={(e) => setRes(i, { ...r, cost_per_hour: clamp(Number(e.target.value), 0, Infinity) })} /></TableCell>
                  <TableCell>
                    {isPool ? (
                      <Input type="number" min={minHead} aria-label={`headcount of ${r.id}`} title={minHead ? `${minHead} named members` : undefined} className="w-20" value={r.headcount}
                        onChange={(e) => setRes(i, { ...r, headcount: Math.floor(clamp(Number(e.target.value), minHead, Infinity)) })} />
                    ) : (
                      <Select items={itemsFor(r)} value={r.pool_id ?? NONE}
                        onValueChange={(v) => setRes(i, v && v !== NONE ? { ...r, pool_id: v, schedule: null } : { ...r, pool_id: undefined, schedule: r.schedule ?? weekdays9to5() })}>
                        <SelectTrigger aria-label={`pool of ${r.id}`} className="w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(itemsFor(r)).map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.pool_id !== undefined && (
                      <Label className="mb-1 flex items-center gap-2 text-xs">
                        <Checkbox aria-label={`${r.id} inherits pool schedule`} checked={r.schedule === null} onCheckedChange={(c) => setRes(i, { ...r, schedule: c ? null : weekdays9to5() })} /> inherit pool
                      </Label>
                    )}
                    {r.schedule ? <ScheduleEditor id={r.id} schedule={r.schedule} onChange={(s) => setRes(i, { ...r, schedule: s })} />
                      : r.pool_id === undefined && <Button variant="outline" size="sm" onClick={() => setRes(i, { ...r, schedule: weekdays9to5() })}>Add schedule</Button>}
                  </TableCell>
                  <TableCell><Button variant="ghost" size="sm" aria-label={`remove ${r.id}`} onClick={() => remove(i)}>Remove</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => add({ id: uniqueId(`${slug(dept.id) || "dept"}_pool`, allResources), skills: [], cost_per_hour: 0, schedule: weekdays9to5(), headcount: 1 })}>Add pool</Button>
          <Button variant="outline" size="sm" onClick={addPerson}>Add person</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <Label className="flex flex-col items-start gap-1 text-xs">{label}{children}</Label>;
}
