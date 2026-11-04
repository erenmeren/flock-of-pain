// Assert-based checks for the pure Company/Scenario edits: `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { membersOf, movePerson, removeDepartment, removeResource, setResource } from "@/components/org/ops";
import { deptColumns, handoffs, healthScores, mapEdges, minutes, workflowMeans } from "@/components/dashboard/derive";
import { addInflow, addStep, blockingIssue, channelLabels, connect, disconnect, freshName, inflowsOf, newWorkflow, rateOf, removeNode, renameStep, stepIssues, toInflows, wouldCycle } from "@/components/process/graph";
import { autoLayout, fillLayout } from "@/components/process/layout";
import { type Company, type Scenario, type Workflow, checkCompany, checkScenarios, headcount, idFor, renameDepartment, renameInScenarios, renameSystem, scenarioRefs, slug } from "@/lib/company";
import type { SimEvent } from "@/lib/api";
import { snapshot } from "@/lib/playback";

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
// steps without depends_on run in parallel: the arrival enters a and b, no hand-off
assert.equal(handoffs(wf), 0);
const edgeKeys = (w: Workflow, extra: Partial<Company> = {}) => mapEdges({ ...c, systems: [{ id: "erp", name: "ERP" }], workflows: [w], ...extra }).map((e) => `${e.from}>${e.to}:${e.n}`);
assert.deepEqual(edgeKeys(wf), ["w:w>d:a:1", "w:w>d:b:1", "d:a>s:erp:1"]);
const chain = { ...wf, steps: wf.steps.map((s, i) => (i ? { ...s, depends_on: [wf.steps[i - 1].id] } : s)) };
assert.equal(handoffs(chain), 2);
assert.deepEqual(edgeKeys(chain), ["w:w>d:a:1", "d:a>d:b:1", "d:b>d:a:1", "d:a>s:erp:1"]);
{ // "Ship" created before "Take order", wired inflow -> Take order -> Ship: work enters sales and hands off to warehouse
  const ship = { ...step("ship", "warehouse"), depends_on: ["take"] }, take = step("take", "sales");
  const w: Workflow = { id: "o", name: "o", steps: [ship, take], inflows: [{ id: "in", name: "in", rate_per_hour: 1, window: sched, entry: ["take"] }] };
  const depts = { departments: [{ id: "warehouse", name: "W", resources: [] }, { id: "sales", name: "S", resources: [] }] };
  assert.deepEqual(edgeKeys(w, depts), ["w:o>d:sales:1", "d:sales>d:warehouse:1"]);
  assert.deepEqual(deptColumns({ ...c, ...depts, workflows: [w] }), [["sales"], ["warehouse"]]);
  // A(sales) -> B(ops) and A -> C(sales): one hand-off, not two
  const fan = { ...wf, steps: [step("A", "sales"), { ...step("B", "ops"), depends_on: ["A"] }, { ...step("C", "sales"), depends_on: ["A"] }] };
  assert.equal(handoffs(fan), 1);
}

// ids derive from names (idFor) and survive Turkish letters (slug)
assert.equal(slug("Müşteri Hizmetleri / Işık"), "musteri_hizmetleri_isik");
assert.equal(idFor("Finance", ["cs"], "dept"), "finance");
assert.equal(idFor("Finance", ["finance", "finance_2"], "dept"), "finance_3");
assert.equal(idFor("Finance", ["finance"], "dept", "finance"), "finance"); // own id stays
assert.equal(idFor("", ["emp"], "emp"), "emp_2"); // no letters: base

// arrival form reads as one implicit inflow and converts without touching the original
const imp = inflowsOf(wf);
assert.equal(imp.length, 1); assert.equal(imp[0].id, "inflow"); assert.equal(imp[0].name, "Arrival"); assert.deepEqual(imp[0].entry, ["1", "2", "3", "4"]);
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
const rw = renameStep({ ...cw, steps: [wf.steps[0], { ...wf.steps[1], rework_to: "1" }], layout: { ...cw.layout, "1": [5, 5] } }, "1", "one");
assert.deepEqual(rw.layout!.one, [5, 5]); assert.equal(rw.layout!["1"], undefined); assert.equal(rw.steps[1].rework_to, "one");
const dc = disconnect({ ...cw, steps: [wf.steps[0], { ...wf.steps[1], depends_on: ["1"], rework_to: "1" }] }, "1", "2");
assert.deepEqual(dc.steps[1].depends_on, []); assert.equal(dc.steps[1].rework_to, null);
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
assert.equal(blockingIssue({ ...c, workflows: [{ id: "e", name: "E", arrival: wf.arrival, steps: [] }] }), null);

// checkCompany keeps every half-finished draft the canvas can produce
checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [bare], inflows: [{ id: "i", name: "i", rate_per_hour: 1, window: sched, entry: [] }], layout: { ghost: [1, 2] } }] });
checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [] }] });
assert.throws(() => checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [], inflows: [{ id: 3 }] }] }));
assert.throws(() => checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [], inflows: [{ id: "i", name: "i", entry: [] }] }] }));
assert.throws(() => checkCompany({ ...c, workflows: [{ id: "d", name: "d", steps: [], layout: { a: 1 } }] }));
const nw = newWorkflow("Customer order", ["order"]);
assert.equal(nw.id, "customer_order"); assert.equal(nw.arrival, undefined); assert.equal(nw.inflows!.length, 1); assert.deepEqual(nw.inflows![0].entry, []); assert.equal(nw.steps.length, 0);

// palette drops get distinct names; channelLabels mirrors expand_inflows ids
{
  assert.equal(freshName("New inflow", ["New inflow", "New inflow 2"]), "New inflow 3");
  const w0 = newWorkflow("W", []);
  const w1 = addInflow(w0, [0, 0]).wf;
  const w2 = addInflow(w1, [0, 0]).wf;
  assert.deepEqual(w2.inflows!.map((i) => [i.id, i.name]), [["new_inflow", "New inflow"], ["new_inflow_2", "New inflow 2"], ["new_inflow_3", "New inflow 3"]]);
  const s2 = addStep(addStep(w0, null, [0, 0]).wf, null, [0, 0]).wf;
  assert.deepEqual(s2.steps.map((s) => s.name), ["New step", "New step 2"]);
  const single: Workflow = { id: "a", name: "A", arrival: { rate_per_hour: 1, window: sched }, steps: [] };
  assert.deepEqual(channelLabels({ ...c, workflows: [single, w2] }), { a: "A", "w.new_inflow": "W · New inflow", "w.new_inflow_2": "W · New inflow 2", "w.new_inflow_3": "W · New inflow 3" });
}

// workflowMeans averages per-workflow metrics over replications
{
  const m = (completed: number) => ({ started: 4, completed, cancelled: 0, throughput_per_day: completed, cycle_p50: 10, cycle_p90: 20, wait_p50: 0, wait_p90: 0, sla_breached: 0, sla_breach_rate: 0, steps_completed: 0, failures: 0, rework_rate: 0, cost_per_completed: 0 });
  const s = { id: "s", name: "s", summary: {}, ledger: [], off_shift_minutes: 0, runs: [{ seed: 1, metrics: { workflows: { a: m(2) } } }, { seed: 2, metrics: { workflows: { a: m(4) } } }] };
  assert.equal(workflowMeans(s).a.completed, 3);
  assert.equal(workflowMeans(s).a.cycle_p50, 10);
}

// departments fall into hand-off columns in flow order; a back edge does not push a column; untouched departments come last
{
  const step = (id: string, department_id: string): Workflow["steps"][number] => ({ id, name: id, department_id, required_skill: "s", duration: { kind: "lognormal_mean", mean: 5, sigma: 0.3 } });
  const dep = (id: string) => ({ id, name: id.toUpperCase(), resources: [] });
  const flow = (id: string, ds: string[]) => ({ id, name: id, arrival: { rate_per_hour: 1, window: sched }, steps: ds.map((d, i) => ({ ...step(`${id}${i}`, d), depends_on: i ? [`${id}${i - 1}`] : [] })) });
  const co: Company = { id: "f", name: "f", systems: [], departments: ["e", "d", "c", "b", "a"].map(dep),
    workflows: [flow("w1", ["a", "b", "c"]), flow("w2", ["b", "d", "b"])] };
  assert.deepEqual(deptColumns(co), [["a"], ["b"], ["c", "d"], ["e"]]);
  assert.deepEqual(deptColumns({ ...co, workflows: [] }), [["e", "d", "c", "b", "a"]]);
  // a step pointing at a department that does not exist is left out instead of crashing the map
  assert.deepEqual(deptColumns({ ...co, workflows: [flow("w3", ["ghost", "a"])] }), [["a"], ["e", "d", "c", "b"]]);
}

// checkCompany rejects what the editor cannot render or the API would refuse
{
  const okc = { ...c, systems: [{ id: "erp", name: "ERP" }], workflows: [chain] };
  checkCompany(okc);
  checkCompany(JSON.parse(readFileSync(new URL("../../src/flock_of_pain/examples/reynolds.json", import.meta.url), "utf8")));
  const ghost = (patch: object) => ({ ...okc, workflows: [{ ...chain, steps: [{ ...chain.steps[0], ...patch }, ...chain.steps.slice(1)] }] });
  assert.throws(() => checkCompany(ghost({ department_id: "ghost" })), /unknown department ghost/);
  assert.throws(() => checkCompany(ghost({ system_id: "ghost" })), /unknown system ghost/);
  assert.throws(() => checkCompany(ghost({ depends_on: ["ghost"] })), /unknown step ghost/);
  assert.throws(() => checkCompany({ ...okc, outages: [["ghost", 0, 1]] }), /unknown system ghost/);
  assert.throws(() => checkCompany({ ...okc, id: undefined }), /id/);
  assert.throws(() => checkCompany({ ...okc, id: "" }), /id/);
  assert.throws(() => checkCompany({ ...okc, name: undefined }), /name/);
}

// scenarioRefs: an arrival_multiplier pins its workflow; null (all workflows) pins none
{
  const r = scenarioRefs([{ id: "s", name: "s", overlays: [...sc[0].overlays, { type: "arrival_multiplier", factor: 2, workflow_id: "w" }] }]);
  assert.deepEqual([...r.workflows], ["w"]);
  assert.deepEqual([...r.departments], ["pool"]); assert.deepEqual([...r.resources].sort(), ["pool"]);
}

// renames follow every step / outage reference; removing a department keeps headcount consistent
{
  const co: Company = { ...c, systems: [{ id: "erp", name: "ERP" }], workflows: [chain], outages: [["erp", 0, 1]] };
  const rd = renameDepartment(co, "a", "z");
  assert.deepEqual(rd.workflows[0].steps.map((s) => s.department_id), ["z", "z", "b", "z"]);
  const rs = renameSystem(co, "erp", "crm");
  assert.equal(rs.workflows[0].steps[1].system_id, "crm"); assert.deepEqual(rs.outages, [["crm", 0, 1]]);
  // pool lives in another department than its member: removing the member's department shrinks the pool by one
  const split: Company = { ...c, departments: [c.departments[0], { id: "b", name: "B", resources: [{ ...m1, id: "m2" }] }] };
  assert.equal(membersOf(split, "pool"), 2);
  const rmB = removeDepartment(split, 1);
  assert.equal(pool(rmB), 4); assert.equal(rmB.departments.length, 1);
  // removing the pool's department leaves members elsewhere standalone with the pool's schedule
  const rmA = removeDepartment(split, 0);
  assert.equal(rmA.departments[0].resources[0].pool_id, undefined); assert.deepEqual(rmA.departments[0].resources[0].schedule, sched);
}

// auto layout on a draft cycle terminates and still places every node
{
  const cyc: Workflow = { id: "y", name: "y", steps: [{ ...step("p", "a"), depends_on: ["q"] }, { ...step("q", "a"), depends_on: ["p"] }],
    inflows: [{ id: "in", name: "in", rate_per_hour: 1, window: sched, entry: ["p"] }] };
  const L = autoLayout(cyc);
  assert.deepEqual(Object.keys(L).sort(), ["in", "p", "q"]);
}

// playback snapshot folds events up to t
{
  const ev = (t: number, kind: string, x: Partial<SimEvent> = {}): SimEvent => ({ t, kind, task_id: "k", instance_id: null, workflow_id: null, step_id: "s", department_id: "a", resource_id: null, system_id: null, reason: null, payload: {}, ...x });
  const log = [
    ev(0, "TASK_QUEUED", { reason: "no_resource" }),
    ev(5, "TASK_QUEUED", { reason: "shift" }), // re-tag: wait started at 0
    ev(10, "TASK_STARTED", { resource_id: "r1" }),
    ev(20, "TASK_BLOCKED", { reason: "system_down", resource_id: null }), // keeps r1
    ev(30, "TASK_UNBLOCKED"), // re-queue: no resource
    ev(40, "SYSTEM_OUTAGE_STARTED", { task_id: null, system_id: "erp" }),
    ev(50, "SYSTEM_OUTAGE_ENDED", { task_id: null, system_id: "erp" }),
    ev(60, "TASK_COMPLETED"),
  ];
  const at = (t: number) => snapshot(log, t);
  assert.equal(at(5).tasks[0].since, 0); assert.equal(at(5).tasks[0].reason, "shift");
  assert.equal(at(10).tasks[0].resource_id, "r1"); assert.equal(at(10).tasks[0].since, 10);
  assert.equal(at(20).tasks[0].state, "BLOCKED"); assert.equal(at(20).tasks[0].resource_id, "r1");
  assert.equal(at(30).tasks[0].resource_id, null); assert.equal(at(30).tasks[0].state, "QUEUED");
  assert.deepEqual(at(45).outages, ["erp"]); assert.deepEqual(at(50).outages, []);
  assert.equal(at(9).tasks[0].state, "QUEUED"); // stops before the t=10 start
  assert.deepEqual(at(9).perDept, { a: { QUEUED: 1, IN_PROGRESS: 0, BLOCKED: 0 } });
  assert.equal(at(60).tasks.length, 0);
}

console.log("ok");

