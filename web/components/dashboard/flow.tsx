"use client";

import { Clock } from "lucide-react";
import { cn } from "cn";
import { cycleMean, unskilled } from "@/components/process/step-chain";
import { accent } from "@/components/org/parts";
import { fmt } from "@/components/page";
import type { ScenarioResult } from "@/lib/api";
import { type Company, type Workflow, durationMean } from "@/lib/company";
import { handoffs, minutes } from "@/components/dashboard/derive";

/** Numbered step tiles on a coloured track, with cycle time, bottlenecks and hand-offs underneath. */
export function FlowStrip({ wf, company, base }: { wf: Workflow; company: Company; base?: ScenarioResult }) {
  const di = new Map(company.departments.map((d, i) => [d.id, i]));
  const color = (id: string) => accent(di.get(id) ?? 0);
  const name = (id: string) => company.departments.find((d) => d.id === id)?.name ?? id;
  const busy = base ? company.departments.filter((d) => (base.summary[`util_${d.id}`]?.mean ?? 0) > 0.85).length : null;
  const unstaffed = wf.steps.filter((st) => unskilled(company, st)).length;
  if (!wf.steps.length) return <p className="text-sm text-muted-foreground">No steps yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex gap-2">
        {wf.steps.map((st, i) => {
          const c = color(st.department_id), mean = durationMean(st.duration), bad = unskilled(company, st);
          return (
            <li key={i} className="glass-inset flex min-w-24 flex-1 basis-0 flex-col gap-2 rounded-xl p-2.5" title={bad ? `no resource in ${st.department_id} has skill "${st.required_skill}"` : undefined}>
              <span className="flex items-center justify-between">
                <span className="flex size-7 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: c, boxShadow: `0 0 14px -2px ${c}` }}>{i + 1}</span>
                {bad && <span aria-label="no skilled resource" className="size-2 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" />}
              </span>
              <span className="flex flex-col">
                <span className="truncate text-sm font-medium leading-tight">{st.name || st.id}</span>
                <span className="truncate text-xs text-muted-foreground">{name(st.department_id)}</span>
              </span>
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><Clock className="size-3" /> {mean === null ? "–" : `${fmt(mean, 0)} min`}</span>
            </li>
          );
        })}
      </ol>
      <div className="relative h-3" aria-hidden>
        <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-primary/60 via-primary/30 to-primary/60" />
        {wf.steps.map((st, i) => {
          const c = color(st.department_id);
          return <span key={i} className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background" style={{ left: `${((i + 0.5) / wf.steps.length) * 100}%`, background: c, boxShadow: `0 0 8px ${c}` }} />;
        })}
      </div>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Stat label="Total step time" value={minutes(cycleMean(wf))} />
        {base && <Stat label="Simulated cycle p50" value={minutes(base.summary.cycle_p50?.mean ?? null)} />}
        <Stat label={busy === null ? "Unstaffed steps" : "Bottlenecks"} value={busy ?? unstaffed} dot={(busy ?? unstaffed) > 0 ? "bg-rose-400 shadow-[0_0_8px_#fb7185]" : "bg-emerald-400 shadow-[0_0_8px_#34d399]"} hint={busy === null ? undefined : "departments over 85% busy"} />
        <Stat label="Handoffs" value={handoffs(wf)} />
      </div>
    </div>
  );
}

function Stat({ label, value, dot, hint }: { label: string; value: React.ReactNode; dot?: string; hint?: string }) {
  return (
    <span className="flex flex-col" title={hint}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 text-xl font-semibold tabular-nums tracking-tight">{dot && <span className={cn("size-2 rounded-full", dot)} />}{value}</span>
    </span>
  );
}
