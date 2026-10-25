"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Company, type Department, type Resource, type Schedule, DAYS, slug, weekdays9to5 } from "@/lib/company";

type Props = { company: Company; onChange: (c: Company) => void };

const NONE = "__none__";

export function CompanyEditor({ company, onChange }: Props) {
  const set = (patch: Partial<Company>) => onChange({ ...company, ...patch });
  const setDept = (i: number, d: Department) => set({ departments: company.departments.map((x, j) => (j === i ? d : x)) });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Company id"><Input value={company.id} onChange={(e) => set({ id: e.target.value })} /></Field>
        <Field label="Company name"><Input value={company.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      </div>

      <Card>
        <CardHeader><CardTitle>Systems</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {company.systems.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input aria-label="system id" value={s.id} onChange={(e) => set({ systems: company.systems.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} />
              <Input aria-label="system name" value={s.name} onChange={(e) => set({ systems: company.systems.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <Button variant="ghost" size="sm" onClick={() => set({ systems: company.systems.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => set({ systems: [...company.systems, { id: uniqueId("system", company.systems), name: "New system" }] })}>Add system</Button>
        </CardContent>
      </Card>

      {company.departments.map((d, i) => (
        <DepartmentCard key={i} dept={d} onChange={(x) => setDept(i, x)} onRemove={() => set({ departments: company.departments.filter((_, j) => j !== i) })} />
      ))}
      <Button variant="outline" onClick={() => set({ departments: [...company.departments, { id: uniqueId("dept", company.departments), name: "New department", resources: [] }] })}>
        Add department
      </Button>
    </div>
  );
}

function DepartmentCard({ dept, onChange, onRemove }: { dept: Department; onChange: (d: Department) => void; onRemove: () => void }) {
  const setRes = (i: number, r: Resource) => onChange({ ...dept, resources: dept.resources.map((x, j) => (j === i ? r : x)) });
  const pools = dept.resources.filter((r) => r.headcount !== undefined);
  const add = (r: Resource) => onChange({ ...dept, resources: [...dept.resources, r] });
  return (
    <Card>
      <CardHeader>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input aria-label="department id" value={dept.id} onChange={(e) => onChange({ ...dept, id: e.target.value })} />
          <Input aria-label="department name" value={dept.name} onChange={(e) => onChange({ ...dept, name: e.target.value })} />
          <Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
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
              return (
                <TableRow key={i}>
                  <TableCell>{isPool ? "Pool" : "Person"}</TableCell>
                  <TableCell><Input aria-label="resource id" className="w-28" value={r.id} onChange={(e) => setRes(i, { ...r, id: e.target.value })} /></TableCell>
                  <TableCell><Input aria-label="resource name" className="w-32" value={r.name ?? ""} onChange={(e) => setRes(i, { ...r, name: e.target.value || undefined })} /></TableCell>
                  <TableCell>
                    {/* committed on blur so a trailing comma or space can be typed */}
                    <Input key={r.skills.join(",")} aria-label="skills" className="w-48" defaultValue={r.skills.join(", ")}
                      onBlur={(e) => setRes(i, { ...r, skills: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                  </TableCell>
                  <TableCell><Input type="number" step="any" min={0} aria-label="cost per hour" className="w-20" value={r.cost_per_hour} onChange={(e) => setRes(i, { ...r, cost_per_hour: Number(e.target.value) })} /></TableCell>
                  <TableCell>
                    {isPool ? (
                      <Input type="number" min={0} aria-label="headcount" className="w-20" value={r.headcount} onChange={(e) => setRes(i, { ...r, headcount: Math.max(0, Math.floor(Number(e.target.value))) })} />
                    ) : (
                      <Select value={r.pool_id ?? NONE} onValueChange={(v) => setRes(i, v && v !== NONE ? { ...r, pool_id: v, schedule: null } : { ...r, pool_id: undefined, schedule: r.schedule ?? weekdays9to5() })}>
                        <SelectTrigger aria-label="pool" className="w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>standalone</SelectItem>
                          {pools.map((p) => <SelectItem key={p.id} value={p.id}>{p.id}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.pool_id !== undefined && (
                      <Label className="mb-1 flex items-center gap-2 text-xs">
                        <Checkbox checked={r.schedule === null} onCheckedChange={(c) => setRes(i, { ...r, schedule: c ? null : weekdays9to5() })} /> inherit pool
                      </Label>
                    )}
                    {r.schedule && <ScheduleEditor schedule={r.schedule} onChange={(s) => setRes(i, { ...r, schedule: s })} />}
                  </TableCell>
                  <TableCell><Button variant="ghost" size="sm" onClick={() => onChange({ ...dept, resources: dept.resources.filter((_, j) => j !== i) })}>Remove</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => add({ id: uniqueId(`${slug(dept.id)}_pool`, dept.resources), skills: [], cost_per_hour: 0, schedule: weekdays9to5(), headcount: 1 })}>Add pool</Button>
          <Button variant="outline" size="sm" onClick={() => add(pools[0]
            ? { id: uniqueId("emp", dept.resources), skills: pools[0].skills, cost_per_hour: pools[0].cost_per_hour, schedule: null, pool_id: pools[0].id }
            : { id: uniqueId("emp", dept.resources), skills: [], cost_per_hour: 0, schedule: weekdays9to5() })}>Add person</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// shortcut: one [start, end] for every working day; per-day hours and absences are edited in the JSON tab
function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const days = Object.keys(schedule.weekday_hours);
  const [start, end] = days.length ? schedule.weekday_hours[days[0]] : [9, 17];
  const rebuild = (keys: string[], s: number, e: number) =>
    onChange({ ...schedule, weekday_hours: Object.fromEntries(keys.sort().map((k) => [k, [s, e] as [number, number]])) });
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex gap-2">
        {DAYS.map((name, d) => (
          <Label key={d} className="flex items-center gap-1">
            <Checkbox aria-label={name} checked={days.includes(String(d))}
              onCheckedChange={(c) => rebuild(c ? [...days, String(d)] : days.filter((k) => k !== String(d)), start, end)} /> {name}
          </Label>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Input type="number" min={0} max={23} aria-label="shift start hour" className="w-16" value={start} onChange={(e) => rebuild(days, Number(e.target.value), end)} />
        to
        <Input type="number" min={1} max={47} aria-label="shift end hour" className="w-16" value={end} onChange={(e) => rebuild(days, start, Number(e.target.value))} />
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
