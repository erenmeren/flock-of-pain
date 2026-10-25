"use client";

import { Delta, KPI_LABEL, MiniBars, NoResult, Panel, fmtKpi, sourceLabel } from "@/components/dashboard/kpi";
import { PageHeader, StatCard, fmt } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { StepChain, cycleMean } from "@/components/process/step-chain";
import { headcount } from "@/lib/company";
import { useTwin } from "@/lib/store";

const ACCENTS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const RESULT_TILES = ["throughput_per_day", "cycle_p50", "mean_dept_utilization", "sla_breach_rate"];
const WHAT_IF = ["throughput_per_day", "cycle_p50", "labor_cost", "sla_breach_rate"];

export default function Overview() {
  const { company, scenarios, result, resultSource, run, busy } = useTwin();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const wf = company.workflows[0];
  // a result from another company (or from history) must not sit under this company's name
  const own = resultSource?.kind === "run" && resultSource.company_id === company.id;
  const base = own ? result?.scenarios[0] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" subtitle={company.name} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Departments" value={company.departments.length} />
        <StatCard label="Headcount" value={headcount(company)} />
        <StatCard label="Workflows" value={company.workflows.length} />
        <StatCard label="Systems" value={company.systems.length} />
        <StatCard label="Scenarios" value={scenarios.length} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Organization System" href="/organization" className="lg:col-span-2">
          <div className="relative">
            <div className="absolute inset-x-4 top-1/2 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" aria-hidden />
            <div className="relative grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {company.departments.map((d, i) => {
                const pools = d.resources.filter((r) => r.headcount !== undefined).length;
                return (
                  <div key={d.id} className="rounded-xl border border-border bg-card p-3 shadow-[0_0_20px_-12px_var(--accent-color)]"
                    style={{ "--accent-color": ACCENTS[i % ACCENTS.length], borderTopColor: ACCENTS[i % ACCENTS.length] } as React.CSSProperties}>
                    <div className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                      <span className="truncate text-sm font-medium" title={d.id}>{d.name}</span>
                    </div>
                    <p className="mt-2 text-2xl font-semibold tabular-nums">{headcount({ ...company, departments: [d] })}</p>
                    <p className="text-xs text-muted-foreground">{pools} pools · {d.resources.length - pools} people</p>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>

        <Panel title="Active Scenarios" href="/scenarios">
          <ul className="flex flex-col gap-2">
            {scenarios.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
                <span className="truncate">{s.name}</span>
                <span className={s.overlays.length ? "rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary" : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"}>
                  {s.overlays.length ? `${s.overlays.length} change${s.overlays.length === 1 ? "" : "s"}` : "baseline"}
                </span>
              </li>
            ))}
            {scenarios.length === 0 && <li className="text-sm text-muted-foreground">No scenarios.</li>}
          </ul>
        </Panel>
      </div>

      <Panel title={wf ? `Process Flow: ${wf.name}` : "Process Flow"} href="/processes">
        {wf ? (
          <div className="flex flex-col gap-3">
            <StepChain wf={wf} company={company} />
            <p className="text-xs text-muted-foreground">Total mean step time: <span className="tabular-nums text-foreground">{fmt(cycleMean(wf), 0)} min</span> (sum of step means, excluding waits)</p>
          </div>
        ) : <p className="text-sm text-muted-foreground">No workflows.</p>}
      </Panel>

      {result && base ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{sourceLabel(resultSource)} · baseline: {base.name}</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {RESULT_TILES.map((k) => (
              <Card key={k} size="sm" className="bg-[radial-gradient(circle_at_top_left,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_60%)]">
                <CardContent className="flex items-end justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{KPI_LABEL[k]}</span>
                    <span className="text-2xl font-semibold tabular-nums">{fmtKpi(k, base.summary[k]?.mean)}</span>
                  </div>
                  <MiniBars values={result.scenarios.map((s) => s.summary[k]?.mean ?? 0)} />
                </CardContent>
              </Card>
            ))}
          </div>
          {result.scenarios.length > 1 && (
            <Panel title="What-If Scenarios" href="/analysis" linkLabel="Analysis">
              <div className="flex flex-col divide-y divide-border">
                {result.scenarios.slice(1).map((s) => (
                  <div key={s.id} className="grid grid-cols-2 gap-2 py-2 text-sm md:grid-cols-5">
                    <span className="col-span-2 font-medium md:col-span-1">{s.name}</span>
                    {WHAT_IF.map((k) => (
                      <span key={k} className="flex flex-col">
                        <span className="text-xs text-muted-foreground">{KPI_LABEL[k]}</span>
                        <Delta k={k} value={s.summary[k]?.mean} base={base.summary[k]?.mean} />
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {result && resultSource && <p className="text-xs text-muted-foreground">Last result belongs to {resultSource.name}.</p>}
          <NoResult run={run} busy={busy} />
        </div>
      )}
    </div>
  );
}
