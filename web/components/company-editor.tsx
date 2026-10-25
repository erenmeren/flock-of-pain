"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  type Company, type Department, type Resource, type Schedule,
  DAYS, referencedIds, renameDepartment, renameSystem, slug, weekdays9to5,
} from "@/lib/company";

type Props = { company: Company; onChange: (c: Company) => void };

const NONE = "__none__";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export function CompanyEditor({ company, onChange }: Props) {
  const set = (patch: Partial<Company>) => onChange({ ...company, ...patch });
  const refs = referencedIds(company);
  const allResources = company.departments.flatMap((d) => d.resources);
  const pools = allResources.filter((r) => r.headcount !== undefined);

  const setDept = (i: number, d: Department) => {
    const old = company.departments[i];
    const next = old.id !== d.id ? renameDepartment(company, old.id, d.id) : company;
    onChange({ ...next, departments: next.departments.map((x, j) => (j === i ? d : x)) });
  };
  const setSystem = (i: number, patch: { id?: string; name?: string }) => {
    const old = company.systems[i];
    const next = patch.id !== undefined && patch.id !== old.id ? renameSystem(company, old.id, patch.id) : company;
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
                <Input aria-label={`system id ${s.id}`} value={s.id} onChange={(e) => setSystem(i, { id: e.target.value })} />
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
        <DepartmentCard key={i} dept={d} pools={pools} allResources={allResources} used={refs.departments.has(d.id)}
          onChange={(x) => setDept(i, x)} onRemove={() => set({ departments: company.departments.filter((_, j) => j !== i) })} />
      ))}
      <Button variant="outline" onClick={() => set({ departments: [...company.departments, { id: uniqueId("dept", company.departments), name: "New department", resources: [] }] })}>
        Add department
      </Button>
    </div>
  );
}

type DeptProps = {
  dept: Department; pools: Resource[]; allResources: Resource[]; used: boolean;
  onChange: (d: Department) => void; onRemove: () => void;
};

function DepartmentCard({ dept, pools, allResources, used, onChange, onRemove }: DeptProps) {
  const members = (poolId: string) => dept.resources.filter((r) => r.pool_id === poolId).length;
  const setRes = (i: number, r: Resource) => {
    const old = dept.resources[i];
    let rs = dept.resources.map((x, j) => (j === i ? r : x));
    if (old.headcount !== undefined && old.id !== r.id) rs = rs.map((x) => (x.pool_id === old.id ? { ...x, pool_id: r.id } : x)); // members follow a pool rename
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
    const pool = pools.find((p) => dept.resources.includes(p));
    const id = uniqueId("emp", allResources);
    if (!pool) return add({ id, skills: [], cost_per_hour: 0, schedule: weekdays9to5() });
    // a member is carved out of the pool, so the pool grows by one to keep capacity unchanged
    const rs = dept.resources.map((x) => (x === pool ? { ...x, headcount: (x.headcount ?? 0) + 1 } : x));
    onChange({ ...dept, resources: [...rs, { id, skills: pool.skills, cost_per_hour: pool.cost_per_hour, schedule: null, pool_id: pool.id }] });
  };
  const poolItems = { [NONE]: "standalone", ...Object.fromEntries(pools.map((p) => [p.id, p.id])) };

  return (
    <Card>
      <CardHeader>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input aria-label={`department id ${dept.id}`} value={dept.id} onChange={(e) => onChange({ ...dept, id: e.target.value })} />
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
                  <TableCell><Input aria-label={`id of ${r.id}`} className="w-28" value={r.id} onChange={(e) => setRes(i, { ...r, id: e.target.value })} /></TableCell>
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
                      <Select items={poolItems} value={r.pool_id ?? NONE}
                        onValueChange={(v) => setRes(i, v && v !== NONE ? { ...r, pool_id: v, schedule: null } : { ...r, pool_id: undefined, schedule: r.schedule ?? weekdays9to5() })}>
                        <SelectTrigger aria-label={`pool of ${r.id}`} className="w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(poolItems).map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
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

// shortcut: one [start, end] for every working day; per-day hours and absences are edited in the JSON tab
function ScheduleEditor({ id, schedule, onChange }: { id: string; schedule: Schedule; onChange: (s: Schedule) => void }) {
  const days = Object.keys(schedule.weekday_hours);
  const [start, end] = days.length ? schedule.weekday_hours[days[0]] : [9, 17];
  const uniform = days.every((k) => schedule.weekday_hours[k][0] === start && schedule.weekday_hours[k][1] === end);
  if (!uniform) return <p className="text-xs">per-day hours: edit in the JSON tab</p>;
  const rebuild = (keys: string[], s: number, e: number) => {
    s = clamp(Math.floor(s), 0, 23);
    e = clamp(Math.floor(e), s + 1, s + 24); // loader rule: 0 <= start < 24, start < end <= start + 24
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
        <Input type="number" min={0} max={23} aria-label={`shift start hour of ${id}`} className="w-16" value={start} onChange={(e) => rebuild(days, Number(e.target.value), end)} />
        to
        <Input type="number" min={start + 1} max={start + 24} aria-label={`shift end hour of ${id}`} className="w-16" value={end} onChange={(e) => rebuild(days, start, Number(e.target.value))} />
        h (overnight: end past 24)
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <Label className="flex flex-col items-start gap-1 text-xs">{label}{children}</Label>;
}

function uniqueId(base: string, items: { id: string }[]): string {
  const ids = new Set(items.map((x) => x.id));
  let n = 1;
  while (ids.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
