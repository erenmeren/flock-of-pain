// Pure workflow-graph edits for the canvas; every function returns new objects and never mutates its input.
import { type Company, type Department, type Inflow, type Pos, type Step, type Workflow, idFor, weekdays9to5 } from "@/lib/company";
import { COL } from "@/components/process/layout";

const deps = (s: Step) => s.depends_on ?? [];
const without = <T,>(o: Record<string, T> | undefined, id: string) => o && Object.fromEntries(Object.entries(o).filter(([k]) => k !== id));
const moved = <T,>(o: Record<string, T> | undefined, from: string, to: string) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]));

/** The workflow's inflows; the arrival form reads as one implicit inflow entering every step without dependencies. */
export function inflowsOf(wf: Workflow): Inflow[] {
  if (wf.inflows) return wf.inflows;
  if (!wf.arrival) return [];
  const ids = wf.steps.map((s) => s.id);
  // "Arrival", not the workflow name: a second inflow would otherwise read "Order · Order" in results
  return [{ id: idFor("inflow", ids, "inflow"), name: "Arrival", ...wf.arrival, entry: wf.steps.filter((s) => !deps(s).length).map((s) => s.id) }];
}

/** The inflows form of a workflow (same object when it already is one), with `arrival` dropped. */
export function toInflows(wf: Workflow): Workflow {
  if (wf.inflows) return wf;
  const out = { ...wf, inflows: inflowsOf(wf) };
  delete out.arrival;
  return out;
}

/** Engine workflow id -> label, mirroring expand_inflows: `wf.inflow` / "wf · inflow" when a workflow has 2+ inflows. */
export function channelLabels(c: Company): Record<string, string> {
  const out: Record<string, string> = {};
  for (const wf of c.workflows) {
    const ins = inflowsOf(wf);
    if (ins.length < 2) out[wf.id] = wf.name;
    else for (const i of ins) out[`${wf.id}.${i.id}`] = `${wf.name} · ${i.name}`;
  }
  return out;
}

/** Total arrivals per hour over all inflows. */
export const rateOf = (wf: Workflow): number => inflowsOf(wf).reduce((n, i) => n + i.rate_per_hour, 0);

/** Step ids reached from any inflow entry by following successor edges. */
export function reachable(wf: Workflow): Set<string> {
  const seen = new Set<string>();
  const todo = inflowsOf(wf).flatMap((i) => i.entry);
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...wf.steps.filter((s) => deps(s).includes(id)).map((s) => s.id));
  }
  return seen;
}

/** True when `from` is `to` or transitively depends on it, so an edge from -> to would close a loop. */
export function wouldCycle(wf: Workflow, from: string, to: string): boolean {
  const seen = new Set<string>();
  const todo = [from];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...deps(wf.steps.find((s) => s.id === id) ?? { depends_on: [] } as unknown as Step));
  }
  return false;
}

/** Adds the edge from -> to (`from` an inflow or a step); the same object when it exists, null when it would loop. */
export function connect(wf: Workflow, from: string, to: string): Workflow | null {
  const inflow = wf.inflows?.find((i) => i.id === from);
  if (inflow) {
    if (inflow.entry.includes(to)) return wf;
    return { ...wf, inflows: wf.inflows!.map((i) => (i === inflow ? { ...i, entry: [...i.entry, to] } : i)) };
  }
  if (deps(wf.steps.find((s) => s.id === to)!).includes(from)) return wf;
  if (wouldCycle(wf, from, to)) return null;
  return { ...wf, steps: wf.steps.map((s) => (s.id === to ? { ...s, depends_on: [...deps(s), from] } : s)) };
}

/** Removes the edge from -> to; a `rework_to` that pointed at the removed dependency is cleared. */
export function disconnect(wf: Workflow, from: string, to: string): Workflow {
  return {
    ...wf,
    inflows: wf.inflows?.map((i) => (i.id === from ? { ...i, entry: i.entry.filter((e) => e !== to) } : i)),
    steps: wf.steps.map((s) => (s.id === to && !wf.inflows?.some((i) => i.id === from) ? { ...s, depends_on: deps(s).filter((d) => d !== from), rework_to: s.rework_to === from ? null : s.rework_to } : s)),
  };
}

/** Removes a step or an inflow and every reference to it. */
export function removeNode(wf: Workflow, id: string): Workflow {
  return {
    ...wf,
    inflows: wf.inflows?.filter((i) => i.id !== id).map((i) => ({ ...i, entry: i.entry.filter((e) => e !== id) })),
    layout: without(wf.layout, id),
    steps: wf.steps.filter((s) => s.id !== id).map((s) => ({ ...s, depends_on: deps(s).filter((d) => d !== id), rework_to: s.rework_to === id ? null : s.rework_to })),
  };
}

/** Renames a step id everywhere it is referenced. */
export function renameStep(wf: Workflow, from: string, to: string): Workflow {
  const r = (id: string) => (id === from ? to : id);
  return {
    ...wf,
    inflows: wf.inflows?.map((i) => ({ ...i, entry: i.entry.map(r) })),
    layout: moved(wf.layout, from, to),
    steps: wf.steps.map((s) => ({ ...s, id: r(s.id), depends_on: deps(s).map(r), rework_to: s.rework_to == null ? s.rework_to : r(s.rework_to) })),
  };
}

/** Renames an inflow id and its layout key. */
export function renameInflow(wf: Workflow, from: string, to: string): Workflow {
  return { ...wf, inflows: wf.inflows?.map((i) => (i.id === from ? { ...i, id: to } : i)), layout: moved(wf.layout, from, to) };
}

const takenIds = (wf: Workflow) => [...wf.steps.map((s) => s.id), ...inflowsOf(wf).map((i) => i.id)];
/** "New step", then "New step 2", ... so two palette drops never share a name. */
export function freshName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** New step at `pos`; a department with exactly one distinct skill prefills it. */
export function addStep(wf: Workflow, dept: Department | null, pos: Pos): { wf: Workflow; id: string } {
  const name = freshName("New step", wf.steps.map((s) => s.name));
  const id = idFor(name, takenIds(wf), "step");
  const skills = new Set(dept?.resources.flatMap((r) => r.skills));
  const st: Step = { id, name, department_id: dept?.id ?? "", required_skill: skills.size === 1 ? [...skills][0] : "", duration: { kind: "lognormal_mean", mean: 10, sigma: 0.4 }, depends_on: [] };
  return { wf: { ...wf, steps: [...wf.steps, st], layout: { ...wf.layout, [id]: pos } }, id };
}

/** Blank workflow with one inflow node so the canvas never opens empty. */
export function newWorkflow(name: string, takenIds: Iterable<string>): Workflow {
  return { id: idFor(name, takenIds, "workflow"), name, inflows: [{ id: "new_inflow", name: "New inflow", rate_per_hour: 1, window: weekdays9to5(), entry: [] }], layout: { new_inflow: [0, 0] }, steps: [] };
}

/** New inflow at `pos`, entering no step yet. */
export function addInflow(wf: Workflow, pos: Pos): { wf: Workflow; id: string } {
  const name = freshName("New inflow", inflowsOf(wf).map((i) => i.name));
  const id = idFor(name, takenIds(wf), "inflow");
  const inflow: Inflow = { id, name, rate_per_hour: 1, window: weekdays9to5(), entry: [] };
  return { wf: { ...wf, inflows: [...(wf.inflows ?? []), inflow], layout: { ...wf.layout, [id]: pos } }, id };
}

/** One column right of the rightmost stored position, at its height. */
export function nextFreePos(wf: Workflow): Pos {
  const ps = Object.values(wf.layout ?? {});
  if (!ps.length) return [0, 0];
  const r = ps.reduce((a, p) => (p[0] > a[0] ? p : a));
  return [r[0] + COL, r[1]];
}

export type Issue = { blocking: boolean; text: string };

/** What is wrong with a step: unfinished fields block a run, the rest only warn. */
export function stepIssues(c: Company, wf: Workflow, st: Step, reach = reachable(wf)): Issue[] {
  const out: Issue[] = [];
  const dept = c.departments.find((d) => d.id === st.department_id);
  if (st.department_id === "") out.push({ blocking: true, text: "Who does this?" });
  if (st.required_skill === "") out.push({ blocking: true, text: "What skill is needed?" });
  else if (st.department_id !== "" && !dept?.resources.some((r) => r.skills.includes(st.required_skill)))
    out.push({ blocking: false, text: `Nobody in ${dept?.name ?? st.department_id} has \`${st.required_skill}\`` });
  if (!reach.has(st.id)) out.push({ blocking: false, text: "Not connected to an inflow" });
  return out;
}

/** First thing that would make /simulate reject the company, phrased for the run button. */
export function blockingIssue(c: Company): { workflowId: string; message: string } | null {
  for (const wf of c.workflows) {
    const fix = (name: string, why: string) => ({ workflowId: wf.id, message: `Fix \`${name}\` on the ${wf.name} canvas: ${why}` });
    const inflows = inflowsOf(wf);
    if (!inflows.length) return { workflowId: wf.id, message: `${wf.name} has no inflow` };
    const empty = wf.arrival ? undefined : inflows.find((i) => !i.entry.length);
    if (empty) return fix(empty.name, "it enters no step");
    const reach = reachable(wf);
    for (const st of wf.steps) {
      const bad = stepIssues(c, wf, st, reach).find((i) => i.blocking);
      if (bad) return fix(st.name, bad.text.toLowerCase());
    }
  }
  return null;
}
