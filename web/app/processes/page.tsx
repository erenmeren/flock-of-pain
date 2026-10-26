"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/dashboard/kpi";
import { PageHeader, fmt } from "@/components/page";
import { StepChain, cycleMean, unskilled } from "@/components/process/step-chain";
import { inflowsOf, newWorkflow, rateOf } from "@/components/process/graph";
import { useConfirm } from "@/lib/confirm";
import { useTwin } from "@/lib/store";

export default function ProcessesPage() {
  const { company, setCompany } = useTwin();
  const confirm = useConfirm();
  const router = useRouter();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const add = () => {
    const wf = newWorkflow("New workflow", company.workflows.map((x) => x.id));
    setCompany({ ...company, workflows: [...company.workflows, wf] });
    router.push(`/processes/${encodeURIComponent(wf.id)}`);
  };
  const remove = async (i: number) => {
    if (await confirm(`"${company.workflows[i].name}" and its steps are removed.`, { title: "Remove this workflow?", action: "Remove", destructive: true })) setCompany({ ...company, workflows: company.workflows.filter((_, j) => j !== i) });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Processes" subtitle={`${company.workflows.length} workflows`}>
        <Button onClick={add} className="shadow-[0_0_18px_-4px_var(--primary)]"><Plus className="size-4" /> Add workflow</Button>
      </PageHeader>
      {company.workflows.map((wf, i) => {
        const href = `/processes/${encodeURIComponent(wf.id)}`;
        const warn = wf.steps.filter((st) => unskilled(company, st)).length;
        return (
          <Panel key={i} icon={Workflow}
            title={<Link href={href} className="hover:text-primary">{wf.name} <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">{wf.id}</span></Link>}
            subtitle={<span className="tabular-nums">{inflowsOf(wf).length} inflow{inflowsOf(wf).length === 1 ? "" : "s"} · {fmt(rateOf(wf), 2)}/h · {wf.steps.length} step{wf.steps.length === 1 ? "" : "s"} · mean cycle {fmt(cycleMean(wf))} min</span>}
            action={
              <div className="flex items-center gap-1">
                {warn > 0 && (
                  <span className="mr-2 flex items-center gap-1.5 text-xs text-amber-400">
                    <span className="size-2 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" /> {warn} step{warn > 1 ? "s" : ""} without skilled staff
                  </span>
                )}
                <Button variant="outline" size="sm" className="rounded-full" render={<Link href={href} />} nativeButton={false}>Edit <ArrowRight className="size-3.5" /></Button>
                <Button variant="ghost" size="sm" aria-label={`remove workflow ${wf.id}`} onClick={() => remove(i)}><Trash2 className="size-4" /></Button>
              </div>
            }>
            <StepChain wf={wf} company={company} />
          </Panel>
        );
      })}
      {!company.workflows.length && <p className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">No workflows yet.</p>}
    </div>
  );
}
