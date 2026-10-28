"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconTile, PageHeader, fmt } from "@/components/page";
import { IdTag } from "@/components/editor-fields";
import { INLINE_INPUT } from "@/components/org/parts";
import { ProcessCanvas } from "@/components/process/canvas";
import { cycleMean } from "@/components/process/step-chain";
import { type Workflow, idFor, renameInScenarios } from "@/lib/company";
import { inflowsOf, rateOf } from "@/components/process/graph";
import { useConfirm } from "@/lib/confirm";
import { useTwin } from "@/lib/store";

export function WorkflowPage() {
  const { id: raw } = useParams<{ id: string }>();
  const id = decodeURIComponent(raw);
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const confirm = useConfirm();
  const router = useRouter();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const back = <Button variant="outline" size="sm" className="rounded-full" render={<Link href="/processes" />} nativeButton={false}><ArrowLeft className="size-4" /> Processes</Button>;
  const i = company.workflows.findIndex((w) => w.id === id);
  if (i < 0) return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-10">
      <p className="text-sm text-muted-foreground">Unknown workflow <span className="font-mono">{id}</span>.</p>
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
  const onRemove = async () => {
    if (!(await confirm(`"${wf.name}" and its steps are removed.`, { title: "Remove this workflow?", action: "Remove", destructive: true }))) return;
    setCompany({ ...company, workflows: company.workflows.filter((_, j) => j !== i) });
    router.push("/processes");
  };

  const n = inflowsOf(wf).length;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={wf.name} subtitle={`${wf.id} · ${fmt(rateOf(wf), 2)}/h · ${n} inflow${n === 1 ? "" : "s"} · mean cycle ${fmt(cycleMean(wf))} min`}>{back}</PageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <IconTile icon={WorkflowIcon} />
        <div className="flex min-w-60 flex-1 flex-col gap-0.5">
          <Input aria-label={`workflow name ${wf.id}`} className={`h-7 text-base! font-medium ${INLINE_INPUT}`} value={wf.name} onChange={(e) => onChange({ ...wf, name: e.target.value, id: idFor(e.target.value, company.workflows.filter((x) => x !== wf).map((x) => x.id), "workflow", wf.id) })} />
          <IdTag id={wf.id} />
        </div>
        <Button variant="destructive" size="sm" className="rounded-full" onClick={onRemove}><Trash2 className="size-3.5" /> Remove</Button>
      </div>
      <ProcessCanvas wf={wf} company={company} onChange={onChange} />
    </div>
  );
}
