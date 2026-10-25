// TypeScript mirror of the Company JSON contract (src/flock_of_pain/io.py). Workflows stay opaque: edited as JSON.
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
// Only the fields the editor must keep consistent when ids change; the rest passes through untouched.
export type Step = { department_id: string; system_id?: string | null; [k: string]: unknown };
export type Workflow = { steps: Step[]; [k: string]: unknown };
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

/** JSON.parse plus the shape checks the editor relies on to render; the API does the full validation. */
export function parseCompany(text: string): Company {
  const c = JSON.parse(text);
  if (!isObj(c) || !Array.isArray(c.departments)) throw new Error("expected a company object with departments");
  const out = { systems: [], workflows: [], ...c } as unknown as Company;
  if (!Array.isArray(out.systems) || !out.systems.every((s) => isObj(s))) throw new Error("systems must be a list of objects");
  if (!Array.isArray(out.workflows) || !out.workflows.every((w) => isObj(w) && Array.isArray(w.steps) && w.steps.every(isObj)))
    throw new Error("workflows must be a list of objects with steps");
  if (out.outages !== undefined && !Array.isArray(out.outages)) throw new Error("outages must be a list");
  for (const d of out.departments) {
    if (!isObj(d) || !Array.isArray(d.resources)) throw new Error("each department needs a resources list");
    for (const r of d.resources) {
      if (!isObj(r) || !Array.isArray(r.skills)) throw new Error("each resource needs a skills list");
      if (r.schedule != null && (!isObj(r.schedule) || !isObj(r.schedule.weekday_hours)))
        throw new Error("schedule needs weekday_hours");
    }
  }
  return out;
}

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
