// Pure numbers behind the overview; `npm test` checks them.
import type { ScenarioResult, Stat, WorkflowMetrics } from "@/lib/api";
import { type Company, type Workflow } from "@/lib/company";

export type Health = { total: number; label: string; parts: { label: string; score: number; hint: string }[] };

const clamp100 = (x: number) => Math.max(0, Math.min(100, x));

/** Composite 0–100 of the baseline run: completion, SLA, rework, and how close utilization sits to a healthy 75%. */
export function healthScores(summary: Record<string, Stat> | undefined): Health | null {
  const get = (k: string) => summary?.[k]?.mean;
  const completion = get("completion_rate"), sla = get("sla_breach_rate"), rework = get("rework_rate"), util = get("mean_dept_utilization");
  if (completion === undefined || sla === undefined || rework === undefined || util === undefined) return null;
  const parts = [
    { label: "Delivery", score: clamp100(completion * 100), hint: "completion rate" },
    { label: "SLA", score: clamp100((1 - sla) * 100), hint: "100 − SLA breach rate" },
    { label: "Quality", score: clamp100((1 - rework) * 100), hint: "100 − rework rate" },
    { label: "Balance", score: clamp100(100 - Math.abs(util - 0.75) * 250), hint: "mean utilization near 75% scores 100; 35% or 115% score 0" },
  ];
  const total = Math.round(parts.reduce((s, p) => s + p.score, 0) / parts.length);
  return { total, label: total >= 80 ? "Healthy" : total >= 60 ? "Strained" : "At risk", parts };
}

export type Edge = { from: string; to: string; n: number; dept: number | null }; // dept = index of the source department, null for an inflow

/** Inflow (workflow → first step's department) and hand-off (consecutive steps in different departments) edges. */
export function mapEdges(c: Company): Edge[] {
  const di = new Map(c.departments.map((d, i) => [d.id, i]));
  const edges = new Map<string, Edge>();
  const add = (from: string, to: string, dept: number | null) => {
    const k = `${from}>${to}`;
    const e = edges.get(k) ?? { from, to, n: 0, dept };
    e.n++; edges.set(k, e);
  };
  for (const w of c.workflows) {
    const first = w.steps[0];
    if (first) add(`w:${w.id}`, `d:${first.department_id}`, null);
    for (let i = 1; i < w.steps.length; i++) {
      const a = w.steps[i - 1].department_id, b = w.steps[i].department_id;
      if (a !== b) add(`d:${a}`, `d:${b}`, di.get(a) ?? 0);
    }
    for (const st of w.steps) if (st.system_id) add(`d:${st.department_id}`, `s:${st.system_id}`, di.get(st.department_id) ?? 0);
  }
  return [...edges.values()];
}

/** Minutes as "2.3 h" past two hours, else "95 min". */
export const minutes = (m: number | null) => (m === null ? "–" : m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m.toFixed(0)} min`);

/** Steps whose department changes from the previous step. */
export const handoffs = (wf: Workflow) => wf.steps.filter((st, i) => i > 0 && st.department_id !== wf.steps[i - 1].department_id).length;


/** Per-workflow metrics averaged over a scenario's replications (ids as the engine ran them). */
export function workflowMeans(s: ScenarioResult): Record<string, WorkflowMetrics> {
  const acc: Record<string, WorkflowMetrics> = {};
  const n = s.runs.length || 1;
  for (const run of s.runs) {
    for (const [id, m] of Object.entries(run.metrics.workflows)) {
      const a = acc[id] ?? (acc[id] = Object.fromEntries(Object.keys(m).map((k) => [k, 0])) as WorkflowMetrics);
      for (const k of Object.keys(m) as (keyof WorkflowMetrics)[]) a[k] += m[k] / n;
    }
  }
  return acc;
}
