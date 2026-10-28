"use client";

import Link from "next/link";
import { Activity, FlaskConical, Gauge as GaugeIcon, HeartPulse, Loader2, Network, Play, Sparkles, Timer, Workflow } from "lucide-react";
import { cn } from "cn";
import { Delta, KPI_LABEL, Panel, direction, fmtKpi, sourceLabel } from "@/components/dashboard/kpi";
import { FlowStrip } from "@/components/dashboard/flow";
import { Gauge } from "@/components/dashboard/health";
import { healthScores } from "@/components/dashboard/derive";
import { OrgMap } from "@/components/dashboard/org-map";
import { Hint } from "@/components/hint";
import { StatCard } from "@/components/page";
import { buttonVariants } from "@/components/ui/button";
import { accent } from "@/components/org/parts";
import { useTwin } from "@/lib/store";

const TILES = [["throughput_per_day", Activity], ["cycle_p50", Timer], ["mean_dept_utilization", GaugeIcon]] as const;
const WHAT_IF = ["throughput_per_day", "cycle_p50", "labor_cost", "sla_breach_rate"];

export default function Overview() {
  const { company, scenarios, config, result, resultSource, run, busy } = useTwin();
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const wf = company.workflows[0];
  // a result from another company (or from history) must not sit under this company's name
  const own = result && resultSource?.kind === "run" && resultSource.company_id === company.id;
  const base = own ? result.scenarios[0] : undefined;
  const others = own ? result.scenarios.slice(1) : [];
  const health = healthScores(base?.summary);
  // the what-if card shows the scenario that moves throughput the most
  const spotlight = base && others.length ? others.reduce((a, b) => (Math.abs((b.summary.throughput_per_day?.mean ?? 0) - (base.summary.throughput_per_day?.mean ?? 0)) > Math.abs((a.summary.throughput_per_day?.mean ?? 0) - (base.summary.throughput_per_day?.mean ?? 0)) ? b : a)) : undefined;
  const runDays = config.days * config.replications * scenarios.length;

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <h1 className="sr-only">Overview</h1>
      <Panel icon={Network} title="Organization System" subtitle="Inflows, departments, systems and hand-offs" href="/organization" linkLabel="View details" className="lg:col-span-7" contentClassName="flex flex-1 flex-col justify-center">
        <OrgMap company={company} />
      </Panel>

      <div className="flex flex-col gap-4 lg:col-span-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel icon={HeartPulse} title={<span className="flex items-center gap-1.5">Organization Health<Hint id="health" /></span>} subtitle={base ? `Baseline · ${base.name}` : "Run to score"} contentClassName="flex flex-col gap-3">
            <Gauge score={health?.total ?? null} label={health?.label ?? "no result"} />
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {(health?.parts ?? [{ label: "Delivery" }, { label: "SLA" }, { label: "Quality" }, { label: "Balance" }]).map((p) => (
                <li key={p.label} className="flex items-center gap-2" title={"hint" in p ? p.hint : undefined}>
                  <span className={cn("size-1.5 rounded-full", "score" in p ? (p.score >= 80 ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : p.score >= 60 ? "bg-amber-400" : "bg-rose-400") : "bg-muted-foreground/40")} />
                  <span className="text-muted-foreground">{p.label}</span>
                  <span className="ml-auto tabular-nums">{"score" in p ? Math.round(p.score) : "–"}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel icon={FlaskConical} title="Active Scenarios" href="/scenarios" linkLabel="All" contentClassName="flex flex-col gap-3">
            <span className="text-4xl font-semibold tabular-nums leading-none tracking-tight">{scenarios.length}</span>
            <ul className="flex flex-col gap-1.5">
              {scenarios.slice(0, 5).map((s, i) => (
                <li key={s.id} className="glass-inset flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: accent(i), boxShadow: `0 0 6px ${accent(i)}` }} />
                  <span className="truncate" title={s.id}>{s.name}</span>
                  <span className={cn("ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px]", s.overlays.length ? "bg-primary/15 text-primary" : "bg-emerald-400/15 text-emerald-400")}>
                    {s.overlays.length ? `${s.overlays.length} change${s.overlays.length === 1 ? "" : "s"}` : "baseline"}
                  </span>
                </li>
              ))}
              {scenarios.length > 5 && <li className="px-1 text-[11px] text-muted-foreground">+{scenarios.length - 5} more</li>}
              {!scenarios.length && <li className="text-xs text-muted-foreground">No scenarios.</li>}
            </ul>
          </Panel>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {TILES.map(([k, icon]) => {
            const vals = own ? result.scenarios.map((s) => s.summary[k]?.mean ?? 0) : undefined;
            const best = vals && vals.length > 1 ? (direction(k) > 0 ? Math.max : Math.min)(...vals.slice(1)) : undefined;
            return <StatCard key={k} icon={icon} label={<>{KPI_LABEL[k]}<Hint id={k} /></>} value={fmtKpi(k, base?.summary[k]?.mean)} bars={vals}
              hint={best !== undefined ? <span className="tabular-nums">→ {fmtKpi(k, best)} best scenario</span> : base ? "baseline" : "no result yet"} />;
          })}
        </div>
      </div>

      <Panel icon={Workflow} title={wf ? wf.name : "Process Flow"} subtitle={wf ? `Process flow · ${wf.steps.length} steps` : "No workflows"} href={wf ? `/processes/${encodeURIComponent(wf.id)}` : "/processes"} linkLabel="View details" className="lg:col-span-7">
        {wf ? <FlowStrip wf={wf} company={company} base={base} /> : <p className="text-sm text-muted-foreground">No workflows.</p>}
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 lg:col-span-5">
        <Panel icon={Play} title={<span className="flex items-center gap-2"><span className={cn("size-2 rounded-full", busy ? "bg-rose-500 shadow-[0_0_10px_#f43f5e] animate-pulse" : "bg-rose-500/70")} />Simulation Controls</span>}
          subtitle={own ? sourceLabel(resultSource) : result && resultSource ? `Last result belongs to ${resultSource.name}` : "No result yet"} contentClassName="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Row k="Horizon" v={`${config.days} days × ${config.replications} reps`} />
            <Row k="Scenarios" v={scenarios.length} />
            <Row k="Policy" v={config.policy} />
            <Row k="Run-days" v={<span className={cn(config.include_events && runDays > 30 && "text-rose-400")}>{runDays}{config.include_events ? ` / 30${runDays > 30 ? " over budget" : ""}` : ""}</span>} />
          </dl>
          <div className="flex items-center gap-3">
            <button type="button" onClick={run} disabled={busy} aria-label="run simulation"
              className="press glow-primary flex size-14 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 bg-[linear-gradient(180deg,color-mix(in_oklch,var(--primary),white_14%),var(--primary))] text-primary-foreground disabled:opacity-60">
              {busy ? <Loader2 className="size-6 animate-spin" /> : <Play className="size-6 fill-current" />}
            </button>
            <span className="flex flex-col text-xs">
              <span className="font-medium">{busy ? "Simulating…" : "Run simulation"}</span>
              <Link href="/simulation" className="text-muted-foreground underline-offset-4 hover:underline">Playback and ledgers</Link>
            </span>
          </div>
        </Panel>

        <Panel icon={Sparkles} title="What-If Scenario" subtitle={spotlight ? spotlight.name : others.length || scenarios.length > 1 ? "Run to see the impact" : "Add a scenario to compare"} contentClassName="flex flex-col gap-3">
          {spotlight && base ? (
            <>
              <ul className="flex flex-col divide-y divide-white/[0.06]">
                {WHAT_IF.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                    <span className="text-muted-foreground">{KPI_LABEL[k]}</span>
                    <Delta k={k} value={spotlight.summary[k]?.mean} base={base.summary[k]?.mean} />
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Link href="/analysis" className={buttonVariants({ variant: "outline", size: "sm", className: "flex-1 rounded-full" })}>Compare</Link>
                <Link href="/scenarios" className={buttonVariants({ variant: "outline", size: "sm", className: "flex-1 rounded-full" })}>Edit</Link>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{scenarios.length > 1 ? `${scenarios.length - 1} what-if scenario${scenarios.length > 2 ? "s" : ""} waiting for a run.` : "Scenarios overlay changes on the base company: more demand, an outage, an extra hire."}</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="glass-inset flex flex-col rounded-lg px-2.5 py-1.5"><dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>
);
