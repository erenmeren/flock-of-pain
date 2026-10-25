// TypeScript mirror of the Company JSON contract (src/flock_of_pain/io.py).
export type Hours = [number, number];
export type Schedule = { weekday_hours: Record<string, Hours>; absences?: Hours[] };
export type Resource = {
  id: string;
  name?: string;
  skills: string[];
  cost_per_hour: number;
  speed_factor?: number;
  schedule: Schedule | null; // null on a person with pool_id = inherit the pool's schedule
  pool_id?: string;
  headcount?: number; // present = pool
};
export type Department = { id: string; name: string; resources: Resource[] };
export type System = { id: string; name: string };
export type Dist = { kind: string; a?: number; b?: number; c?: number; mean?: number; sigma?: number };
export type Step = {
  id: string;
  name: string;
  department_id: string;
  required_skill: string;
  duration: Dist;
  depends_on?: string[];
  system_id?: string | null;
  priority?: number;
  sla_minutes?: number | null;
  failure_prob?: number;
  rework_to?: string | null;
  max_retries?: number;
};
export type Workflow = { id: string; name: string; arrival: { rate_per_hour: number; window: Schedule }; steps: Step[] };
export type Outage = [string, number, number];
export type Company = {
  id: string;
  name: string;
  systems: System[];
  departments: Department[];
  workflows: Workflow[];
  outages?: Outage[];
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const weekdays9to5 = (): Schedule => ({
  weekday_hours: Object.fromEntries([0, 1, 2, 3, 4].map((d) => [String(d), [9, 17]])),
});

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Shape checks the editor relies on to render; the API does the full validation. */
export function checkCompany(c: unknown): Company {
  if (!isObj(c) || !Array.isArray(c.departments)) throw new Error("expected a company object with departments");
  const out = { systems: [], workflows: [], ...c } as unknown as Company;
  if (!Array.isArray(out.systems) || !out.systems.every((s) => isObj(s))) throw new Error("systems must be a list of objects");
  const hoursOk = (h: unknown) => isObj(h) && Object.values(h).every((v) => Array.isArray(v) && v.length === 2);
  const stepOk = (st: unknown) => isObj(st) && typeof st.id === "string" && typeof st.required_skill === "string" && isObj(st.duration)
    && (st.depends_on === undefined || Array.isArray(st.depends_on));
  if (!Array.isArray(out.workflows) || !out.workflows.every((w) => isObj(w) && Array.isArray(w.steps) && w.steps.every(stepOk)
      && isObj(w.arrival) && typeof w.arrival.rate_per_hour === "number" && isObj(w.arrival.window) && hoursOk(w.arrival.window.weekday_hours)))
    throw new Error("workflows must be a list of objects with steps, durations and an arrival window");
  if (out.outages !== undefined && !(Array.isArray(out.outages) && out.outages.every((o) => Array.isArray(o) && o.length === 3)))
    throw new Error("outages must be a list of [system_id, start, end]");
  for (const d of out.departments) {
    if (!isObj(d) || !Array.isArray(d.resources)) throw new Error("each department needs a resources list");
    for (const r of d.resources) {
      if (!isObj(r) || !Array.isArray(r.skills)) throw new Error("each resource needs a skills list");
      if (r.schedule != null && (!isObj(r.schedule) || !hoursOk(r.schedule.weekday_hours)))
        throw new Error("schedule needs weekday_hours of [start, end] pairs");
    }
  }
  return out;
}

export const parseCompany = (text: string): Company => checkCompany(JSON.parse(text));

/** Ids referenced by workflows/outages; the editor blocks deleting these. */
export function referencedIds(c: Company): { departments: Set<string>; systems: Set<string> } {
  const steps = c.workflows.flatMap((w) => w.steps);
  return {
    departments: new Set(steps.map((s) => s.department_id)),
    systems: new Set([...steps.map((s) => s.system_id).filter((x): x is string => !!x), ...(c.outages ?? []).map((o) => o[0])]),
  };
}

export function renameDepartment(c: Company, from: string, to: string): Company {
  return { ...c, workflows: c.workflows.map((w) => ({ ...w, steps: w.steps.map((s) => (s.department_id === from ? { ...s, department_id: to } : s)) })) };
}

export function renameSystem(c: Company, from: string, to: string): Company {
  return {
    ...c,
    workflows: c.workflows.map((w) => ({ ...w, steps: w.steps.map((s) => (s.system_id === from ? { ...s, system_id: to } : s)) })),
    outages: c.outages?.map((o) => (o[0] === from ? [to, o[1], o[2]] : o)),
  };
}

/** Mean minutes shown for a duration; null when the kind has no simple mean the editor can round-trip. */
export function durationMean(d: Dist): number | null {
  if (d.kind === "lognormal_mean") return d.mean ?? null;
  if (d.kind === "lognormal") return Math.exp((d.a ?? 0) + (d.b ?? 0) ** 2 / 2); // the exporter writes the raw form
  if (d.kind === "const") return d.a ?? null;
  return null;
}

// Scenario JSON contract (src/flock_of_pain/io.py: OVERLAY_TYPES).
export type Overlay =
  | { type: "arrival_multiplier"; factor: number; workflow_id: string | null }
  | { type: "system_outage"; system_id: string; start: number; end: number }
  | { type: "add_employee"; department_id: string; employee: Resource }
  | { type: "remove_resource"; resource_id: string }
  | { type: "set_pool_headcount"; pool_id: string; headcount: number }
  | { type: "absence"; resource_id: string; start: number; end: number };
export type Scenario = { id: string; name: string; overlays: Overlay[] };

export const OVERLAY_TYPES = ["arrival_multiplier", "system_outage", "add_employee", "remove_resource", "set_pool_headcount", "absence"] as const;

type IdField = "department_id" | "system_id" | "resource_id" | "pool_id" | "workflow_id";
const ID_FIELD = new Map<string, IdField>([["arrival_multiplier", "workflow_id"], ["system_outage", "system_id"], ["add_employee", "department_id"],
  ["remove_resource", "resource_id"], ["set_pool_headcount", "pool_id"], ["absence", "resource_id"]]);

const overlayOk = (o: unknown) => {
  if (!isObj(o) || typeof o.type !== "string") return false;
  const f = ID_FIELD.get(o.type);
  if (f && typeof o[f] !== "string" && !(f === "workflow_id" && o[f] === null)) return false; // null workflow_id = all workflows
  return o.type !== "add_employee" || (isObj(o.employee) && typeof o.employee.id === "string" && Array.isArray(o.employee.skills));
};

/** Light shape check for the scenarios; the API validates fully. */
export function checkScenarios(s: unknown): Scenario[] {
  if (!Array.isArray(s) || !s.every((x) => isObj(x) && typeof x.id === "string" && Array.isArray(x.overlays) && x.overlays.every(overlayOk)))
    throw new Error("scenarios must be a list of {id, name, overlays} with string ids (add_employee needs an employee with id and skills)");
  return s as Scenario[];
}

export const parseScenarios = (text: string): Scenario[] => checkScenarios(JSON.parse(text));

/** Overlays follow an id rename; `field` names which kind of id changed. */
export function renameInScenarios(scenarios: Scenario[], field: IdField, from: string, to: string): Scenario[] {
  return scenarios.map((s) => ({
    ...s,
    overlays: s.overlays.map((o) => (ID_FIELD.get(o.type) === field && (o as Record<string, unknown>)[field] === from ? { ...o, [field]: to } : o)),
  }));
}

/** Ids scenario overlays point at; the editor blocks deleting these. */
export function scenarioRefs(scenarios: Scenario[]): { departments: Set<string>; systems: Set<string>; resources: Set<string> } {
  const refs = scenarios.flatMap((s) => s.overlays).map((o) => {
    const f = ID_FIELD.get(o.type);
    return { f, id: f && (o as Record<string, unknown>)[f] };
  });
  const ids = (...fields: IdField[]) => new Set(refs.flatMap(({ f, id }) => (f && fields.includes(f) && typeof id === "string" ? [id] : [])));
  return { departments: ids("department_id"), systems: ids("system_id"), resources: ids("resource_id", "pool_id") };
}

/** Everyone the company employs: pool headcount counts the carved members already. */
export function headcount(c: Company): number {
  return c.departments.flatMap((d) => d.resources).reduce((n, r) => n + (r.headcount !== undefined ? r.headcount : r.pool_id ? 0 : 1), 0);
}
