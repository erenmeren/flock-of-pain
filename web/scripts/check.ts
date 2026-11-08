// Assert-based checks for the pure Company/Scenario edits: `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { membersOf, movePerson, removeDepartment, removeResource, setResource } from "@/components/org/ops";
import { deptColumns, handoffs, healthScores, mapEdges, minutes, workflowMeans } from "@/components/dashboard/derive";
import { addInflow, addStep, blockingIssue, channelLabels, connect, disconnect, freshName, inflowsOf, newWorkflow, rateOf, removeNode, renameStep, setBranch, stepIssues, toInflows, unskilled, wouldCycle } from "@/components/process/graph";

import { autoLayout, fillLayout } from "@/components/process/layout";
import { type Company, type Scenario, type Schedule, type Workflow, checkCompany, checkScenarios, editAbsence, headcount, idFor, mergeWindows, orderWindows, renameDepartment, renameInScenarios, renameSystem, sameEveryDay, scenarioRefs, setDayHours, setMultiplier, slug, splitAt, windowsOf, firstColumn, parseDayList, parseHoursList, runDays, weekdays9to5 } from "@/lib/company";
import type { SimEvent } from "@/lib/api";
import { snapshot } from "@/lib/playback";
import { addScenario, budgetIssue, demandSweep, firstResource, jobConfig, parsePercents, staffSweep, sweepRows } from "@/lib/sweep";
import { csvText, realityRows, resultsCsv, setActual, topWaits } from "@/lib/results";
import { applyPeople, importedRows, parseDays, parsePeopleCsv, parseTable } from "@/lib/people-csv";
import { COALESCE_MS, HISTORY_CAP, emptyHistory, record, redo, shouldAutosave, undo, undoKey } from "@/lib/history";

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
  const m = (completed: number) => ({ started: 4, completed, cancelled: 0, throughput_per_day: completed, cycle_p50: 10, cycle_p90: 20, wait_p50: 0, wait_p90: 0, sla_breached: 0, sla_breach_rate: 0, deadline_missed: 0, deadline_miss_rate: 0, steps_completed: 0, failures: 0, rework_rate: 0, cost_per_completed: 0 });
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

// office-floor model: split shifts, demand profiles, cut-off, branches, wait steps
{
  // windowsOf reads a bare pair or a list of pairs
  assert.deepEqual(windowsOf([9, 17]), [[9, 17]]);
  assert.deepEqual(windowsOf([[9, 13], [14, 17]]), [[9, 13], [14, 17]]);
  assert.deepEqual(windowsOf([]), []);
  // splitAt cuts a one-hour break at `hour` in every day; mergeWindows undoes it as a bare pair
  const two = { weekday_hours: { "0": [9, 17] as [number, number], "1": [9, 17] as [number, number] }, absences: [[0, 1] as [number, number]] };
  const split = splitAt(two, 13);
  assert.deepEqual(split.weekday_hours, { "0": [[9, 13], [14, 17]], "1": [[9, 13], [14, 17]] });
  assert.deepEqual(split.absences, two.absences);
  assert.deepEqual(mergeWindows(split), two);
  assert.deepEqual(splitAt({ weekday_hours: { "0": [9, 10] } }, 13).weekday_hours, { "0": [9, 10] }); // no room for a break: unchanged
  assert.deepEqual(mergeWindows(two), two);
  // setMultiplier keeps only values that differ from 1 and drops an empty profile
  const p1 = setMultiplier(undefined, "hours", "9", 2);
  assert.deepEqual(p1, { hours: { "9": 2 } });
  assert.deepEqual(setMultiplier(p1, "weekdays", "4", 0.5), { hours: { "9": 2 }, weekdays: { "4": 0.5 } });
  assert.equal(setMultiplier(p1, "hours", "9", 1), undefined);

  // checkCompany: the new shapes load, the broken ones are rejected
  const wait = { ...step("w", "a"), required_skill: null, depends_on: ["1"] };
  const okc: Company = { ...c, systems: [{ id: "erp", name: "ERP" }], workflows: [{ ...chain, cutoff_hour: 22,
    arrival: { ...chain.arrival, profile: { hours: { "9": 0.5 }, weekdays: { "0": 1.3 } }, window: { weekday_hours: { "0": [[9, 13], [14, 17]] } } },
    steps: [{ ...chain.steps[0], branches: [{ to: "2", prob: 0.15 }] }, ...chain.steps.slice(1), wait] }] };
  checkCompany(okc);
  const wf0 = okc.workflows[0];
  const bad = (w: object) => () => checkCompany({ ...okc, workflows: [{ ...wf0, ...w }] });
  assert.throws(bad({ steps: [{ ...wf0.steps[0], branches: [{ to: "ghost", prob: 0.1 }] }, ...wf0.steps.slice(1)] }), /branch to unknown step ghost/);
  assert.throws(bad({ steps: [...wf0.steps.slice(0, 4), { ...wait, system_id: "erp" }] }), /wait step.*system/);
  assert.throws(bad({ cutoff_hour: 24 }), /cutoff_hour/);
  assert.throws(bad({ cutoff_hour: -1 }), /cutoff_hour/);
  assert.throws(bad({ arrival: { ...wf0.arrival, profile: { hours: { "9": "x" } } } }), /profile/);
  assert.throws(() => checkCompany({ ...okc, workflows: [{ ...wf0, arrival: undefined, inflows: [{ id: "i", name: "i", rate_per_hour: 1, window: sched, entry: [], profile: { weekdays: { "0": null } } }] }] }), /profile/);
  assert.throws(() => checkCompany({ ...c, departments: [{ id: "a", name: "A", resources: [{ id: "r", skills: [], cost_per_hour: 1, schedule: { weekday_hours: { "0": [[9, 13], 14] } } }] }] }), /weekday_hours/);

  // a wait step needs no skill: no issue, not unskilled, run not blocked; hand-offs and map edges as with a worked step
  assert.deepEqual(stepIssues(c, c1, { ...step("1", "a"), required_skill: null }).map((i) => i.text), []);
  assert.equal(unskilled(c, { ...step("1", "b"), required_skill: null }), false);
  assert.equal(blockingIssue({ ...c, workflows: [{ ...c1, steps: c1.steps.map((s) => ({ ...s, required_skill: null, system_id: null })) }] }), null);
  const waitChain = { ...chain, steps: chain.steps.map((s, i) => (i === 2 ? { ...s, required_skill: null } : s)) };
  assert.equal(handoffs(waitChain), handoffs(chain));
  assert.deepEqual(edgeKeys(waitChain), edgeKeys(chain));

  // setBranch: a percentage sets the target's probability, 0 or null removes it (= always runs)
  const b1 = setBranch(step("x", "a"), "y", 0.15);
  assert.deepEqual(b1.branches, [{ to: "y", prob: 0.15 }]);
  assert.deepEqual(setBranch(b1, "z", 0.05).branches, [{ to: "y", prob: 0.15 }, { to: "z", prob: 0.05 }]);
  assert.deepEqual(setBranch(b1, "y", 0.2).branches, [{ to: "y", prob: 0.2 }]);
  assert.equal(setBranch(b1, "y", null).branches, undefined);
  // branches follow renames, removals and a removed arrow
  const bw: Workflow = { ...c1, steps: [{ ...c1.steps[0], branches: [{ to: "2", prob: 0.3 }] }, ...c1.steps.slice(1)] };
  assert.deepEqual(renameStep(bw, "2", "two").steps[0].branches, [{ to: "two", prob: 0.3 }]);
  assert.equal(removeNode(bw, "2").steps[0].branches, undefined);
  assert.equal(disconnect(bw, "1", "2").steps[0].branches, undefined);
  assert.deepEqual(disconnect(bw, "phone", "1").steps[0].branches, [{ to: "2", prob: 0.3 }]);

  // windowed arrival multipliers pass the scenario check
  checkScenarios([{ id: "s", name: "s", overlays: [{ type: "arrival_multiplier", factor: 1.5, workflow_id: null, start: 480, end: 960 }] }]);
}

// office-floor model part 2: batch release, patience, overtime rate, CSV first column, BATCH_HOLD playback
{
  const withStep = (x: object) => ({ ...c, systems: [{ id: "erp", name: "ERP" }], workflows: [{ ...chain, steps: [{ ...chain.steps[0], ...x }, ...chain.steps.slice(1)] }] });
  checkCompany(withStep({ release_hours: [0, 12, 17.5], patience: { kind: "lognormal_mean", mean: 4, sigma: 0.6 } }));
  assert.throws(() => checkCompany(withStep({ release_hours: [24] })), /release_hours/);
  assert.throws(() => checkCompany(withStep({ release_hours: [-1] })), /release_hours/);
  assert.throws(() => checkCompany(withStep({ release_hours: ["12"] })), /release_hours/);
  assert.throws(() => checkCompany(withStep({ release_hours: 12 })), /release_hours/);
  assert.throws(() => checkCompany(withStep({ patience: 4 })), /patience/);
  assert.throws(() => checkCompany(withStep({ patience: { mean: 4 } })), /patience/);
  const withRes = (x: object) => ({ ...c, departments: [{ ...c.departments[0], resources: [{ ...c.departments[0].resources[2], ...x }] }] });
  checkCompany(withRes({ overtime_rate: 1 }));
  checkCompany(withRes({ overtime_rate: 1.5 }));
  assert.throws(() => checkCompany(withRes({ overtime_rate: 0.9 })), /overtime_rate/);
  assert.throws(() => checkCompany(withRes({ overtime_rate: "1.5" })), /overtime_rate/);

  // release hours box: sorted, distinct, [] when empty, null when out of range or not a number
  assert.deepEqual(parseHoursList("17, 12;12 9.5"), [9.5, 12, 17]);
  assert.deepEqual(parseHoursList("  "), []);
  assert.equal(parseHoursList("24"), null);
  assert.equal(parseHoursList("noon"), null);

  // firstColumn: any separator, header dropped only when it is neither a number nor a date
  assert.deepEqual(firstColumn("minutes;who\r\n4.5;ann\n\n 6 ,bob\n7\tcid\n"), ["4.5", "6", "7"]);
  assert.deepEqual(firstColumn("2026-10-06T09:14:00,x\n2026-10-06T10:00:00,y"), ["2026-10-06T09:14:00", "2026-10-06T10:00:00"]);
  assert.deepEqual(firstColumn("\"created_at\"\n\"2026-10-06 09:14\""), ["2026-10-06 09:14"]);
  assert.deepEqual(firstColumn("12\n13"), ["12", "13"]);
  assert.deepEqual(firstColumn(""), []);

  // a task held for a batch release is queued in playback
  const held = snapshot([{ t: 0, kind: "TASK_QUEUED", task_id: "k", instance_id: null, workflow_id: null, step_id: "s", department_id: "a", resource_id: null, system_id: null, reason: "BATCH_HOLD", payload: {} }], 5);
  assert.equal(held.tasks[0].state, "QUEUED"); assert.equal(held.tasks[0].reason, "BATCH_HOLD");
  assert.deepEqual(held.perDept, { a: { QUEUED: 1, IN_PROGRESS: 0, BLOCKED: 0 } });
}

{
  // undo history: edits within the window are one step, a gap starts a new one
  let h = emptyHistory<number>();
  h = record(h, 0, 1000);
  h = record(h, 1, 1000 + COALESCE_MS - 1);
  h = record(h, 2, 1000 + 2 * COALESCE_MS - 2);
  assert.deepEqual(h.past, [0]);
  h = record(h, 3, 1000 + 4 * COALESCE_MS);
  assert.deepEqual(h.past, [0, 3]);
  // undo then redo round-trips; an edit right after an undo is its own step and clears redo
  const u = undo(h, 4)!;
  assert.equal(u.state, 3); assert.deepEqual(u.history.future, [4]);
  const r = redo(u.history, 3)!;
  assert.equal(r.state, 4); assert.deepEqual(r.history.past, [0, 3]); assert.deepEqual(r.history.future, []);
  const edited = record(u.history, 3, 1000 + 4 * COALESCE_MS + 1);
  assert.deepEqual(edited.future, []); assert.deepEqual(edited.past, [0, 3]);
  assert.equal(undo(emptyHistory<number>(), 1), null);
  assert.equal(redo(emptyHistory<number>(), 1), null);
  // capped, oldest dropped
  let big = emptyHistory<number>();
  for (let i = 0; i < HISTORY_CAP + 10; i++) big = record(big, i, (i + 1) * 10 * COALESCE_MS);
  assert.equal(big.past.length, HISTORY_CAP); assert.equal(big.past[0], 10);

  const key = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => undoKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
  assert.equal(key("z", { ctrlKey: true }), "undo"); assert.equal(key("z", { metaKey: true }), "undo");
  assert.equal(key("Z", { ctrlKey: true, shiftKey: true }), "redo"); assert.equal(key("Z", { metaKey: true, shiftKey: true }), "redo");
  assert.equal(key("y", { ctrlKey: true }), "redo");
  assert.equal(key("y", { metaKey: true }), null); assert.equal(key("z"), null); assert.equal(key("z", { ctrlKey: true, altKey: true }), null);

  // autosave only for a saved draft with this id, a writer, and a real edit that has not just failed
  const ok = { companyId: "a", selected: "a", canWrite: true, sync: { rev: 2, saved: 1 }, failedRev: null, saving: false };
  assert.equal(shouldAutosave(ok), true);
  assert.equal(shouldAutosave({ ...ok, selected: "b" }), false); // the id changed through an edit
  assert.equal(shouldAutosave({ ...ok, selected: "" }), false);
  assert.equal(shouldAutosave({ ...ok, canWrite: false }), false);
  assert.equal(shouldAutosave({ ...ok, sync: { rev: 2, saved: 2 } }), false);
  assert.equal(shouldAutosave({ ...ok, sync: { rev: 0, saved: -1 } }), false); // restored dirty draft: nothing until an edit
  assert.equal(shouldAutosave({ ...ok, failedRev: 2 }), false);
  assert.equal(shouldAutosave({ ...ok, failedRev: 1 }), true);
  assert.equal(shouldAutosave({ ...ok, saving: true }), false);

  // run-days count the warm-up
  assert.equal(runDays({ days: 10, replications: 5 }, 2), 100);
  assert.equal(runDays({ days: 10, warmup_days: 0, replications: 5 }, 2), 100);
  assert.equal(runDays({ days: 10, warmup_days: 5, replications: 2 }, 3), 90);
}

{ // decision sweep: scenarios on top of the base overlays, new employee copied from the department's first resource
  const hours = { "0": [8, 12] as [number, number] };
  const co: Company = { id: "x", name: "x", systems: [], workflows: [], departments: [
    { id: "ops", name: "Ops", resources: [
      { id: "p", skills: ["s"], cost_per_hour: 20, schedule: { weekday_hours: hours, absences: [[0, 60]] }, headcount: 4, overtime_rate: 1.5 },
      { id: "m", skills: ["s"], cost_per_hour: 25, schedule: null, pool_id: "p" },
    ] },
    { id: "empty", name: "Empty", resources: [] },
  ] };
  const base: Scenario = { id: "b", name: "B", overlays: [{ type: "arrival_multiplier", factor: 2, workflow_id: null }] };
  const pts = staffSweep(co, base, "ops", 2);
  assert.deepEqual(pts.map((p) => [p.value, p.label]), [[1, "+1"], [2, "+2"]]);
  assert.equal(pts[1].scenario.overlays.length, 3);
  assert.deepEqual(pts[1].scenario.overlays[0], base.overlays[0]);
  const hire = pts[0].scenario.overlays[1];
  assert.ok(hire.type === "add_employee");
  assert.deepEqual(hire.employee, { id: "ops_sweep_1", name: "New hire 1", skills: ["s"], cost_per_hour: 20, speed_factor: 1, schedule: { weekday_hours: hours }, overtime_rate: 1.5 }); // a pool becomes one person, absences stay behind
  assert.equal(new Set(pts.map((p) => p.scenario.id)).size, 2);
  assert.ok(pts.every((p) => p.scenario.id !== base.id));
  assert.deepEqual(staffSweep(co, base, "empty", 2), []);
  assert.doesNotThrow(() => checkScenarios(pts.map((p) => p.scenario)));
  // a member inherits the pool's schedule; the base scenario's removals and additions decide who is first
  const noPool: Scenario = { id: "b", name: "B", overlays: [{ type: "remove_resource", resource_id: "p" }] };
  assert.equal(firstResource(co, noPool, "ops")?.id, "m");
  const fromMember = staffSweep(co, noPool, "ops", 1)[0].scenario.overlays[1];
  assert.ok(fromMember.type === "add_employee");
  assert.deepEqual(fromMember.employee.schedule, { weekday_hours: hours });
  assert.equal(fromMember.employee.cost_per_hour, 25);
  const added: Scenario = { id: "b", name: "B", overlays: [{ type: "add_employee", department_id: "empty", employee: { id: "ops_sweep_1", skills: ["t"], cost_per_hour: 1, schedule: null } }] };
  const onAdded = staffSweep({ ...co, departments: [co.departments[0], { id: "empty", name: "Empty", resources: [{ id: "ops_sweep_1", skills: ["t"], cost_per_hour: 1, schedule: sched }] }] }, added, "ops", 1)[0].scenario.overlays[1];
  assert.ok(onAdded.type === "add_employee");
  assert.equal(onAdded.employee.id, "ops_sweep_1_2"); // never an id the company or base already has

  assert.deepEqual(parsePercents("+10%, 20 -5%;20,0"), [-5, 10, 20]);
  assert.deepEqual(parsePercents("  "), []);
  assert.equal(parsePercents("-100"), null);
  assert.equal(parsePercents("ten"), null);
  const dem = demandSweep(base, [-5, 10], "w");
  assert.deepEqual(dem.map((p) => p.label), ["-5%", "+10%"]);
  assert.deepEqual(dem[1].scenario.overlays, [base.overlays[0], { type: "arrival_multiplier", factor: 1.1, workflow_id: "w" }]);
  assert.equal((demandSweep(base, [10], null)[0].scenario.overlays[1] as { workflow_id: unknown }).workflow_id, null);

  const cfg = { seed: 1, days: 10, replications: 5, policy: "fifo", crn: false, include_events: true, save: true };
  assert.deepEqual(JSON.parse(JSON.stringify(jobConfig({ ...cfg, warmup_days: 2 }))), { seed: 1, days: 10, warmup_days: 2, replications: 5, policy: "fifo", crn: true }); // no store-only flags: the API refuses unknown keys
  assert.equal(budgetIssue(cfg, 40), null); // exactly 2000 run-days fits
  assert.match(budgetIssue(cfg, 41)!, /run-days/);
  assert.match(budgetIssue({ ...cfg, warmup_days: 1 }, 40)!, /11 days/); // warm-up counts
  assert.match(budgetIssue({ ...cfg, days: 0.5, replications: 100 }, 5)!, /500 runs/);

  // the id is unique against the draft at add time
  const draft: Scenario[] = [{ id: "optimized", name: "o", overlays: [] }];
  assert.deepEqual(addScenario(draft, { id: "optimized", name: "n", overlays: [] }).map((s) => s.id), ["optimized", "optimized_2"]);
  assert.equal(addScenario(draft, { id: "new", name: "n", overlays: [] })[1].id, "new");

  // chart rows: value order with the base at 0; a response without the newer fields does not crash
  const st = (mean: number) => ({ mean, p10: mean, p50: mean, p90: mean });
  const sr = (id: string, mean: number, extra = {}) => ({ id, name: id, summary: { k: st(mean) }, ledger: [], off_shift_minutes: 0, runs: [], ...extra });
  const down = demandSweep(base, [-5, 10], null);
  const res = { disclaimer: "", kpi_keys: ["k"], scenarios: [sr("b", 1), sr(down[0].scenario.id, 2, { comparison: { k: { delta: 1, ci_low: 0.5, ci_high: 1.5, significant: true } } }), sr(down[1].scenario.id, 3)] };
  const rows = sweepRows(down, res, "k");
  assert.deepEqual(rows.map((r) => r.label), ["-5%", "Base", "+10%"]);
  assert.equal(rows[0].comparison?.significant, true);
  assert.equal(rows[2].comparison, undefined);
  assert.equal(sweepRows(down, res, "gone")[1].stat, undefined);
}

{ // CSV export: rows, escapes, formula prefixes in text but not in numbers
  assert.equal(csvText("plain"), "plain");
  assert.equal(csvText('a,"b"'), '"a,""b"""');
  assert.equal(csvText("line\nbreak"), '"line\nbreak"');
  for (const bad of ["=SUM(A1)", "+1", "-1", "@x", " =x", "\tx"]) assert.ok(csvText(bad).replace(/^"/, "").startsWith("'"), bad);
  assert.equal(csvText("=a,b"), `"'=a,b"`);
  const s0 = { id: "a", name: "=Base, one", summary: { k: { mean: -1.5, p10: 1, p50: 2, p90: 3, ci_low: -2, ci_high: -1 } }, ledger: [], off_shift_minutes: 0, runs: [] };
  const s1 = { ...s0, id: "b", name: "Old", summary: { k: { mean: 2, p10: 1, p50: 2, p90: 3 } }, comparison: { k: { delta: 3.5, ci_low: 1, ci_high: 6, significant: true } } };
  const lines = resultsCsv({ disclaimer: "", kpi_keys: ["k", "gone"], scenarios: [s0, s1] }).split("\r\n");
  assert.equal(lines[0], "scenario,kpi,mean,ci_low,ci_high,p10,p50,p90,delta,significant");
  assert.equal(lines[1], `"'=Base, one",k,-1.5,-2,-1,1,2,3,,`); // numbers stay numeric, also when negative
  assert.equal(lines[2], `"'=Base, one",gone,,,,,,,,`);
  assert.equal(lines[3], "Old,k,2,,,1,2,3,3.5,true");
  assert.equal(lines[5], "");

  // reality check
  const summary = { a: { mean: 10, p10: 0, p50: 0, p90: 0, ci_low: 8, ci_high: 12 }, b: { mean: 10, p10: 0, p50: 0, p90: 0 }, one: { mean: 10, p10: 0, p50: 0, p90: 0, ci_low: 10, ci_high: 10 } };
  const r = realityRows(["a", "b", "one", "none"], summary, { a: 12, b: 3, one: 11, none: 5 });
  assert.equal(r[0].verdict, "inside"); assert.equal(r[0].diff, -2);
  assert.equal(realityRows(["a"], summary, { a: 12.5 })[0].verdict, "outside");
  assert.equal(r[1].verdict, undefined); assert.equal(r[1].diff, 7); // an old run has no interval
  assert.equal(r[2].verdict, undefined); // one replication: nothing to be inside of
  assert.equal(r[3].stat, undefined); assert.equal(r[3].actual, 5);
  assert.equal(realityRows(["a"], summary, undefined)[0].diff, undefined);
  const co: Company = { id: "x", name: "x", systems: [], workflows: [], departments: [] };
  const one = setActual(co, "a", 2);
  assert.deepEqual(one.actuals, { a: 2 });
  assert.deepEqual(setActual(one, "b", 0).actuals, { a: 2, b: 0 }); // 0 is a value
  assert.equal("actuals" in setActual(one, "a", undefined), false);

  const row = (minutes: number) => ({ department_id: "d", reason: null, blocker_id: null, minutes, count: 1 });
  assert.deepEqual(topWaits([row(1), row(3), row(2)], 2).map((x) => x.minutes), [3, 2]);
}

{ // People CSV
  assert.deepEqual(parseDays("Mon-Fri"), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays("0-4"), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays("sat, Sunday"), [5, 6]);
  assert.deepEqual(parseDays("Fri-Mon"), [0, 4, 5, 6]);
  assert.deepEqual(parseDays("Mon - Wed"), [0, 1, 2]);
  assert.equal(parseDays("7"), null); assert.equal(parseDays("Mon-"), null); assert.equal(parseDays("Mon-Tue-Wed"), null); assert.equal(parseDays("someday"), null);

  // tokenizer: BOM, CRLF, CR, quotes, embedded delimiters and newlines, blank rows, line numbers
  const t = parseTable('﻿a,b\r\n\r\n"x, ""y""","l1\nl2"\r\n q ,\rz,w');
  assert.deepEqual(t.rows.map((r) => r.cells), [["a", "b"], ['x, "y"', "l1\nl2"], ["q", ""], ["z", "w"]]);
  assert.deepEqual(t.rows.map((r) => r.line), [1, 3, 5, 6]);
  assert.equal(parseTable('a,b\n"open,1').open, 2);
  assert.deepEqual(parseTable("a;b;c,d\n1;2;3,4").rows[0].cells, ["a", "b", "c,d"]); // the delimiter is the commonest one in the header
  assert.deepEqual(parseTable("a\tb\n1\t2").rows[1].cells, ["1", "2"]);

  const hours = { "0": [8, 16] as [number, number] };
  const co: Company = { id: "x", name: "x", systems: [], workflows: [], departments: [
    { id: "ops", name: "Operations", resources: [
      { id: "pool", skills: ["s"], cost_per_hour: 1, schedule: sched, headcount: 3 },
      { id: "ann_lee", name: "Ann Lee", skills: ["s"], cost_per_hour: 10, speed_factor: 2, schedule: { weekday_hours: hours, absences: [[0, 60]] } },
      { id: "mem", name: "Mem", skills: ["s"], cost_per_hour: 5, schedule: null, pool_id: "pool" },
    ] },
    { id: "sales", name: "Sales", resources: [] },
  ] };
  const plan = (text: string, opts = {}) => parsePeopleCsv(text, co, opts);
  const err = (text: string, opts = {}) => plan(`name,department,skills,id,start,end,days,cost_per_hour,speed_factor,overtime_rate\n${text}`, opts).rows[0].errors.join("|");

  // file-level problems
  assert.match(plan("").error!, /header/);
  assert.match(plan("name,skills\nA,x").error!, /Missing column: department/);
  assert.match(plan("name,name,department,skills\n").error!, /twice/);
  assert.match(plan('name,department,skills\n"A,Sales,x').error!, /never closed/);
  assert.match(plan(`name,department,skills\n${"A,Sales,x\n".repeat(5001)}`).error!, /5001 rows.*5000/);
  assert.equal(plan(`name,department,skills\n${"A,Sales,x\n".repeat(5000)}`).error, null);
  assert.deepEqual(plan("Name,DEPARTMENT, Skills ,badge\nA,Sales,x,1").warnings, ["Ignored column: badge."]);
  assert.equal(plan("Name,DEPARTMENT, Skills \nA,Sales,x").rows[0].status, "new"); // headers are case-insensitive
  assert.equal(plan("name,department,skills\n").rows.length, 0);
  assert.match(plan("name,department,skills\nAy�e,Sales,x").warnings[0], /UTF-8/);

  // a new person with defaults, by department id or name in any case, Excel's semicolons and BOM
  const excel = plan('﻿name;department;skills;cost_per_hour\r\n"Ayşe Kaya";SALES;"quote;order; quote";12,5\r\n');
  const ayse = excel.rows[0];
  assert.deepEqual(ayse, { line: 2, name: "Ayşe Kaya", id: "ayse_kaya", department: "SALES", deptId: "sales", deptName: "Sales", newDept: false, errors: [], status: "new",
    fields: { skills: ["quote", "order"], cost_per_hour: 12.5 } });
  assert.equal(plan("name\tdepartment\tskills\nB\toperations\tx").rows[0].deptId, "ops");
  const applied = applyPeople(co, excel, "skip").departments[1].resources[0];
  assert.deepEqual(applied, { id: "ayse_kaya", name: "Ayşe Kaya", skills: ["quote", "order"], cost_per_hour: 12.5, schedule: weekdays9to5() });

  // row-level errors
  assert.match(err(",Sales,x"), /name is empty/);
  assert.match(err("A,,x"), /department is empty/);
  assert.match(err("A,Nowhere,x"), /unknown department "Nowhere"/);
  for (const bad of ["-1", "Infinity", "NaN", "1e999", "abc", "0x10", "1,000"]) assert.match(err(`A,Sales,x,,,,,"${bad}"`), /cost_per_hour/, bad);
  assert.match(err("A,Sales,x,,,,,,0"), /speed_factor: must be above 0/);
  assert.match(err("A,Sales,x,,,,,,,0.5"), /overtime_rate: must be 1 or more/);
  assert.match(err("A,Sales,x,,24"), /start: must be/);
  assert.match(err("A,Sales,x,,-1"), /start: must be/);
  assert.match(err("A,Sales,x,,10,9"), /end: must be after 10/);
  assert.match(err("A,Sales,x,,10,35"), /end: must be after 10 and at most 34/);
  assert.match(err("A,Sales,x,,18"), /end: must be after 18/); // the default end does not fit
  assert.match(err("A,Sales,x,,,,Funday"), /days:/);
  assert.match(err("A,Sales,x,???"), /no letters or digits/);
  assert.match(err("A,Sales,x,pool"), /belongs to a pool/);
  assert.match(err("A,Sales,x,hired", { reserved: ["hired"] }), /added by a scenario/);
  assert.match(plan("name,department,skills\nA,Sales,x,extra").rows[0].errors[0], /4 cells but 3 columns/);

  // schedules
  const sch = (cells: string) => plan(`name,department,skills,start,end,days\nA,Sales,x,${cells}`).rows[0].fields.schedule;
  assert.equal(sch(",,"), undefined);
  assert.deepEqual(sch("8,12,Sat"), { weekday_hours: { "5": [8, 12] } });
  assert.deepEqual(sch("22,30,0"), { weekday_hours: { "0": [22, 30] } }); // overnight
  assert.deepEqual(sch("8:30,17:15,0"), { weekday_hours: { "0": [8.5, 17.25] } });
  assert.deepEqual(sch(",,0-1"), { weekday_hours: { "0": [9, 17], "1": [9, 17] } });
  assert.deepEqual(sch("10,,"), { weekday_hours: Object.fromEntries([0, 1, 2, 3, 4].map((d) => [String(d), [10, 17]])) });

  // ids: from the name, unique in the file and against pools and scenarios; explicit ones checked
  const ids = (text: string, opts = {}) => plan(text, opts).rows.map((r) => r.id);
  assert.deepEqual(ids("name,department,skills\nBo Li,Sales,x\nBo Li,Sales,x\nPool,Sales,x\nHired,Sales,x", { reserved: ["hired"] }), ["bo_li", "bo_li_2", "pool_2", "hired_2"]);
  assert.equal(ids("name,department,skills\n李,Sales,x")[0], "emp"); // no latin letters in the name
  assert.match(plan("name,department,skills,id\nA,Sales,x,dup\nB,Sales,x,DUP").rows[1].errors[0], /already used on line 2/);
  assert.equal(ids("name,department,skills,id\nA,Sales,x,Mr. X")[0], "mr_x");

  // re-import: an explicit choice, a skip changes nothing, an update only what is filled
  const again = plan("name,department,skills,id,cost_per_hour\nAnn L,Sales,,ann_lee,30\nNew One,Sales,x,,\n");
  assert.deepEqual(again.rows.map((r) => r.status), ["existing", "new"]);
  assert.equal(importedRows(again, "skip").length, 1);
  assert.equal(importedRows(again, "update").length, 2);
  const skipped = applyPeople(co, again, "skip");
  assert.deepEqual(skipped.departments[0], co.departments[0]);
  assert.equal(skipped.departments[1].resources.length, 1);
  const upd = applyPeople(co, again, "update");
  const ann = upd.departments[1].resources[0];
  assert.deepEqual(JSON.parse(JSON.stringify(ann)), { id: "ann_lee", name: "Ann L", skills: ["s"], cost_per_hour: 30, speed_factor: 2, schedule: { weekday_hours: hours, absences: [[0, 60]] } });
  assert.equal(upd.departments[0].resources.length, 2); // moved, not copied
  assert.equal(headcount(upd), headcount(co) + 1);
  // an update with hours keeps the absences; a pool member moved away leaves the pool
  const hoursUpd = applyPeople(co, plan("name,department,skills,id,start,end\nAnn,ops,,ann_lee,7,11"), "update").departments[0].resources[1];
  assert.deepEqual(hoursUpd.schedule, { weekday_hours: Object.fromEntries([0, 1, 2, 3, 4].map((d) => [String(d), [7, 11]])), absences: [[0, 60]] });
  const memberMoved = applyPeople(co, plan("name,department,skills,id\nMem,Sales,,mem"), "update");
  assert.equal(memberMoved.departments[1].resources[0].pool_id, undefined);
  assert.equal(memberMoved.departments[0].resources[0].headcount, 2);

  // missing departments: an error unless asked for, one per name, only when a row really imports
  const mk = plan("name,department,skills\nA,Field Team,x\nB,field team,x\nC,Lab,x", { createMissing: true });
  assert.deepEqual(mk.rows.map((r) => [r.deptId, r.newDept]), [["field_team", true], ["field_team", true], ["lab", true]]);
  const made = applyPeople(co, mk, "skip");
  assert.deepEqual(made.departments.slice(2).map((d) => [d.id, d.name, d.resources.length]), [["field_team", "Field Team", 2], ["lab", "Lab", 1]]);
  assert.equal(plan("name,department,skills\nA,Sales Dept,x\n", { createMissing: true }).rows[0].deptId, "sales_dept");
  assert.equal(parsePeopleCsv("name,department,skills\nA,S X,x", { ...co, departments: [{ id: "s_x", name: "Other", resources: [] }] }, { createMissing: true }).rows[0].deptId, "s_x_2");
  const withBad = plan("name,department,skills,cost_per_hour\nA,Lab,x,-1\n", { createMissing: true });
  assert.equal(applyPeople(co, withBad, "skip"), co); // error rows change nothing, not even a department
  // cell text stays data
  const html = plan('name,department,skills\n"<img src=x onerror=1>",Sales,"<b>"').rows[0];
  assert.equal(html.name, "<img src=x onerror=1>"); assert.equal(html.id, "img_src_x_onerror_1");
  checkCompany(applyPeople(co, excel, "skip"));
}

{ // forms: per-day hours round trip, new company fields, absences, holiday day numbers
  const mixed: Schedule = { weekday_hours: { "0": [9, 17], "1": [[8.5, 12], [13, 17.25]], "5": [[1, 2], [3, 4], [5, 6]] }, absences: [[0, 60]] };
  const copy = JSON.stringify(mixed);
  assert.equal(sameEveryDay(mixed), false); // opens in per-day mode
  const edited = setDayHours(mixed, "0", [[10, 17]]);
  assert.equal(JSON.stringify(mixed), copy);
  assert.deepEqual(edited, { ...mixed, weekday_hours: { ...mixed.weekday_hours, "0": [10, 17] } }); // other shapes, fractions and absences untouched
  assert.deepEqual(setDayHours(mixed, "1", [[8.5, 12], [13, 18]]).weekday_hours["1"], [[8.5, 12], [13, 18]]);
  assert.deepEqual(setDayHours(mixed, "5", null).weekday_hours, { "0": [9, 17], "1": mixed.weekday_hours["1"] });
  assert.deepEqual(setDayHours(setDayHours(mixed, "2", [[9, 12]]), "2", null), mixed);
  assert.equal(sameEveryDay({ weekday_hours: { "0": [9, 17], "1": [[9, 17]] } }), true); // a bare pair is one window
  assert.equal(sameEveryDay({ weekday_hours: {} }), true);
  assert.equal(sameEveryDay({ weekday_hours: { "0": [[1, 2], [3, 4], [5, 6]] } }), false); // three windows only fit per day
  assert.equal(sameEveryDay({ weekday_hours: { "0": [] } }), false);
  assert.deepEqual(orderWindows([[9.5, 9.5], [9, 20]], 0.25), [[9.5, 9.75], [9.75, 20]]);
  assert.deepEqual(orderWindows([[9.5, 17.5]], 1), [[9, 17]]);

  const base = { id: "x", name: "x", departments: [] };
  assert.deepEqual(checkCompany({ ...base, holidays: [0, 7], actuals: { a: 0.5 } }).holidays, [0, 7]);
  for (const bad of [{ holidays: 3 }, { holidays: [1.5] }, { holidays: [-1] }, { holidays: ["1"] }, { actuals: [] }, { actuals: { a: "1" } }, { actuals: { a: null } }]) assert.throws(() => checkCompany({ ...base, ...bad }), JSON.stringify(bad));
  const person = (schedule: unknown) => ({ ...base, departments: [{ id: "d", name: "d", resources: [{ id: "r", skills: [], cost_per_hour: 1, schedule }] }] });
  checkCompany(person({ weekday_hours: {}, absences: [[0, 60]] }));
  assert.throws(() => checkCompany(person({ weekday_hours: {}, absences: 5 })), /absences/);
  assert.throws(() => checkCompany(person({ weekday_hours: {}, absences: [[0]] })), /absences/);
  const wfWith = (x: object) => ({ ...base, workflows: [{ id: "w", name: "w", steps: [], ...x }] });
  const win = { rate_per_hour: 1, window: { weekday_hours: {} } };
  checkCompany(wfWith({ arrival: { ...win, initial_backlog: 5 } }));
  assert.throws(() => checkCompany(wfWith({ arrival: { ...win, initial_backlog: -1 } })), /initial_backlog/);
  assert.throws(() => checkCompany(wfWith({ inflows: [{ ...win, id: "i", entry: [], initial_backlog: 1.5 }] })), /initial_backlog/);

  assert.deepEqual(parseDayList("12, 5;5 40"), [5, 12, 40]);
  assert.deepEqual(parseDayList(" "), []);
  for (const bad of ["-1", "1.5", "x", "36501"]) assert.equal(parseDayList(bad), null, bad);
  assert.equal(parseDayList(Array.from({ length: 367 }, (_, i) => i).join(",")), null);

  assert.deepEqual(editAbsence([600, 1020], "start", 0, 9), [540, 1020]);
  assert.deepEqual(editAbsence([600, 1020], "end", 1, 0), [600, 1440]);
  assert.deepEqual(editAbsence([600, 1020], "start", 2, 0), [2880, 2940]); // start past the end: the end follows
  assert.deepEqual(editAbsence([600, 1020], "end", 0, 1), [600, 660]);
}

console.log("ok");

