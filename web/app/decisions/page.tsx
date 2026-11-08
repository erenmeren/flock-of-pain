"use client";

import { useEffect, useRef, useState } from "react";
import { LineChart, Target, X } from "lucide-react";
import { CiChart } from "@/components/dashboard/ci-chart";
import { BASE_KPIS, Delta, KPI_LABEL, Panel, direction, fmtKpi, isPct } from "@/components/dashboard/kpi";
import { Interval } from "@/components/dashboard/results";
import { NumInput, Pick } from "@/components/editor-fields";
import { Hint } from "@/components/hint";
import { PageHeader } from "@/components/page";
import { Loading, TABLE_STYLE } from "@/components/org/parts";
import { blockingIssue } from "@/components/process/graph";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ApiError, type Job, type OptimizeResult, type SimulateResponse, cancelJob, startJob, startOptimize, waitForJob } from "@/lib/api";
import type { Company, Scenario } from "@/lib/company";
import { noiseLabel } from "@/lib/results";
import { useTwin } from "@/lib/store";
import { type SweepPoint, addScenario, budgetIssue, demandSweep, firstResource, jobConfig, parsePercents, staffSweep, sweepRows } from "@/lib/sweep";

const FIELD = "flex flex-col items-start gap-1.5 rounded-xl glass-inset p-3 text-[11px] font-normal uppercase tracking-wide text-muted-foreground [&>*]:normal-case [&>*]:tracking-normal";
const ALL = "__all__";

const kpiItems = (c: Company) => ({
  ...Object.fromEntries(BASE_KPIS.map((k) => [k, KPI_LABEL[k] ?? k])),
  ...Object.fromEntries(c.departments.map((d) => [`util_${d.id}`, `Utilization: ${d.name}`])),
});
const kpiName = (c: Company, k: string) => (kpiItems(c) as Record<string, string>)[k] ?? k;

/** One job's local progress; leaving the page cancels it so it does not hold a job slot. */
function useJob<R>() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<ApiError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const id = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (id.current) cancelJob(id.current).catch(() => {});
    };
  }, []);
  const start = async (create: () => Promise<{ id: string }>): Promise<R | null> => {
    setRunning(true); setError(null); setCancelled(false); setProgress({ done: 0, total: 0 });
    try {
      const job = await create();
      if (!alive.current) { cancelJob(job.id).catch(() => {}); return null; }
      id.current = job.id;
      const out = await waitForJob<R>(job.id, (j: Job<R>) => setProgress({ done: j.done, total: j.total }));
      if (out === null) setCancelled(true);
      return out;
    } catch (e) {
      setError(e as ApiError);
      return null;
    } finally {
      id.current = null;
      setRunning(false);
    }
  };
  const cancel = () => { if (id.current) cancelJob(id.current).catch((e) => setError(e as ApiError)); };
  return { running, progress, error, cancelled, setError, start, cancel };
}

function JobLine({ job, upTo }: { job: Pick<ReturnType<typeof useJob>, "running" | "progress" | "error" | "cancelled" | "cancel">; upTo?: boolean }) {
  const { done, total } = job.progress;
  return (
    <>
      {job.running && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-2 flex-1 rounded-full bg-white/[0.06]" role="progressbar" aria-label="job progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <div className="h-full rounded-full bg-primary motion-safe:transition-[width] duration-300" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <span className="tabular-nums">{done} of {upTo ? "up to " : ""}{total || "…"} runs</span>
          <Button variant="outline" size="sm" className="rounded-full" onClick={job.cancel}><X className="size-3.5" /> Cancel</Button>
        </div>
      )}
      {job.cancelled && <p className="text-xs text-muted-foreground">Cancelled.</p>}
      {job.error && <p role="alert" className="text-sm text-rose-400">{job.error.path ? `${job.error.path}: ` : ""}{job.error.message}</p>}
    </>
  );
}

const BaseSelect = ({ scenarios, value, onChange }: { scenarios: Scenario[]; value: string; onChange: (id: string) => void }) => (
  <Pick label="base scenario" className="w-full" value={value} items={Object.fromEntries(scenarios.map((s) => [s.id, s.name]))} onChange={onChange} />
);

function OptimizerPanel({ company }: { company: Company }) {
  const { scenarios, setScenarios, config } = useTwin();
  const [kpi, setKpi] = useState("wait_p90");
  const [op, setOp] = useState<"<=" | ">=">("<=");
  const [value, setValue] = useState(60); // as shown: percent for percent KPIs
  const [baseId, setBaseId] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [maxHires, setMaxHires] = useState(10);
  const [done, setDone] = useState<{ r: OptimizeResult; kpi: string; op: string; target: number; added: boolean } | null>(null);
  const job = useJob<OptimizeResult>();
  const base = scenarios.find((s) => s.id === baseId) ?? scenarios[0];
  const pct = isPct(kpi);
  const usable = base ? company.departments.filter((d) => firstResource(company, base, d.id)) : [];
  const picked = usable.filter((d) => !excluded.includes(d.id));
  const deptName = (id: string) => company.departments.find((d) => d.id === id)?.name ?? id;
  const hiresText = (h: Record<string, number>) => Object.entries(h).map(([d, n]) => `${deptName(d)} +${n}`).join(", ") || "none";

  const run = async () => {
    const issue = blockingIssue(company);
    if (issue) return job.setError({ path: "company", message: issue.message });
    if (!picked.length) return job.setError({ path: "candidates", message: "Pick at least one department." });
    const target = pct ? value / 100 : value;
    setDone(null);
    const r = await job.start(() => startOptimize({
      company, scenarios, config: jobConfig(config), target: { kpi, op, value: target }, base_scenario_id: base.id, max_hires: maxHires,
      candidates: picked.length === usable.length ? undefined : picked.map((d) => d.id),
    }));
    if (r) setDone({ r, kpi, op, target, added: false });
  };

  const fmtV = (v: number | undefined) => fmtKpi(done?.kpi ?? kpi, v);
  const path = done?.r.path ?? [];
  const reason = done && !done.r.met && {
    max_hires: `It stopped at the limit of ${path.length - 1} hires. Raise max hires to look further.`,
    budget: "It stopped because the run budget ran out. Fewer days, replications or candidate departments leave room for more rounds.",
    no_improvement: "No single extra hire improved the KPI, so the search stopped. This does not prove staffing cannot help: when two departments must grow together, adding one at a time shows no gain. Try adding both in a scenario by hand.",
    met: "",
  }[done.r.stopped];

  return (
    <Panel title={<span className="flex items-center gap-1">Staffing optimizer<Hint id="optimizer" /></span>} subtitle="Adds one employee at a time, best KPI gain per added cost first, until the target is met" icon={Target}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Label className={FIELD}>Target KPI
            <Pick label="target KPI" className="w-full" value={kpi} items={kpiItems(company)} onChange={(k) => { setKpi(k); setOp(direction(k) > 0 ? ">=" : "<="); }} />
          </Label>
          <Label className={FIELD}>Must be
            <Pick label="target operator" className="w-full" value={op} items={{ "<=": "at most", ">=": "at least" }} onChange={(v) => setOp(v as "<=" | ">=")} />
          </Label>
          <Label className={FIELD}>{pct ? "Value (%)" : "Value"}
            <NumInput aria-label="target value" className="w-full tabular-nums" hi={pct ? 100 : Infinity} value={value} onCommit={setValue} />
          </Label>
          <Label className={FIELD}>Base scenario
            {base ? <BaseSelect scenarios={scenarios} value={base.id} onChange={setBaseId} /> : <span className="text-xs">none</span>}
          </Label>
          <Label className={FIELD}>Max hires
            <NumInput aria-label="max hires" className="w-full tabular-nums" lo={1} hi={50} value={maxHires} onCommit={(v) => setMaxHires(Math.floor(v))} />
          </Label>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl glass-inset p-3">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Candidate departments</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {usable.length === 0 && <span className="text-sm text-muted-foreground">No department has anyone to copy a new hire from.</span>}
            {usable.map((d) => (
              <Label key={d.id} className="flex items-center gap-2 text-sm font-normal">
                <Checkbox aria-label={`candidate ${d.name}`} checked={!excluded.includes(d.id)}
                  onCheckedChange={(c) => setExcluded(c ? excluded.filter((x) => x !== d.id) : [...excluded, d.id])} /> {d.name}
              </Label>
            ))}
          </div>
        </div>
        <Button className="self-start rounded-full" disabled={job.running || !base} onClick={run}>Find staffing</Button>
        <JobLine job={job} upTo />
        {done && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start gap-3 rounded-xl glass-inset p-3 text-sm">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className={done.r.met ? "font-medium text-emerald-400" : "font-medium text-amber-400"}>
                  {done.r.met
                    ? path.length === 1 ? "The base scenario already meets the target: no hires needed." : `Target met with ${path.length - 1} ${path.length === 2 ? "hire" : "hires"}.`
                    : "Target not met."}
                  {" "}<span className="font-normal text-muted-foreground">{kpiName(company, done.kpi)} {done.op === "<=" ? "at most" : "at least"} {fmtV(done.target)}</span>
                </p>
                <p>Hires: {hiresText(done.r.hires)}</p>
                {reason && <p className="text-muted-foreground">{reason}</p>}
                {done.r.met && path.length > 1 && <p className="text-xs text-muted-foreground">Met means the cautious end of the 95% interval is on the right side of the target. Other mixes may be cheaper: the search never takes a hire back.</p>}
              </div>
              {Object.keys(done.r.hires).length > 0 && (
                <Button variant="outline" size="sm" className="rounded-full" disabled={done.added} onClick={() => { setScenarios(addScenario(scenarios, done.r.scenario as Scenario)); setDone({ ...done, added: true }); }}>
                  {done.added ? "Added" : "Add as scenario"}
                </Button>
              )}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <CiChart title={`${kpiName(company, done.kpi)} after each hire`} target={done.target} fmtV={fmtV} points={path.map((p, i) => ({ label: i ? `${i}` : "Base", mean: p.mean, low: p.ci_low, high: p.ci_high }))} />
              <CiChart title="Labor cost after each hire" color="var(--chart-2)" fmtV={(v) => fmtKpi("labor_cost", v)} points={path.map((p, i) => ({ label: i ? `${i}` : "Base", mean: p.labor_cost }))} />
            </div>
            <div className={`overflow-x-auto ${TABLE_STYLE}`}>
              <Table>
                <TableHeader><TableRow><TableHead>Step</TableHead><TableHead>Hires so far</TableHead><TableHead className="text-right">Mean</TableHead><TableHead className="text-right">95% interval</TableHead><TableHead className="text-right">Labor cost</TableHead></TableRow></TableHeader>
                <TableBody>
                  {path.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="tabular-nums">{i || "Base"}</TableCell>
                      <TableCell>{hiresText(p.hires)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmtV(p.mean)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtV(p.ci_low)}–{fmtV(p.ci_high)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtKpi("labor_cost", p.labor_cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function SweepPanel({ company }: { company: Company }) {
  const { scenarios, setScenarios, config } = useTwin();
  const [kind, setKind] = useState<"staff" | "demand">("staff");
  const [deptId, setDeptId] = useState("");
  const [count, setCount] = useState(5);
  const [percents, setPercents] = useState("10, 20, 30, 50");
  const [workflow, setWorkflow] = useState(ALL);
  const [baseId, setBaseId] = useState("");
  const [kpi, setKpi] = useState("wait_p90");
  const [done, setDone] = useState<{ points: SweepPoint[]; res: SimulateResponse } | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const job = useJob<SimulateResponse>();
  const base = scenarios.find((s) => s.id === baseId) ?? scenarios[0];
  const dept = company.departments.find((d) => d.id === deptId)?.id ?? company.departments[0]?.id ?? "";

  const run = async () => {
    const issue = blockingIssue(company);
    if (issue) return job.setError({ path: "company", message: issue.message });
    let points: SweepPoint[];
    if (kind === "staff") {
      points = staffSweep(company, base, dept, count);
      if (!points.length) return job.setError({ path: "department", message: "This department has nobody to copy a new employee from." });
    } else {
      const ps = parsePercents(percents);
      if (ps === null) return job.setError({ path: "values", message: "Give percentages above -100, like +10%, +20%." });
      if (!ps.length) return job.setError({ path: "values", message: "Give at least one percentage other than 0." });
      points = demandSweep(base, ps, workflow === ALL ? null : workflow);
    }
    const scenariosToRun = [base, ...points.map((p) => p.scenario)];
    const tooBig = budgetIssue(config, scenariosToRun.length);
    if (tooBig) return job.setError({ path: "config", message: tooBig });
    setDone(null);
    setAdded([]);
    const res = await job.start(() => startJob({ company, scenarios: scenariosToRun, config: jobConfig(config), include_events: false, save: false }));
    if (res) setDone({ points, res });
  };

  const rows = done ? sweepRows(done.points, done.res, kpi) : [];
  const fmtV = (v: number | undefined) => fmtKpi(kpi, v);
  return (
    <Panel title={<span className="flex items-center gap-1">Parameter sweep<Hint id="sweep" /></span>} subtitle="Runs the base scenario against a range of values, with common random numbers" icon={LineChart}
      action={done && <Pick label="sweep KPI" className="w-52 rounded-full" value={kpi} items={kpiItems(company)} onChange={setKpi} />}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Label className={FIELD}>Parameter
            <Pick label="sweep parameter" className="w-full" value={kind} items={{ staff: "Staff in a department", demand: "Demand" }} onChange={(v) => setKind(v as "staff" | "demand")} />
          </Label>
          {kind === "staff" ? <>
            <Label className={FIELD}>Department
              <Pick label="sweep department" className="w-full" value={dept} items={Object.fromEntries(company.departments.map((d) => [d.id, d.name]))} onChange={setDeptId} />
            </Label>
            <Label className={FIELD}>Add up to
              <NumInput aria-label="largest number of added employees" className="w-full tabular-nums" lo={1} hi={50} value={count} onCommit={(v) => setCount(Math.floor(v))} />
            </Label>
          </> : <>
            <Label className={FIELD}>Change (%)
              <Input aria-label="demand changes" className="w-full tabular-nums" value={percents} placeholder="+10%, +20%" onChange={(e) => setPercents(e.target.value)} />
            </Label>
            <Label className={FIELD}>Workflow
              <Pick label="sweep workflow" className="w-full" value={workflow} items={{ [ALL]: "All workflows", ...Object.fromEntries(company.workflows.map((w) => [w.id, w.name])) }} onChange={setWorkflow} />
            </Label>
          </>}
          <Label className={FIELD}>Base scenario
            {base ? <BaseSelect scenarios={scenarios} value={base.id} onChange={setBaseId} /> : <span className="text-xs">none</span>}
          </Label>
          {!done && (
            <Label className={FIELD}>KPI
              <Pick label="sweep KPI" className="w-full" value={kpi} items={kpiItems(company)} onChange={setKpi} />
            </Label>
          )}
        </div>
        <Button className="self-start rounded-full" disabled={job.running || !base} onClick={run}>Run sweep</Button>
        <JobLine job={job} />
        {done && (
          <div className="flex flex-col gap-3">
            <CiChart title={kpiName(company, kpi)} fmtV={fmtV} points={rows.map((r) => ({ label: r.label, mean: r.stat?.mean, low: r.stat?.ci_low, high: r.stat?.ci_high, muted: !r.point, note: r.comparison && noiseLabel(r.comparison) }))} />
            <div className={`overflow-x-auto ${TABLE_STYLE}`}>
              <Table>
                <TableHeader><TableRow><TableHead>Value</TableHead><TableHead className="text-right">Mean</TableHead><TableHead className="text-right">vs base <Hint id="significance" /></TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.label}>
                      <TableCell className="tabular-nums">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums"><span className="font-medium">{fmtV(r.stat?.mean)}</span> <Interval k={kpi} st={r.stat} /></TableCell>
                      <TableCell className="text-right text-xs">{r.point ? <Delta k={kpi} value={r.stat?.mean} base={done.res.scenarios[0]?.summary[kpi]?.mean} cmp={r.comparison} /> : <span className="text-muted-foreground">base</span>}</TableCell>
                      <TableCell className="text-right">
                        {r.point && (() => {
                          const s = r.point.scenario;
                          return <Button variant="outline" size="sm" className="rounded-full" disabled={added.includes(s.id)} aria-label={`add ${s.name} as scenario`}
                            onClick={() => { setScenarios(addScenario(scenarios, s)); setAdded([...added, s.id]); }}>{added.includes(s.id) ? "Added" : "Add as scenario"}</Button>;
                        })()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function DecisionsPage() {
  const { company, scenarios } = useTwin();
  if (!company) return <Loading />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Decisions" subtitle={`${company.name} · ${scenarios.length} scenarios · these runs do not replace the main result`} />
      {/* a different company starts both panels afresh: their results and departments belong to the old one */}
      <OptimizerPanel key={`o:${company.id}`} company={company} />
      <SweepPanel key={`s:${company.id}`} company={company} />
    </div>
  );
}
