"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, fmt } from "@/components/page";
import { WorkflowCard } from "@/components/workflow-editor";
import { StepChain, cycleMean, windowSummary } from "@/components/process/step-chain";
import { type Workflow, renameInScenarios } from "@/lib/company";
import { useTwin } from "@/lib/store";

export function WorkflowPage() {
  const { id: raw } = useParams<{ id: string }>();
  const id = decodeURIComponent(raw);
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const router = useRouter();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const back = <Button variant="ghost" size="sm" render={<Link href="/processes" />} nativeButton={false}><ArrowLeft className="size-4" /> Processes</Button>;
  const i = company.workflows.findIndex((w) => w.id === id);
  if (i < 0) return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm">Unknown workflow <span className="font-mono">{id}</span>.</p>
      {back}
    </div>
  );
  const wf = company.workflows[i];

  const onChange = (w: Workflow) => {
    if (w.id !== wf.id && (!w.id || company.workflows.some((x) => x.id === w.id))) w = { ...w, id: wf.id }; // ids stay unique and non-empty
    setCompany({ ...company, workflows: company.workflows.map((x, j) => (j === i ? w : x)) });
    if (w.id !== wf.id) {
      setScenarios(renameInScenarios(scenarios, "workflow_id", wf.id, w.id));
      router.replace(`/processes/${encodeURIComponent(w.id)}`);
    }
  };
  const onRemove = () => {
    if (!confirm(`Remove workflow "${wf.name}"?`)) return;
    setCompany({ ...company, workflows: company.workflows.filter((_, j) => j !== i) });
    router.push("/processes");
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={wf.name} subtitle={`${wf.id} · ${fmt(wf.arrival.rate_per_hour, 2)}/h · ${windowSummary(wf.arrival.window)} · mean cycle ${fmt(cycleMean(wf))} min`}>{back}</PageHeader>
      <Card><CardContent><StepChain wf={wf} company={company} /></CardContent></Card>
      <WorkflowCard wf={wf} company={company} onChange={onChange} onRemove={onRemove} />
    </div>
  );
}
