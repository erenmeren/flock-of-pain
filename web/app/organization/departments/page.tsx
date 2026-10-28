"use client";

import { Building2, Plus } from "lucide-react";
import { Hint } from "@/components/hint";
import { PageHeader } from "@/components/page";
import { IdTag } from "@/components/editor-fields";
import { DeptMark, INLINE_INPUT, Loading, OrgNav, TableCard } from "@/components/org/parts";
import { deptHeadcount, isPool, removeDepartment, stepsIn } from "@/components/org/ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Department, idFor, renameDepartment, renameInScenarios, scenarioRefs } from "@/lib/company";
import { useConfirm } from "@/lib/confirm";
import { useTwin } from "@/lib/store";

export default function DepartmentsPage() {
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const confirm = useConfirm();
  if (!company) return <Loading />;
  const steps = stepsIn(company);
  const inScenarios = scenarioRefs(scenarios).departments;
  const setDept = (i: number, d: Department) => {
    const old = company.departments[i];
    const taken = company.departments.some((x, j) => j !== i && x.id === d.id);
    if (!d.id || taken) d = { ...d, id: old.id }; // empty or duplicate id ignored
    const next = old.id !== d.id ? renameDepartment(company, old.id, d.id) : company;
    setCompany({ ...next, departments: next.departments.map((x, j) => (j === i ? d : x)) });
    if (old.id !== d.id) setScenarios(renameInScenarios(scenarios, "department_id", old.id, d.id));
  };
  const add = () => setCompany({ ...company, departments: [...company.departments, { id: idFor("New department", company.departments.map((x) => x.id), "dept"), name: "New department", resources: [] }] });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Departments" subtitle={`${company.departments.length} departments`} />
      <OrgNav />
      <TableCard title="Departments" subtitle="Teams that own workflow steps and staff" icon={Building2}
        action={<Button variant="outline" size="sm" className="rounded-full" onClick={add}><Plus /> Add department</Button>}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department <Hint id="department" /></TableHead><TableHead className="text-right">Headcount</TableHead>
              <TableHead className="text-right">Pools</TableHead><TableHead className="text-right">People</TableHead>
              <TableHead className="text-right">Workflow steps</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {company.departments.map((d, i) => {
              const used = steps.filter((s) => s.department_id === d.id).length;
              const scen = inScenarios.has(d.id);
              return (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <DeptMark index={i} size="size-8" />
                      <div className="flex flex-col gap-0.5">
                        <Input aria-label={`department name ${d.id}`} className={`w-52 font-medium ${INLINE_INPUT}`} value={d.name} onChange={(e) => setDept(i, { ...d, name: e.target.value, id: idFor(e.target.value, company.departments.filter((_, j) => j !== i).map((x) => x.id), "dept", d.id) })} />
                        <IdTag id={d.id} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{deptHeadcount(company, d)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.resources.filter(isPool).length}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.resources.filter((r) => !isPool(r)).length}</TableCell>
                  <TableCell className="text-right tabular-nums">{used}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="destructive" size="sm" disabled={used > 0 || scen}
                      title={used ? `referenced by ${used} workflow step${used === 1 ? "" : "s"}` : scen ? "referenced by a scenario" : undefined}
                      aria-label={`remove ${d.id}`} onClick={async () => {
                        if (d.resources.length && !(await confirm(`Its ${d.resources.length} pools/people are removed with it.`, { title: `Remove department "${d.id}"?`, action: "Remove", destructive: true }))) return;
                        setCompany(removeDepartment(company, i));
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
