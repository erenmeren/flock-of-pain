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
export type Company = {
  id: string;
  name: string;
  systems: System[];
  departments: Department[];
  workflows: unknown[];
  outages?: unknown[];
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const weekdays9to5 = (): Schedule => ({
  weekday_hours: Object.fromEntries([0, 1, 2, 3, 4].map((d) => [String(d), [9, 17]])),
});

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function parseCompany(text: string): Company {
  const c = JSON.parse(text);
  if (!c || typeof c !== "object" || !Array.isArray(c.departments)) throw new Error("expected a company object with departments");
  return { systems: [], workflows: [], ...c };
}
