// Pure Company edits shared by the organization pages; every one returns a new Company.
import { type Company, type Department, type Resource, headcount, weekdays9to5 } from "@/lib/company";

export const isPool = (r: Resource) => r.headcount !== undefined;
export const allResources = (c: Company) => c.departments.flatMap((d) => d.resources);
export const membersOf = (c: Company, poolId: string) => allResources(c).filter((r) => !isPool(r) && r.pool_id === poolId).length;
export const deptHeadcount = (c: Company, d: Department) => headcount({ ...c, departments: [d] });
export const stepsIn = (c: Company) => c.workflows.flatMap((w) => w.steps);
export const parseSkills = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Located resource: department index + resource index, so duplicate ids in loaded JSON still edit the right row. */
export type Loc = { di: number; ri: number };

const mapRes = (c: Company, f: (r: Resource, di: number, ri: number) => Resource): Company =>
  ({ ...c, departments: c.departments.map((d, di) => ({ ...d, resources: d.resources.map((r, ri) => f(r, di, ri)) })) });

/** Pool headcount moves by delta but never below its named members (they are carved out of it). */
function adjustPool(c: Company, poolId: string | undefined, delta: number): Company {
  if (!poolId) return c;
  const floor = membersOf(c, poolId);
  return mapRes(c, (r) => (isPool(r) && r.id === poolId ? { ...r, headcount: Math.max(floor, (r.headcount ?? 0) + delta) } : r));
}

const idTaken = (c: Company, id: string, self: Resource) => allResources(c).some((x) => x !== self && x.id === id);

/** Replace one resource; keeps ids unique, makes pool members follow a pool rename, and moves headcount with membership. */
export function setResource(c: Company, { di, ri }: Loc, next: Resource): Company {
  const old = c.departments[di].resources[ri];
  if (next.id !== old.id && (!next.id || idTaken(c, next.id, old))) next = { ...next, id: old.id }; // empty or duplicate id ignored
  let out = mapRes(c, (r, i, j) => (i === di && j === ri ? next : r));
  if (isPool(old) && next.id !== old.id) out = mapRes(out, (r) => (!isPool(r) && r.pool_id === old.id ? { ...r, pool_id: next.id } : r));
  if (!isPool(old) && old.pool_id !== next.pool_id) out = adjustPool(adjustPool(out, old.pool_id, -1), next.pool_id, +1);
  return out;
}

/** Members of the given pools stand alone with the pool's schedule (as the old editor did). */
function orphan(c: Company, pools: Resource[]): Company {
  const byId = new Map(pools.map((p) => [p.id, p]));
  return mapRes(c, (r) => {
    const p = !isPool(r) && r.pool_id ? byId.get(r.pool_id) : undefined;
    return p ? { ...r, pool_id: undefined, schedule: r.schedule ?? p.schedule ?? weekdays9to5() } : r;
  });
}

export function removeResource(c: Company, { di, ri }: Loc): Company {
  const gone = c.departments[di].resources[ri];
  let out: Company = { ...c, departments: c.departments.map((d, i) => (i === di ? { ...d, resources: d.resources.filter((_, j) => j !== ri) } : d)) };
  out = isPool(gone) ? orphan(out, [gone]) : adjustPool(out, gone.pool_id, -1);
  return out;
}

export function removeDepartment(c: Company, di: number): Company {
  const pools = c.departments[di].resources.filter(isPool);
  let out: Company = { ...c, departments: c.departments.filter((_, i) => i !== di) };
  for (const r of c.departments[di].resources) if (!isPool(r) && r.pool_id && !pools.some((p) => p.id === r.pool_id)) out = adjustPool(out, r.pool_id, -1);
  return orphan(out, pools);
}

/** Move a person to another department: leaves its pool (schedule falls back to the pool's) and stands alone. */
export function movePerson(c: Company, { di, ri }: Loc, toDi: number): Company {
  if (toDi === di) return c;
  const r = c.departments[di].resources[ri];
  const pool = r.pool_id ? allResources(c).find((x) => isPool(x) && x.id === r.pool_id) : undefined;
  const moved: Resource = { ...r, pool_id: undefined, schedule: r.schedule ?? pool?.schedule ?? weekdays9to5() };
  const out = removeResource(c, { di, ri });
  return { ...out, departments: out.departments.map((d, i) => (i === toDi ? { ...d, resources: [...d.resources, moved] } : d)) };
}

export function addResource(c: Company, di: number, r: Resource): Company {
  return { ...c, departments: c.departments.map((d, i) => (i === di ? { ...d, resources: [...d.resources, r] } : d)) };
}
