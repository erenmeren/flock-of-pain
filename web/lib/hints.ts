"use client";
// Help hints next to important labels. Off/on is a per-browser setting (Settings page).
import { useSyncExternalStore } from "react";

const KEY = "flock_hints_off";
const listeners = new Set<() => void>();
const read = () => { try { return localStorage.getItem(KEY) === null; } catch { return true; } };
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

/** True when hints are shown. Server render and first paint say true, so the markup matches. */
export const useHintsOn = () => useSyncExternalStore(subscribe, read, () => true);

export function setHintsOn(on: boolean) {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "1"); } catch { /* private window: setting lives for this page only */ }
  listeners.forEach((l) => l());
}

export const HINTS: Record<string, string> = {
  // simulation config
  seed: "Random seed. The same seed and settings give the same result; change it for a different random draw.",
  days: "How many simulated days to run. Longer runs smooth out randomness but take longer.",
  replications: "How many times each scenario is re-run with different random draws. KPIs are averaged over them.",
  policy: "How a free worker picks the next task: priority = highest step priority first, fifo = oldest first, least_loaded = the department with the longest queue first.",
  include_events: "Records every event so the run can be replayed step by step on this page. Limited to 30 run-days (days × reps × scenarios).",
  save_run: "Stores the result on the server so it appears under Run History on the Analysis page.",
  // workflow step
  step_department: "Only staff of this department can work on the step.",
  step_skill: "The step goes only to people or pools whose skills include this one. A step with no skilled staff never completes.",
  duration: "Average working time in minutes for one item. Real times vary around it.",
  sigma: "Spread of the duration: 0.1 is nearly fixed, 1 is very variable.",
  step_system: "Business system the step needs. While that system is down (outage) the step waits.",
  sla: "Target minutes from arrival to finishing this step. Finishing later counts as an SLA breach.",
  priority: "Higher wins when a worker chooses between waiting tasks under the priority policy.",
  fail: "Chance in percent that the step fails and the item is sent back to the rework step.",
  rework_to: "Step the item returns to after a failure.",
  retries: "How many failures are retried before the item is dropped.",
  // inflow
  rate: "Average new items per hour while the window is open.",
  window: "Days and hours when new items arrive. Work on them can continue outside the window.",
  entry: "The first steps a new item of this inflow goes to.",
  // organization
  department: "A group of staff. Each workflow step belongs to one department and needs one skill.",
  skills: "Comma-separated skills. A step is only picked up by staff that has its required skill.",
  cost: "Hourly cost of this person or pool member. Feeds the Labor cost KPI.",
  speed: "Work-speed multiplier: 2 finishes tasks twice as fast, 0.5 half as fast.",
  schedule: "Working hours. Outside them the person is off shift and their tasks wait.",
  pool: "Interchangeable staff sharing one skill set and schedule. Headcount is how many work at the same time.",
  headcount: "How many pool members work at the same time.",
  members: "Named people attached to this pool. They can inherit its schedule.",
  system: "Software or equipment that steps depend on. A scenario can take it down with an outage.",
  // scenarios
  scenarios: "A scenario is the base company plus a few changes (overlays): more orders, an outage, an extra employee. Baseline has no overlays. Every run simulates all scenarios so you can compare them.",
  outages: "Downtime of a system that every scenario sees. Start and end are minutes from the start of the run; the clock label shows the weekday time they mean.",
  arrival_multiplier: "Multiplies the arrival rate of one workflow, or all of them. 1.3 means 30% more items.",
  system_outage: "Takes a system down between two minutes. Steps that need it wait until it is back.",
  add_employee: "Adds a person to a department for this scenario only.",
  remove_resource: "Removes a person or a whole pool for this scenario only.",
  set_pool_headcount: "Changes how many people a pool has for this scenario only.",
  absence: "A person is away between two minutes (sick day, training).",
  // KPIs (keys match the API)
  throughput_per_day: "Completed items per simulated day.",
  completion_rate: "Share of arrived items that finished within the run. Below 1 means a backlog is building.",
  cycle_p50: "Median minutes from arrival to completion, including waiting and off-shift time.",
  cycle_p90: "90% of items finish within this many minutes.",
  wait_p90: "90% of waits for a free worker are shorter than this many minutes.",
  sla_breach_rate: "Share of step executions that finished after their SLA.",
  rework_rate: "Share of step executions that failed and were redone.",
  mean_dept_utilization: "Average busy share of staff during their shifts. Around 0.75 is healthy; near 1 means a bottleneck.",
  labor_cost: "Hours worked times cost per hour, summed over all staff.",
  cost_per_completed: "Labor cost divided by completed items.",
  health: "Composite score: delivery (completion rate), SLA (1 − breach rate), quality (1 − rework rate) and balance (utilization close to 75%).",
  // settings
  api_key: "Secret key of your tenant. Every saved company and run belongs to the tenant of the key. Create or rotate one with the flock_of_pain tenant command.",
  generate: "Describe the company in words. Claude drafts departments, people, workflows and scenarios; you can edit everything afterwards.",
};
