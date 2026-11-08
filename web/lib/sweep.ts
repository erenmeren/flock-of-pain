// Pure logic of the parameter sweep: scenarios from a base scenario, budget check, chart rows. Also shared by the optimizer panel.
import type { Comparison, SimulateResponse, Stat } from "@/lib/api";
import { type Company, type Overlay, type Resource, type Scenario, idFor, runDays, weekdays9to5 } from "@/lib/company";
import type { Config } from "@/lib/store";

// The API's defaults; a server configured lower still answers 422 on `config`.
export const MAX_RUN_DAYS = 2000, MAX_RUNS = 400;

export type SweepPoint = { value: number; label: string; scenario: Scenario };

/** The `config` of a job: no store-only flags, common random numbers on so the differences come from the change. */
export const jobConfig = (c: Config) => ({ seed: c.seed, days: c.days, warmup_days: c.warmup_days, replications: c.replications, policy: c.policy, crn: true });

/** Why a job of `scenarios` scenarios would be refused, counted as /jobs does; null when it fits. */
export function budgetIssue(c: Config, scenarios: number): string | null {
  const runs = c.replications * scenarios;
  if (runs > MAX_RUNS) return `${c.replications} replications x ${scenarios} scenarios = ${runs} runs, over the limit of ${MAX_RUNS}. Use fewer values or replications.`;
  const total = runDays(c, scenarios);
  return total > MAX_RUN_DAYS ? `${c.days + (c.warmup_days ?? 0)} days x ${runs} runs = ${total} run-days, over the limit of ${MAX_RUN_DAYS}. Use fewer values, days or replications.` : null;
}

/** The department's first resource once the base scenario's overlays are applied. */
export function firstResource(c: Company, base: Scenario, deptId: string): Resource | null {
  let list = c.departments.find((d) => d.id === deptId)?.resources ?? [];
  for (const o of base.overlays) {
    if (o.type === "remove_resource") list = list.filter((r) => r.id !== o.resource_id);
    if (o.type === "add_employee" && o.department_id === deptId) list = [...list, o.employee];
  }
  return list[0] ?? null;
}

/** One person like `r`, also when r is a pool or inherits from one. Absences are personal, so not copied (as optimize.py). */
function hireLike(c: Company, r: Resource, id: string, name: string): Resource {
  const pool = r.pool_id ? c.departments.flatMap((d) => d.resources).find((x) => x.id === r.pool_id) : undefined;
  const overtime = r.overtime_rate ?? pool?.overtime_rate;
  return { id, name, skills: [...r.skills], cost_per_hour: r.cost_per_hour, speed_factor: r.speed_factor ?? 1, schedule: { weekday_hours: (r.schedule ?? pool?.schedule ?? weekdays9to5()).weekday_hours }, ...(overtime === undefined ? {} : { overtime_rate: overtime }) };
}

/** +1..+n employees in a department on top of the base's overlays; empty when the department has nobody to copy from. */
export function staffSweep(c: Company, base: Scenario, deptId: string, n: number): SweepPoint[] {
  const source = firstResource(c, base, deptId);
  if (!source) return [];
  const deptName = c.departments.find((d) => d.id === deptId)?.name ?? deptId;
  const taken = [...c.departments.flatMap((d) => d.resources.map((r) => r.id)), ...base.overlays.flatMap((o) => (o.type === "add_employee" ? [o.employee.id] : []))];
  const ids = [base.id], hires: Overlay[] = [], points: SweepPoint[] = [];
  for (let k = 1; k <= n; k++) {
    const id = idFor(`${deptId} sweep ${k}`, taken, "emp");
    taken.push(id);
    hires.push({ type: "add_employee", department_id: deptId, employee: hireLike(c, source, id, `New hire ${k}`) });
    const name = `${base.name} +${k} ${deptName}`;
    const sid = idFor(name, ids, "sweep");
    ids.push(sid);
    points.push({ value: k, label: `+${k}`, scenario: { id: sid, name, overlays: [...base.overlays, ...hires] } });
  }
  return points;
}

const signed = (p: number) => `${p > 0 ? "+" : ""}${p}%`;

/** "+10%, 20 -5" as sorted distinct percent changes, without 0 (that is the base); [] for an empty box, null when a value is not above -100. */
export function parsePercents(text: string): number[] | null {
  const ps = text.replace(/%/g, " ").split(/[,;\s]+/).filter(Boolean).map(Number);
  return ps.every((p) => Number.isFinite(p) && p > -100) ? [...new Set(ps)].filter((p) => p !== 0).sort((a, b) => a - b) : null;
}

/** One `arrival_multiplier` per percent on top of the base's overlays; workflowId null = all workflows. */
export function demandSweep(base: Scenario, percents: number[], workflowId: string | null): SweepPoint[] {
  const ids = [base.id];
  return percents.map((p) => {
    const name = `${base.name} demand ${signed(p)}`;
    const id = idFor(name, ids, "sweep");
    ids.push(id);
    return { value: p, label: signed(p), scenario: { id, name, overlays: [...base.overlays, { type: "arrival_multiplier", factor: 1 + p / 100, workflow_id: workflowId }] } };
  });
}

/** The draft with `s` appended under an id no draft scenario has. */
export const addScenario = (draft: Scenario[], s: Scenario): Scenario[] => [...draft, { ...s, id: idFor(s.id, draft.map((x) => x.id), "scenario") }];

export type SweepRow = { label: string; value: number; stat?: Stat; comparison?: Comparison; point: SweepPoint | null };

/** A chart row per value for one KPI, the base (first scenario of the response) at value 0, in value order. */
export function sweepRows(points: SweepPoint[], res: SimulateResponse, kpi: string): SweepRow[] {
  const baseRow: SweepRow = { label: "Base", value: 0, stat: res.scenarios[0]?.summary[kpi], point: null };
  const rows = points.map((point): SweepRow => {
    const s = res.scenarios.find((x) => x.id === point.scenario.id);
    return { label: point.label, value: point.value, stat: s?.summary[kpi], comparison: s?.comparison?.[kpi], point };
  });
  return [baseRow, ...rows].sort((a, b) => a.value - b.value);
}
