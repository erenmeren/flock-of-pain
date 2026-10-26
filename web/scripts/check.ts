// Assert-based checks for the pure Company/Scenario edits: `npm test`.
import assert from "node:assert/strict";
import { membersOf, movePerson, removeResource, setResource } from "@/components/org/ops";
import { handoffs, healthScores, mapEdges, minutes } from "@/components/dashboard/derive";
import { addStep, blockingIssue, connect, inflowsOf, rateOf, removeNode, renameStep, stepIssues, toInflows, wouldCycle } from "@/components/process/graph";
import { autoLayout, fillLayout } from "@/components/process/layout";
import { type Company, type Scenario, type Workflow, checkCompany, checkScenarios, headcount, idFor, renameInScenarios, slug } from "@/lib/company";

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


// overview derived numbers
const stat = (mean: number) => ({ mean, p10: mean, p50: mean, p90: mean });
const h = healthScores({ completion_rate: stat(1), sla_breach_rate: stat(0), rework_rate: stat(0), mean_dept_utilization: stat(0.75) })!;
assert.equal(h.total, 100); assert.equal(h.label, "Healthy");
assert.equal(healthScores({ completion_rate: stat(0.5), sla_breach_rate: stat(0.5), rework_rate: stat(0.5), mean_dept_utilization: stat(0.35) })!.total, 38);
assert.equal(healthScores({ completion_rate: stat(1) }), null); // partial summary (old saved run) scores nothing
assert.equal(minutes(95), "95 min"); assert.equal(minutes(135), "2.3 h"); assert.equal(minutes(null), "–");
const step = (id: string, department_id: string, system_id?: string) => ({ id, name: id, department_id, required_skill: "s", duration: { kind: "const", a: 1 }, system_id });
const wf = { id: "w", name: "w", arrival: { rate_per_hour: 1, window: sched }, steps: [step("1", "a"), step("2", "a", "erp"), step("3", "b"), step("4", "a")] };
assert.equal(handoffs(wf), 2);
const edges = mapEdges({ ...c, systems: [{ id: "erp", name: "ERP" }], workflows: [wf] });
assert.deepEqual(edges.map((e) => `${e.from}>${e.to}:${e.n}`), ["w:w>d:a:1", "d:a>d:b:1", "d:b>d:a:1", "d:a>s:erp:1"]);

// ids derive from names (idFor) and survive Turkish letters (slug)
assert.equal(slug("Müşteri Hizmetleri / Işık"), "musteri_hizmetleri_isik");
assert.equal(idFor("Finance", ["cs"], "dept"), "finance");
assert.equal(idFor("Finance", ["finance", "finance_2"], "dept"), "finance_3");
assert.equal(idFor("Finance", ["finance"], "dept", "finance"), "finance"); // own id stays
assert.equal(idFor("", ["emp"], "emp"), "emp_2"); // no letters: base

// arrival form reads as one implicit inflow and converts without touching the original
const imp = inflowsOf(wf);
assert.equal(imp.length, 1); assert.equal(imp[0].id, "inflow"); assert.deepEqual(imp[0].entry, ["1", "2", "3", "4"]);
assert.equal(rateOf(wf), 1);
const conv = toInflows(wf);
assert.equal(conv.arrival, undefined); assert.equal(conv.inflows!.length, 1); assert.equal(toInflows(conv), conv); assert.equal(wf.arrival.rate_per_hour, 1);

// edges, cycles, duplicates
const cw: Workflow = { id: "w", name: "W", steps: wf.steps, inflows: [{ id: "phone", name: "Phone", rate_per_hour: 3, window: sched, entry: ["1"] }], layout: { phone: [0, 0] } };
const c1 = connect(cw, "1", "2")!;
assert.deepEqual(c1.steps[1].depends_on, ["1"]);
assert.equal(connect(c1, "1", "2"), c1);
assert.equal(wouldCycle(c1, "2", "1"), true); assert.equal(connect(c1, "2", "1"), null);
const c2 = connect(c1, "phone", "2")!;
assert.deepEqual(c2.inflows![0].entry, ["1", "2"]); assert.equal(connect(c2, "phone", "2"), c2);

// rename and remove follow every reference
const ren = renameStep(c2, "1", "one");
assert.equal(ren.steps[0].id, "one"); assert.deepEqual(ren.steps[1].depends_on, ["one"]); assert.deepEqual(ren.inflows![0].entry, ["one", "2"]);
const gone = removeNode({ ...c2, layout: { ...c2.layout, "1": [5, 5] } }, "1");
assert.equal(gone.steps.length, 3); assert.deepEqual(gone.steps[0].depends_on, []); assert.deepEqual(gone.inflows![0].entry, ["2"]); assert.equal(gone.layout!["1"], undefined);
assert.equal(removeNode(c2, "phone").inflows!.length, 0);

// new step from a department chip: one distinct skill is prefilled
const { wf: withStep, id: newId } = addStep(c2, c.departments[0], [10, 20]);
assert.equal(newId, "new_step"); assert.equal(withStep.steps[4].required_skill, "s"); assert.deepEqual(withStep.layout!.new_step, [10, 20]);
assert.equal(addStep(c2, null, [0, 0]).wf.steps[4].department_id, "");

// auto layout: inflow col 0, 1 col 1, 2 col 2, unreachable 3 and 4 after the last column
const L = autoLayout(c1);
assert.deepEqual([L.phone, L["1"], L["2"], L["3"], L["4"]], [[0, 0], [256, 0], [512, 0], [768, 0], [768, 112]]);
assert.deepEqual(fillLayout(c1).phone, [0, 0]); assert.deepEqual(fillLayout(c1)["2"], [512, 0]);

// issues and the pre-run check
const bare = { ...step("x", ""), required_skill: "" };
assert.deepEqual(stepIssues(c, c1, bare, new Set()).map((i) => `${i.blocking ? "!" : ""}${i.text}`), ["!Who does this?", "!What skill is needed?", "Not connected to an inflow"]);
assert.deepEqual(stepIssues(c, c1, step("3", "b")).map((i) => i.text), ["Nobody in B has `s`", "Not connected to an inflow"]);
assert.equal(blockingIssue({ ...c, workflows: [c1] }), null);
assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, steps: [bare, ...c1.steps] }] })!.message, "Fix `x` on the W canvas: who does this?");
assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, inflows: [] }] })!.message, "W has no inflow");
assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, inflows: [{ ...c1.inflows![0], entry: [] }] }] })!.workflowId, "w");

// checkCompany keeps every half-finished draft the canvas can produce
checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [bare], inflows: [{ id: "i", name: "i", rate_per_hour: 1, window: sched, entry: [] }], layout: { ghost: [1, 2] } }] });
checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [] }] });
assert.throws(() => checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [], inflows: [{ id: 3 }] }] }));
console.log("ok");
