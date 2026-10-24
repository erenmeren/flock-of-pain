"""Metrics computed from an engine event log plus static company data (pure; no engine import)."""
from collections import defaultdict
from dataclasses import dataclass, field
from math import ceil

from flock_of_pain.events import Event, EventKind, Reason
from flock_of_pain.model import Company

K = EventKind


def percentile(xs: list[float], p: float) -> float:
    """Nearest-rank percentile; 0.0 for an empty list."""
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[max(0, ceil(p / 100 * len(s)) - 1)]


def _div(a: float, b: float) -> float:
    return a / b if b else 0.0


@dataclass
class WorkflowMetrics:
    started: int = 0
    completed: int = 0
    cancelled: int = 0
    throughput_per_day: float = 0.0
    cycle_p50: float = 0.0
    cycle_p90: float = 0.0
    wait_p50: float = 0.0
    wait_p90: float = 0.0
    sla_breached: int = 0
    sla_breach_rate: float = 0.0
    steps_completed: int = 0
    failures: int = 0
    rework_rate: float = 0.0
    cost_per_completed: float = 0.0


@dataclass
class ResourceMetrics:
    busy_minutes: float = 0.0
    on_shift_minutes: float = 0.0
    utilization: float = 0.0
    tasks_completed: int = 0
    blocked_minutes: float = 0.0
    labor_cost: float = 0.0


@dataclass
class DeptMetrics:
    utilization: float = 0.0
    tasks_completed: int = 0
    backlog_max: int = 0
    wait_p50: float = 0.0
    labor_cost: float = 0.0


@dataclass
class LedgerRow:
    department_id: str
    reason: Reason | None
    blocker_id: str | None
    minutes: float
    count: float


@dataclass
class Metrics:
    horizon_minutes: float
    workflows: dict[str, WorkflowMetrics] = field(default_factory=dict)
    departments: dict[str, DeptMetrics] = field(default_factory=dict)
    resources: dict[str, ResourceMetrics] = field(default_factory=dict)
    ledger: list[LedgerRow] = field(default_factory=list)
    labor_cost: float = 0.0


@dataclass
class _TaskTrack:
    wait_from: float | None = None  # non-retag TASK_QUEUED time not yet followed by a start
    segment: tuple[float, Reason | None, str | None] | None = None  # open ledger wait segment
    run: tuple[float, str] | None = None  # (start time, resource id)
    blocked: tuple[float, str | None, str | None] | None = None  # (t, system id, resource id)


def compute_metrics(events: list[Event], company: Company, horizon_minutes: float) -> Metrics:
    """Unfinished waits, runs and blocks are closed at the horizon."""
    resources = company.resources()
    rm = {r.id: ResourceMetrics(on_shift_minutes=r.schedule.on_minutes(0, horizon_minutes)) for r in resources}
    wm = {w.id: WorkflowMetrics() for w in company.workflows}
    dm = {d.id: DeptMetrics() for d in company.departments}
    tracks: dict[str, _TaskTrack] = defaultdict(_TaskTrack)
    ledger: dict[tuple[str, Reason | None, str | None], list] = defaultdict(lambda: [0.0, 0])
    waits_wf: dict[str, list[float]] = defaultdict(list)
    waits_dept: dict[str, list[float]] = defaultdict(list)
    wf_cost: dict[str, float] = defaultdict(float)
    wf_started: dict[str, float] = {}
    cycles: dict[str, list[float]] = defaultdict(list)
    cancelled: dict[str, set[str]] = defaultdict(set)
    breached: dict[str, set[str]] = defaultdict(set)  # workflow -> instances with any SLA breach
    done: dict[str, set[str]] = defaultdict(set)  # workflow -> completed instances
    queued: dict[str, set[str]] = defaultdict(set)  # department -> task ids waiting
    last_t = None

    def close_segment(e: Event, tr: _TaskTrack, t: float) -> None:
        if tr.segment is not None and t > tr.segment[0]:
            row = ledger[e.department_id, tr.segment[1], tr.segment[2]]
            row[0] += t - tr.segment[0]
            row[1] += 1
        tr.segment = None

    def close_run(e: Event, tr: _TaskTrack, t: float) -> None:
        if tr.run is not None:
            minutes = t - tr.run[0]
            rm[tr.run[1]].busy_minutes += minutes
            wf_cost[e.workflow_id] += minutes / 60 * company.resource(tr.run[1]).cost_per_hour
        tr.run = None

    def close_block(e: Event, tr: _TaskTrack, t: float) -> None:
        if tr.blocked is not None:
            start, system_id, resource_id = tr.blocked
            row = ledger[e.department_id, Reason.SYSTEM_DOWN, system_id]
            row[0] += t - start
            row[1] += 1
            if resource_id in rm:
                rm[resource_id].blocked_minutes += t - start
        tr.blocked = None

    def sample_backlog() -> None:
        for d, ids in queued.items():
            if d in dm:
                dm[d].backlog_max = max(dm[d].backlog_max, len(ids))

    for e in events:
        if last_t is not None and e.t != last_t:
            sample_backlog()  # after all same-instant events, so instant starts don't count as backlog
        last_t = e.t
        w = wm.setdefault(e.workflow_id, WorkflowMetrics()) if e.workflow_id else None
        if e.kind == K.WORKFLOW_STARTED:
            w.started += 1
            wf_started[e.instance_id] = e.t
        elif e.kind == K.WORKFLOW_COMPLETED:
            w.completed += 1
            done[e.workflow_id].add(e.instance_id)
            if e.instance_id in wf_started:
                cycles[e.workflow_id].append(e.t - wf_started[e.instance_id])
        elif e.kind == K.SLA_BREACHED:
            breached[e.workflow_id].add(e.instance_id)
        if e.task_id is None:
            continue
        tr = tracks[e.task_id]
        if e.kind in (K.TASK_QUEUED, K.TASK_UNBLOCKED):
            close_segment(e, tr, e.t)
            close_block(e, tr, e.t)
            tr.segment = (e.t, e.reason, e.system_id if e.reason == Reason.SYSTEM_DOWN else None)
            if not e.payload.get("retag"):
                queued[e.department_id].add(e.task_id)
                if e.kind == K.TASK_QUEUED:
                    tr.wait_from = e.t
        elif e.kind == K.TASK_STARTED:
            close_segment(e, tr, e.t)
            queued[e.department_id].discard(e.task_id)
            if tr.wait_from is not None:
                waits_wf[e.workflow_id].append(e.t - tr.wait_from)
                waits_dept[e.department_id].append(e.t - tr.wait_from)
                tr.wait_from = None
            tr.run = (e.t, e.resource_id)
        elif e.kind in (K.TASK_COMPLETED, K.TASK_FAILED, K.TASK_BLOCKED):
            close_run(e, tr, e.t)
            if e.kind == K.TASK_COMPLETED:
                w.steps_completed += 1
                if e.resource_id in rm:
                    rm[e.resource_id].tasks_completed += 1
                if e.department_id in dm:
                    dm[e.department_id].tasks_completed += 1
            elif e.kind == K.TASK_FAILED:
                w.failures += 1
            else:
                tr.blocked = (e.t, e.system_id, e.resource_id)
        elif e.kind == K.TASK_CANCELLED:
            close_segment(e, tr, e.t)
            queued[e.department_id].discard(e.task_id)
            cancelled[e.workflow_id].add(e.instance_id)
    sample_backlog()

    # close what is still open at the horizon
    for e in reversed(events):
        if e.task_id is not None and e.task_id in tracks:
            tr = tracks.pop(e.task_id)
            t = max(horizon_minutes, e.t)
            close_segment(e, tr, t)
            close_run(e, tr, t)
            close_block(e, tr, t)

    by_dept: dict[str, list] = defaultdict(lambda: [0.0, 0.0])  # busy, on-shift slot-minutes
    for r in resources:
        m = rm[r.id]
        m.utilization = _div(m.busy_minutes, m.on_shift_minutes * r.capacity)
        m.labor_cost = m.busy_minutes / 60 * r.cost_per_hour
        by_dept[r.department_id][0] += m.busy_minutes
        by_dept[r.department_id][1] += m.on_shift_minutes * r.capacity
        if r.department_id in dm:
            dm[r.department_id].labor_cost += m.labor_cost
    for d_id, d in dm.items():
        d.utilization = _div(*by_dept[d_id])
        d.wait_p50 = percentile(waits_dept[d_id], 50)

    days = horizon_minutes / 1440
    for w_id, w in wm.items():
        w.cancelled = len(cancelled[w_id])
        w.throughput_per_day = _div(w.completed, days)
        w.cycle_p50, w.cycle_p90 = percentile(cycles[w_id], 50), percentile(cycles[w_id], 90)
        w.wait_p50, w.wait_p90 = percentile(waits_wf[w_id], 50), percentile(waits_wf[w_id], 90)
        w.sla_breached = len(breached[w_id] & done[w_id])
        w.sla_breach_rate = _div(w.sla_breached, w.completed)
        w.rework_rate = _div(w.failures, w.steps_completed)
        w.cost_per_completed = _div(wf_cost[w_id], w.completed)

    rows = [LedgerRow(d, reason, blocker, minutes, n) for (d, reason, blocker), (minutes, n) in ledger.items()]
    rows.sort(key=lambda r: (-r.minutes, r.department_id, r.reason or "", r.blocker_id or ""))
    return Metrics(horizon_minutes, wm, dm, rm, rows, sum(m.labor_cost for m in rm.values()))
