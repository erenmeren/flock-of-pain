"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, fmt } from "@/components/page";
import { uniqueId } from "@/components/editor-fields";
import { StepChain, cycleMean, unskilled, windowSummary } from "@/components/process/step-chain";
import { weekdays9to5 } from "@/lib/company";
import { useTwin } from "@/lib/store";

export default function ProcessesPage() {
  const { company, setCompany } = useTwin();
  const router = useRouter();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const add = () => {
    const id = uniqueId("workflow", company.workflows);
    setCompany({ ...company, workflows: [...company.workflows, { id, name: "New workflow", arrival: { rate_per_hour: 1, window: weekdays9to5() }, steps: [] }] });
    router.push(`/processes/${encodeURIComponent(id)}`);
  };
  const remove = (i: number) => {
    if (confirm(`Remove workflow "${company.workflows[i].name}"?`)) setCompany({ ...company, workflows: company.workflows.filter((_, j) => j !== i) });
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
          <Card key={i} className="transition-shadow hover:ring-primary/40 hover:shadow-[0_0_24px_-12px_var(--primary)]">
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
                <Link href={href} className="min-w-48 hover:text-primary">
                  <span className="block text-base font-semibold">{wf.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{wf.id}</span>
                </Link>
                <Stat label="Arrivals/h" value={fmt(wf.arrival.rate_per_hour, 2)} />
                <Stat label="Window" value={windowSummary(wf.arrival.window)} small />
                <Stat label="Steps" value={wf.steps.length} />
                <Stat label="Mean cycle min" value={fmt(cycleMean(wf))} />
                {warn > 0 && (
                  <span className="flex items-center gap-1.5 self-center text-xs text-amber-400">
                    <span className="size-2 rounded-full bg-amber-400" /> {warn} step{warn > 1 ? "s" : ""} without skilled staff
                  </span>
                )}
                <div className="ml-auto flex gap-1">
                  <Button variant="outline" size="sm" render={<Link href={href} />} nativeButton={false}>Edit</Button>
                  <Button variant="ghost" size="sm" aria-label={`remove workflow ${wf.id}`} onClick={() => remove(i)}><Trash2 className="size-4" /></Button>
                </div>
              </div>
              <StepChain wf={wf} company={company} />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <span className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={small ? "text-sm" : "text-lg font-semibold tabular-nums"}>{value}</span>
    </span>
  );
}
