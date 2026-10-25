// Assert-based checks for the pure Company/Scenario edits: `npm test`.
import assert from "node:assert/strict";
import { membersOf, movePerson, removeResource, setResource } from "@/components/org/ops";
import { type Company, type Scenario, checkScenarios, headcount, renameInScenarios } from "@/lib/company";

const sched = { weekday_hours: { "0": [9, 17] as [number, number] } };
const c: Company = { id: "x", name: "x", systems: [], workflows: [], departments: [
  { id: "a", name: "A", resources: [
    { id: "pool", skills: ["s"], cost_per_hour: 1, schedule: sched, headcount: 5 },
    { id: "m1", skills: ["s"], cost_per_hour: 1, schedule: null, pool_id: "pool" },
    { id: "solo", skills: ["s"], cost_per_hour: 1, schedule: sched },
  ] },
  { id: "b", name: "B", resources: [] },
] };
const pool = (x: Company) => x.departments[0].resources[0].headcount;
const [, m1, solo] = c.departments[0].resources;
assert.equal(headcount(c), 6);

// join / leave / move keep total headcount and move the pool by one
const joined = setResource(c, { di: 0, ri: 2 }, { ...solo, pool_id: "pool", schedule: null });
assert.equal(pool(joined), 6); assert.equal(headcount(joined), 6);
const left = setResource(c, { di: 0, ri: 1 }, { ...m1, pool_id: undefined, schedule: sched });
assert.equal(pool(left), 4); assert.equal(headcount(left), 6);
const moved = movePerson(c, { di: 0, ri: 1 }, 1);
assert.equal(pool(moved), 4); assert.equal(headcount(moved), 6);
assert.deepEqual(moved.departments[1].resources[0].schedule, sched);

// removing a pool leaves its members standalone with the pool's schedule
const noPool = removeResource(c, { di: 0, ri: 0 });
assert.equal(noPool.departments[0].resources[0].pool_id, undefined);
assert.deepEqual(noPool.departments[0].resources[0].schedule, sched);

// empty id is rejected (and members keep their pool)
const empty = setResource(c, { di: 0, ri: 0 }, { ...c.departments[0].resources[0], id: "" });
assert.equal(empty.departments[0].resources[0].id, "pool");
assert.equal(membersOf(empty, "pool"), 1);

// renameInScenarios touches only the named field
const sc: Scenario[] = [{ id: "s", name: "s", overlays: [
  { type: "set_pool_headcount", pool_id: "pool", headcount: 3 },
  { type: "absence", resource_id: "pool", start: 0, end: 1 },
  { type: "add_employee", department_id: "pool", employee: { id: "e", skills: [], cost_per_hour: 1, schedule: null } },
  { type: "arrival_multiplier", factor: 2, workflow_id: null },
] }];
const [o0, o1, o2, o3] = sc[0].overlays;
const byPool = renameInScenarios(sc, "pool_id", "pool", "p2")[0].overlays;
assert.deepEqual(byPool, [{ ...o0, pool_id: "p2" }, o1, o2, o3]);
const byRes = renameInScenarios(sc, "resource_id", "pool", "p2")[0].overlays;
assert.deepEqual(byRes, [o0, { ...o1, resource_id: "p2" }, o2, o3]);
const byDept = renameInScenarios(sc, "department_id", "pool", "p2")[0].overlays;
assert.deepEqual(byDept, [o0, o1, { ...o2, department_id: "p2" }, o3]);

// checkScenarios rejects add_employee without an employee
assert.throws(() => checkScenarios([{ id: "s", name: "s", overlays: [{ type: "add_employee", department_id: "a" }] }]));
assert.throws(() => checkScenarios([{ id: "s", name: "s", overlays: [{ type: "absence", resource_id: 3 }] }]));
assert.equal(checkScenarios(sc), sc);

console.log("ok");
