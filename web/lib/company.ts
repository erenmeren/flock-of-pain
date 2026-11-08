// TypeScript mirror of the Company JSON contract (src/flock_of_pain/io.py).
export type Hours = [number, number];
export type Schedule = { weekday_hours: Record<string, Hours | Hours[]>; absences?: Hours[] }; // one pair or a list of windows per day
/** Multipliers on rate_per_hour by hour of day ("0".."23") and weekday ("0".."6"); a missing key is 1. */
export type Profile = { hours?: Record<string, number>; weekdays?: Record<string, number> };
export type Resource = {
  id: string;
  name?: string;
  skills: string[];
  cost_per_hour: number;
  speed_factor?: number;
  schedule: Schedule | null; // null on a person with pool_id = inherit the pool's schedule
  pool_id?: string;
  headcount?: number; // present = pool
  overtime_rate?: number; // >= 1: busy minutes outside the shift cost cost_per_hour times this
};
export type Department = { id: string; name: string; resources: Resource[] };
export type System = { id: string; name: string };
export type Dist = { kind: string; a?: number; b?: number; c?: number; mean?: number; sigma?: number };
export type Step = {
  id: string;
  name: string;
  department_id: string;
  required_skill: string | null; // null = wait step: nobody works, it only takes time
  duration: Dist;
  depends_on?: string[];
  system_id?: string | null;
  priority?: number;
  sla_minutes?: number | null;
  failure_prob?: number;
  rework_to?: string | null;
  max_retries?: number;
  branches?: { to: string; prob: number }[]; // exactly one target (or none) runs; the rest are skipped
  release_hours?: number[]; // batch release: tasks wait until the next of these hours of day
  patience?: Dist; // minutes a queued task waits before the item is abandoned
};
export type Pos = [number, number];
export type Inflow = { id: string; name: string; rate_per_hour: number; window: Schedule; entry: string[]; profile?: Profile; initial_backlog?: number };
export type Workflow = {
  id: string;
  name: string;
  arrival?: { rate_per_hour: number; window: Schedule; profile?: Profile; initial_backlog?: number }; // an arrival or inflows, never both
  cutoff_hour?: number; // an instance is due at the next time of day with this hour
  inflows?: Inflow[];
  layout?: Record<string, Pos>; // canvas positions by step/inflow id
  steps: Step[];
};
export type Outage = [string, number, number];
export type Company = {
  id: string;
  name: string;
  systems: System[];
  departments: Department[];
  workflows: Workflow[];
  outages?: Outage[];
  holidays?: number[]; // day numbers from time zero
  actuals?: Record<string, number>; // observed KPI values, for the reality check; the engine ignores them
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const weekdays9to5 = (): Schedule => ({
  weekday_hours: Object.fromEntries([0, 1, 2, 3, 4].map((d) => [String(d), [9, 17]])),
});

/** The windows of one weekday_hours value: a bare pair reads as one window. */
export const windowsOf = (v: Hours | Hours[]): Hours[] => (typeof v[0] === "number" ? [v as Hours] : (v as Hours[]));

/** Every day's window that holds `hour` gets a one-hour break there: [s, e] -> [s, hour], [hour + 1, e]. */
export function splitAt(s: Schedule, hour: number): Schedule {
  const cut = (ws: Hours[]): Hours | Hours[] => {
    const out = ws.flatMap(([a, b]): Hours[] => (a < hour && hour + 1 < b ? [[a, hour], [hour + 1, b]] : [[a, b]]));
    return out.length === 1 ? out[0] : out;
  };
  return { ...s, weekday_hours: Object.fromEntries(Object.entries(s.weekday_hours).map(([k, v]) => [k, cut(windowsOf(v))])) };
}

/** Every day back to one window, from its first start to its last end. */
export function mergeWindows(s: Schedule): Schedule {
  return { ...s, weekday_hours: Object.fromEntries(Object.entries(s.weekday_hours).map(([k, v]) => {
    const ws = windowsOf(v);
    return [k, ws.length ? [ws[0][0], ws[ws.length - 1][1]] as Hours : v];
  })) };
}

/** Every working day has the same one or two windows, so the simple form shows it without loss. */
export const sameEveryDay = (s: Schedule) => {
  const all = Object.values(s.weekday_hours).map(windowsOf);
  return all.every((w) => JSON.stringify(w) === JSON.stringify(all[0]) && (w.length === 1 || w.length === 2));
};

/** Loader rule: start < end <= start + 24, windows in order without overlap. `step` 1 snaps to whole hours; a finer step keeps the data's fractions. */
export function orderWindows(ws: Hours[], step: number): Hours[] {
  const snap = step === 1 ? Math.floor : (x: number) => x;
  const within = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let lo = 0;
  return ws.map(([s, e]) => {
    s = within(snap(s), lo, 24 - step);
    e = within(snap(e), s + step, s + 24);
    lo = e;
    return [s, e];
  });
}

/** One weekday's windows set, or the day removed when null; every other day and the absences stay exactly as stored. */
export function setDayHours(s: Schedule, day: string, ws: Hours[] | null): Schedule {
  const weekday_hours = { ...s.weekday_hours };
  if (ws) { const out = orderWindows(ws, 0.25); weekday_hours[day] = out.length === 1 ? out[0] : out; } else delete weekday_hours[day];
  return { ...s, weekday_hours };
}

/** Profile with `key`'s multiplier at `k` set; values of 1 are dropped and an all-1 profile is undefined. */
export function setMultiplier(p: Profile | undefined, key: keyof Profile, k: string, v: number): Profile | undefined {
  const m = Object.fromEntries(Object.entries({ ...p?.[key], [k]: v }).filter(([, x]) => x !== 1));
  const out: Profile = { ...p, [key]: m };
  if (!Object.keys(m).length) delete out[key];
  return Object.keys(out).length ? out : undefined;
}

export const slug = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Id derived from a name, unique among `taken`; `base` when the name has no letters or digits. `keep` is the item's current id, reused when it already fits. */
export function idFor(name: string, taken: Iterable<string>, base: string, keep?: string): string {
  const ids = new Set(taken);
  const s = slug(name) || base;
  if (s === keep) return keep;
  if (!ids.has(s)) return s;
  let n = 2;
  while (ids.has(`${s}_${n}`) && `${s}_${n}` !== keep) n++;
  return `${s}_${n}`;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Shape checks the editor relies on to render; the API does the full validation. */
export function checkCompany(c: unknown): Company {
  if (!isObj(c) || !Array.isArray(c.departments)) throw new Error("expected a company object with departments");
  if (typeof c.id !== "string" || !c.id || typeof c.name !== "string") throw new Error("company needs a non-empty string id and a string name");
  const out = { systems: [], workflows: [], ...c } as unknown as Company;
  if (!Array.isArray(out.systems) || !out.systems.every((s) => isObj(s))) throw new Error("systems must be a list of objects");
  const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";
  const hoursOk = (h: unknown) => isObj(h) && Object.values(h).every((v) => pair(v) || (Array.isArray(v) && v.every(pair)));
  const stepOk = (st: unknown) => isObj(st) && typeof st.id === "string" && (typeof st.required_skill === "string" || st.required_skill === null) && isObj(st.duration)
    && (st.depends_on === undefined || Array.isArray(st.depends_on))
    && (st.branches === undefined || (Array.isArray(st.branches) && st.branches.every((b) => isObj(b) && typeof b.to === "string" && typeof b.prob === "number")));
  if (!Array.isArray(out.workflows) || !out.workflows.every((w) => isObj(w) && Array.isArray(w.steps) && w.steps.every(stepOk)
      && (w.arrival === undefined || (isObj(w.arrival) && typeof w.arrival.rate_per_hour === "number" && isObj(w.arrival.window) && hoursOk(w.arrival.window.weekday_hours)))
      && (w.inflows === undefined || (Array.isArray(w.inflows) && w.inflows.every((i) => isObj(i) && typeof i.id === "string" && Array.isArray(i.entry)
        && typeof i.rate_per_hour === "number" && isObj(i.window) && hoursOk(i.window.weekday_hours))))
      && (w.layout === undefined || (isObj(w.layout) && Object.values(w.layout).every((v) => Array.isArray(v) && v.length === 2)))))
    throw new Error("workflows must be a list of objects with steps, durations and an arrival or inflows");
  const backlogOk = (x: unknown) => x === undefined || (isObj(x) && (x.initial_backlog === undefined || (Number.isInteger(x.initial_backlog) && (x.initial_backlog as number) >= 0)));
  if (!out.workflows.every((w) => backlogOk(w.arrival) && (w.inflows ?? []).every(backlogOk))) throw new Error("initial_backlog must be a whole number >= 0");
  if (out.holidays !== undefined && !(Array.isArray(out.holidays) && out.holidays.every((h) => Number.isInteger(h) && h >= 0)))
    throw new Error("holidays must be a list of whole day numbers >= 0");
  if (out.actuals !== undefined && !(isObj(out.actuals) && Object.values(out.actuals).every(Number.isFinite)))
    throw new Error("actuals must map KPI names to numbers");
  if (out.outages !== undefined && !(Array.isArray(out.outages) && out.outages.every((o) => Array.isArray(o) && o.length === 3)))
    throw new Error("outages must be a list of [system_id, start, end]");
  for (const d of out.departments) {
    if (!isObj(d) || !Array.isArray(d.resources)) throw new Error("each department needs a resources list");
    for (const r of d.resources) {
      if (!isObj(r) || !Array.isArray(r.skills)) throw new Error("each resource needs a skills list");
      if (r.overtime_rate !== undefined && !(typeof r.overtime_rate === "number" && r.overtime_rate >= 1))
        throw new Error(`resource ${r.id}: overtime_rate must be a number >= 1`);
      if (r.schedule != null && (!isObj(r.schedule) || !hoursOk(r.schedule.weekday_hours)))
        throw new Error("schedule needs weekday_hours of [start, end] pairs or lists of them");
      if (r.schedule?.absences !== undefined && !(Array.isArray(r.schedule.absences) && r.schedule.absences.every(pair)))
        throw new Error(`resource ${r.id}: absences must be a list of [start, end] minutes`);
    }
  }
  const depts = new Set(out.departments.map((d) => d.id)), systems = new Set(out.systems.map((s) => s.id));
  const profileOk = (p: unknown) => p === undefined || (isObj(p) && [p.hours, p.weekdays].every((m) => m === undefined || (isObj(m) && Object.values(m).every((v) => typeof v === "number"))));
  for (const w of out.workflows) {
    if (w.cutoff_hour !== undefined && !(typeof w.cutoff_hour === "number" && w.cutoff_hour >= 0 && w.cutoff_hour < 24))
      throw new Error(`workflow ${w.id}: cutoff_hour must be a number in [0, 24)`);
    if (![w.arrival?.profile, ...(w.inflows ?? []).map((i) => i.profile)].every(profileOk))
      throw new Error(`workflow ${w.id}: profile multipliers must be numbers`);
    const steps = new Set(w.steps.map((s) => s.id));
    for (const st of w.steps) {
      const at = `step ${st.id} in workflow ${w.id}`;
      if (st.department_id && !depts.has(st.department_id)) throw new Error(`${at}: unknown department ${st.department_id}`); // "" = not picked yet
      if (st.system_id && !systems.has(st.system_id)) throw new Error(`${at}: unknown system ${st.system_id}`);
      const dep = st.depends_on?.find((d) => !steps.has(d));
      if (dep !== undefined) throw new Error(`${at}: depends on unknown step ${dep}`);
      const to = st.branches?.find((b) => !steps.has(b.to));
      if (to) throw new Error(`${at}: branch to unknown step ${to.to}`);
      if (st.required_skill === null && st.system_id) throw new Error(`${at}: a wait step cannot use a system`);
      if (st.release_hours !== undefined && !(Array.isArray(st.release_hours) && st.release_hours.every((h) => typeof h === "number" && h >= 0 && h < 24)))
        throw new Error(`${at}: release_hours must be numbers in [0, 24)`);
      if (st.patience !== undefined && !(isObj(st.patience) && typeof st.patience.kind === "string")) throw new Error(`${at}: patience must be a duration with a kind`);
    }
  }
  const outage = out.outages?.find((o) => !systems.has(o[0]));
  if (outage) throw new Error(`outage on unknown system ${outage[0]}`);
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

/** "12, 17.5" as sorted distinct hours of day; [] for an empty box, null when a value is not a number in [0, 24). */
export function parseHoursList(text: string): number[] | null {
  const hs = text.split(/[,;\s]+/).filter(Boolean).map(Number);
  return hs.every((h) => Number.isFinite(h) && h >= 0 && h < 24) ? [...new Set(hs)].sort((a, b) => a - b) : null;
}

/** "12, 5;40" as sorted distinct holiday day numbers; [] for an empty box, null when a value is not a whole number the API accepts. */
export function parseDayList(text: string): number[] | null {
  const ds = text.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (!ds.every((d) => Number.isInteger(d) && d >= 0 && d <= 36500)) return null;
  const out = [...new Set(ds)].sort((a, b) => a - b);
  return out.length <= 366 ? out : null;
}

/** An absence with its start or end set to a day and hour; an end that would not follow the start lands an hour after it. */
export function editAbsence([start, end]: Hours, part: "start" | "end", day: number, hour: number): Hours {
  const m = day * 1440 + hour * 60;
  if (part === "start") return [m, end > m ? end : m + 60];
  return [start, m > start ? m : start + 60];
}

const isNumOrDate = (x: string) => (x.trim() !== "" && Number.isFinite(Number(x))) || !Number.isNaN(Date.parse(x));
/** First cell of every non-empty CSV line (comma, semicolon or tab separated); a first row that is neither a number nor a date is a header and dropped. */
export function firstColumn(text: string): string[] {
  const cells = text.split(/\r?\n/).map((l) => l.split(/[,;\t]/)[0].trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  return cells.length && !isNumOrDate(cells[0]) ? cells.slice(1) : cells;
}

// Scenario JSON contract (src/flock_of_pain/io.py: OVERLAY_TYPES).
export type Overlay =
  | { type: "arrival_multiplier"; factor: number; workflow_id: string | null; start?: number; end?: number } // no start/end = whole run
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
export function scenarioRefs(scenarios: Scenario[]): { departments: Set<string>; systems: Set<string>; resources: Set<string>; workflows: Set<string> } {
  const refs = scenarios.flatMap((s) => s.overlays).map((o) => {
    const f = ID_FIELD.get(o.type);
    return { f, id: f && (o as Record<string, unknown>)[f] };
  });
  const ids = (...fields: IdField[]) => new Set(refs.flatMap(({ f, id }) => (f && fields.includes(f) && typeof id === "string" ? [id] : [])));
  return { departments: ids("department_id"), systems: ids("system_id"), resources: ids("resource_id", "pool_id"), workflows: ids("workflow_id") };
}

/** Everyone the company employs: pool headcount counts the carved members already. */
export function headcount(c: Company): number {
  return c.departments.flatMap((d) => d.resources).reduce((n, r) => n + (r.headcount !== undefined ? r.headcount : r.pool_id ? 0 : 1), 0);
}

/** Days the API simulates and budgets: the warm-up runs in addition to the measured days, in every replication of every scenario. */
export const runDays = (c: { days: number; warmup_days?: number; replications: number }, scenarios: number) => (c.days + (c.warmup_days ?? 0)) * c.replications * scenarios;
