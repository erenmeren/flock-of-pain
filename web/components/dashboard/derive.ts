// Pure numbers behind the overview; `npm test` checks them.
import type { ScenarioResult, Stat, WorkflowMetrics } from "@/lib/api";
import { type Company, type Workflow } from "@/lib/company";
import { inflowsOf } from "@/components/process/graph";

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

/** Department pairs [from, to] joined by a depends_on edge between steps in different departments, once per pair. */
function deptPairs(wf: Workflow): [string, string][] {
  const dept = new Map(wf.steps.map((s) => [s.id, s.department_id]));
  const out = new Map<string, [string, string]>();
  for (const st of wf.steps) for (const p of st.depends_on ?? []) {
    const a = dept.get(p);
    if (a !== undefined && a !== st.department_id) out.set(`${a}>${st.department_id}`, [a, st.department_id]);
  }
  return [...out.values()];
}

/** Inflow (workflow → departments of its entry steps) and hand-off (depends_on across departments) edges. */
export function mapEdges(c: Company): Edge[] {
  const di = new Map(c.departments.map((d, i) => [d.id, i]));
  const edges = new Map<string, Edge>();
  const add = (from: string, to: string, dept: number | null) => {
    const k = `${from}>${to}`;
    const e = edges.get(k) ?? { from, to, n: 0, dept };
    e.n++; edges.set(k, e);
  };
  for (const w of c.workflows) {
    const dept = new Map(w.steps.map((s) => [s.id, s.department_id]));
    for (const d of new Set(inflowsOf(w).flatMap((i) => i.entry).flatMap((id) => dept.get(id) ?? []))) add(`w:${w.id}`, `d:${d}`, null);
    for (const [a, b] of deptPairs(w)) add(`d:${a}`, `d:${b}`, di.get(a) ?? 0);
    for (const st of w.steps) if (st.system_id) add(`d:${st.department_id}`, `s:${st.system_id}`, di.get(st.department_id) ?? 0);
  }
  return [...edges.values()];
}

/** Departments in flow order, one column per hand-off depth: where work enters first comes first.
 *  Order is discovery from the inflows along hand-offs; only hand-offs that point forward in it count, so cycles cannot push a column right forever.
 *  Departments no workflow touches form the last column; ids with no department are left out. */
export function deptColumns(c: Company): string[][] {
  const known = new Set(c.departments.map((d) => d.id));
  const edges = mapEdges(c);
  const hand = edges.filter((e) => e.from.startsWith("d:") && e.to.startsWith("d:")).map((e) => [e.from.slice(2), e.to.slice(2)] as const);
  const starts = [...edges.filter((e) => e.from.startsWith("w:")).map((e) => e.to.slice(2)), ...c.workflows.flatMap((w) => w.steps.map((s) => s.department_id))];
  const seen: string[] = [];
  for (const start of starts) { // breadth-first from each entry; steps no inflow reaches still get a column
    const queue = [start];
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      if (seen.includes(d)) continue;
      seen.push(d);
      queue.push(...hand.filter(([a]) => a === d).map(([, b]) => b));
    }
  }
  const order = seen.filter((d) => known.has(d));
  const pos = new Map(order.map((d, i) => [d, i]));
  const rank = new Map(order.map((d) => [d, 0]));
  const forward = hand.filter(([a, b]) => pos.has(a) && pos.has(b) && pos.get(a)! < pos.get(b)!);
  for (let i = 0; i < order.length; i++) for (const [a, b] of forward) rank.set(b, Math.max(rank.get(b)!, rank.get(a)! + 1));
  const cols: string[][] = [];
  for (const d of order) (cols[rank.get(d)!] ??= []).push(d);
  const idle = c.departments.map((d) => d.id).filter((d) => !pos.has(d));
  if (idle.length) cols.push(idle);
  return cols.filter(Boolean);
}

/** Minutes as "2.3 h" past two hours, else "95 min". */
export const minutes = (m: number | null) => (m === null ? "–" : m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m.toFixed(0)} min`);

/** Distinct department pairs work is handed between along depends_on. */
export const handoffs = (wf: Workflow) => deptPairs(wf).length;


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
