"use client";

import { Plus, Server } from "lucide-react";
import { Hint } from "@/components/hint";
import { IconTile, PageHeader } from "@/components/page";
import { IdTag } from "@/components/editor-fields";
import { INLINE_INPUT, Loading, OrgNav, Pill, StatusDot, TableCard } from "@/components/org/parts";
import { stepsIn } from "@/components/org/ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { idFor, renameInScenarios, renameSystem, scenarioRefs } from "@/lib/company";
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
  const add = () => setCompany({ ...company, systems: [...company.systems, { id: idFor("New system", company.systems.map((x) => x.id), "system"), name: "New system" }] });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Systems" subtitle={`${company.systems.length} systems`} />
      <OrgNav />
      <TableCard title="Systems" subtitle="Tools steps depend on; outages block them" icon={Server}
        action={<Button variant="outline" size="sm" className="rounded-full" onClick={add}><Plus /> Add system</Button>}>
        <Table>
          <TableHeader>
            <TableRow><TableHead>System <Hint id="system" /></TableHead><TableHead className="text-right">Used by</TableHead><TableHead /></TableRow>
          </TableHeader>
          <TableBody>
            {company.systems.map((s, i) => {
              const nSteps = steps.filter((st) => st.system_id === s.id).length;
              const nOutages = (company.outages ?? []).filter((o) => o[0] === s.id).length;
              const used = nSteps + nOutages > 0;
              const scen = inScenarios.has(s.id);
              return (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <IconTile icon={Server} color="var(--chart-5)" />
                      <div className="flex flex-col gap-0.5">
                        <Input aria-label={`system name ${s.id}`} className={`w-56 font-medium ${INLINE_INPUT}`} value={s.name} onChange={(e) => setSystem(i, { name: e.target.value, id: idFor(e.target.value, company.systems.filter((_, j) => j !== i).map((x) => x.id), "system", s.id) })} />
                        <IdTag id={s.id} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center gap-2">
                      <StatusDot ok={used} title={used ? "in use" : "unused"} />
                      <Pill tone={used ? "primary" : "muted"}>{nSteps} step{nSteps === 1 ? "" : "s"}, {nOutages} outage{nOutages === 1 ? "" : "s"}</Pill>
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="destructive" size="sm" disabled={used || scen}
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
