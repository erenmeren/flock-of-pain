import type { SimEvent } from "@/lib/api";
import { DAYS } from "@/lib/company";

export type Live = { task_id: string; state: "QUEUED" | "IN_PROGRESS" | "BLOCKED"; department_id: string; step_id: string; reason: string | null; resource_id: string | null; since: number };
export type Snapshot = {
  tasks: Live[];
  perDept: Record<string, { QUEUED: number; IN_PROGRESS: number; BLOCKED: number }>;
  started: number; completed: number; sla: number; outages: string[];
};


/** Fold the events up to and including time t into the live task set and counters. */
export function snapshot(events: SimEvent[], t: number): Snapshot {
  const tasks = new Map<string, Live>();
  const out: Snapshot = { tasks: [], perDept: {}, started: 0, completed: 0, sla: 0, outages: [] };
  const outages = new Set<string>();
  for (const e of events) {
    if (e.t > t) break; // events are time-ordered
    switch (e.kind) {
      case "WORKFLOW_STARTED": out.started++; break;
      case "WORKFLOW_COMPLETED": out.completed++; break;
      case "SLA_BREACHED": out.sla++; break;
      case "SYSTEM_OUTAGE_STARTED": if (e.system_id) outages.add(e.system_id); break;
      case "SYSTEM_OUTAGE_ENDED": if (e.system_id) outages.delete(e.system_id); break;
      case "TASK_QUEUED": case "TASK_STARTED": case "TASK_UNBLOCKED": case "TASK_BLOCKED": {
        if (!e.task_id) break;
        // TASK_UNBLOCKED is BLOCKED -> QUEUED in the engine; a TASK_STARTED at the same t follows when a resource is free
        const state = e.kind === "TASK_STARTED" ? "IN_PROGRESS" : e.kind === "TASK_BLOCKED" ? "BLOCKED" : "QUEUED";
        const prev = tasks.get(e.task_id);
        const sameState = prev?.state === state;
        tasks.set(e.task_id, {
          task_id: e.task_id, state, department_id: e.department_id ?? "", step_id: e.step_id ?? "",
          reason: e.reason, resource_id: state === "QUEUED" ? null : (e.resource_id ?? prev?.resource_id ?? null), // the engine keeps the last attempt's resource on a re-queue
          since: sameState ? prev.since : e.t, // a reason retag keeps the wait start
        });
        break;
      }
      case "TASK_COMPLETED": case "TASK_FAILED": case "TASK_CANCELLED": if (e.task_id) tasks.delete(e.task_id); break;
    }
  }
  out.outages = [...outages].sort();
  out.tasks = [...tasks.values()];
  for (const x of out.tasks) {
    const d = (out.perDept[x.department_id] ??= { QUEUED: 0, IN_PROGRESS: 0, BLOCKED: 0 });
    d[x.state]++;
  }
  return out;
}

export function clock(t: number): string {
  const day = Math.floor(t / 1440);
  const m = Math.floor(t % 1440);
  return `week ${Math.floor(day / 7) + 1} ${DAYS[day % 7]} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
