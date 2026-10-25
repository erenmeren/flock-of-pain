"use client";

import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page";
import { IdInput, uniqueId } from "@/components/editor-fields";
import { Loading, OrgNav, StatusDot, TableCard } from "@/components/org/parts";
import { stepsIn } from "@/components/org/ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { renameInScenarios, renameSystem, scenarioRefs } from "@/lib/company";
import { useTwin } from "@/lib/store";

export default function SystemsPage() {
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  if (!company) return <Loading />;
  const steps = stepsIn(company);
  const inScenarios = scenarioRefs(scenarios).systems;
  const setSystem = (i: number, patch: { id?: string; name?: string }) => {
    const old = company.systems[i];
    const taken = company.systems.some((x, j) => j !== i && x.id === patch.id);
    if (patch.id === "" || taken) patch = { ...patch, id: old.id }; // empty or duplicate id ignored
    const next = patch.id !== undefined && patch.id !== old.id ? renameSystem(company, old.id, patch.id) : company;
    setCompany({ ...next, systems: next.systems.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
    if (patch.id !== undefined && patch.id !== old.id) setScenarios(renameInScenarios(scenarios, "system_id", old.id, patch.id));
  };
  const add = () => setCompany({ ...company, systems: [...company.systems, { id: uniqueId("system", company.systems), name: "New system" }] });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Systems" subtitle={`${company.systems.length} systems`} />
      <OrgNav />
      <TableCard title="Systems" action={<Button size="sm" onClick={add}><Plus /> Add system</Button>}>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Id</TableHead><TableHead>Name</TableHead><TableHead>Used by</TableHead><TableHead /></TableRow>
          </TableHeader>
          <TableBody>
            {company.systems.map((s, i) => {
              const nSteps = steps.filter((st) => st.system_id === s.id).length;
              const nOutages = (company.outages ?? []).filter((o) => o[0] === s.id).length;
              const used = nSteps + nOutages > 0;
              const scen = inScenarios.has(s.id);
              return (
                <TableRow key={i}>
                  <TableCell><IdInput aria-label={`system id ${s.id}`} className="w-40" value={s.id} onCommit={(id) => setSystem(i, { id })} /></TableCell>
                  <TableCell><Input aria-label={`system name ${s.id}`} className="w-56" value={s.name} onChange={(e) => setSystem(i, { name: e.target.value })} /></TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                      <StatusDot ok={used} title={used ? "in use" : "unused"} />
                      {nSteps} step{nSteps === 1 ? "" : "s"}, {nOutages} outage{nOutages === 1 ? "" : "s"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" disabled={used || scen}
                      title={used ? "referenced by a workflow step or outage" : scen ? "referenced by a scenario" : undefined}
                      aria-label={`remove ${s.id}`} onClick={() => setCompany({ ...company, systems: company.systems.filter((_, j) => j !== i) })}>Remove</Button>
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
