from conftest import tiny_company

from workforce_twin.analytics import LedgerRow, compute_metrics, percentile
from workforce_twin.engine import Engine, RunConfig
from workforce_twin.events import Event, EventKind as K
from workforce_twin.events import Reason

DAY = 1440
TID = "w-000001:a:0"


def ev(t, kind, resource_id=None, reason=None, system_id=None, payload=None):
    return Event(t, kind, TID, "w-000001", "w", "a", "cs", resource_id, system_id, reason, payload or {})


def wf(t, kind):
    return Event(t, kind, instance_id="w-000001", workflow_id="w")


def test_percentile():
    assert percentile([1, 2, 3, 4], 50) == 2
    assert percentile([4, 1, 3, 2], 100) == 4
    assert percentile([], 90) == 0.0


def test_single_instance_metrics():
    events = [
        wf(0, K.WORKFLOW_STARTED),
        ev(0, K.TASK_CREATED),
        ev(0, K.TASK_QUEUED, reason=Reason.OFF_SHIFT),
        ev(10, K.RESOURCE_ASSIGNED, "e1"),
        ev(10, K.TASK_STARTED, "e1"),
        ev(40, K.TASK_COMPLETED, "e1"),
        wf(40, K.WORKFLOW_COMPLETED),
    ]
    m = compute_metrics(events, tiny_company(), DAY)
    w = m.workflows["w"]
    assert (w.started, w.completed, w.cycle_p50, w.wait_p50) == (1, 1, 40, 10)
    assert w.throughput_per_day == 1.0
    assert m.ledger == [LedgerRow("cs", Reason.OFF_SHIFT, None, 10, 1)]
    assert m.resources["e1"].busy_minutes == 30
    assert m.resources["e1"].tasks_completed == 1
    assert m.departments["cs"].backlog_max == 1


def test_empty_events_zeroed():
    m = compute_metrics([], tiny_company(), DAY)
    assert m.labor_cost == 0.0
    assert m.ledger == []
    assert m.workflows["w"].cost_per_completed == 0.0
    assert m.departments["cs"].utilization == 0.0
    assert compute_metrics([], tiny_company(), 0).workflows["w"].throughput_per_day == 0.0


def test_utilization_half_day():
    c = tiny_company()
    c.resource("e1").cost_per_hour = 30.0
    events = [ev(9 * 60, K.TASK_STARTED, "e1"), ev(13 * 60, K.TASK_COMPLETED, "e1")]
    m = compute_metrics(events, c, DAY)
    r = m.resources["e1"]
    assert (r.on_shift_minutes, r.busy_minutes, r.utilization) == (480, 240, 0.5)
    assert r.labor_cost == m.labor_cost == m.departments["cs"].labor_cost == 120.0


def test_retag_splits_wait_without_new_queue_entry():
    events = [
        ev(0, K.TASK_QUEUED, reason=Reason.ALL_RESOURCES_BUSY),
        ev(5, K.TASK_QUEUED, reason=Reason.SYSTEM_DOWN, system_id="erp", payload={"retag": True}),
        ev(20, K.TASK_STARTED, "e1"),
        ev(30, K.TASK_COMPLETED, "e1"),
    ]
    m = compute_metrics(events, tiny_company(), DAY)
    assert m.workflows["w"].wait_p50 == 20
    assert m.departments["cs"].backlog_max == 1
    assert m.ledger == [
        LedgerRow("cs", Reason.SYSTEM_DOWN, "erp", 15, 1),
        LedgerRow("cs", Reason.ALL_RESOURCES_BUSY, None, 5, 1),
    ]


def test_blocked_cycle():
    events = [
        ev(0, K.TASK_QUEUED),
        ev(0, K.TASK_STARTED, "e1"),
        ev(10, K.TASK_BLOCKED, "e1", Reason.SYSTEM_DOWN, "erp"),
        ev(30, K.TASK_UNBLOCKED, "e1", Reason.ALL_RESOURCES_BUSY),
        ev(35, K.TASK_STARTED, "e1"),
        ev(40, K.TASK_COMPLETED, "e1"),
    ]
    m = compute_metrics(events, tiny_company(), DAY)
    r = m.resources["e1"]
    assert (r.busy_minutes, r.blocked_minutes) == (15, 20)
    assert m.workflows["w"].wait_p90 == 0  # restart after unblock adds no wait sample
    assert m.ledger == [
        LedgerRow("cs", Reason.SYSTEM_DOWN, "erp", 20, 1),
        LedgerRow("cs", Reason.ALL_RESOURCES_BUSY, None, 5, 1),
    ]


def test_failure_rework_cycle():
    events = [
        ev(0, K.TASK_QUEUED),
        ev(0, K.TASK_STARTED, "e1"),
        ev(10, K.TASK_FAILED, "e1"),
        ev(10, K.TASK_QUEUED, reason=Reason.ALL_RESOURCES_BUSY),
        ev(20, K.TASK_STARTED, "e1"),
        ev(30, K.TASK_COMPLETED, "e1"),
    ]
    m = compute_metrics(events, tiny_company(), DAY)
    w = m.workflows["w"]
    assert (w.failures, w.rework_rate, w.wait_p90) == (1, 1.0, 10)
    assert m.resources["e1"].busy_minutes == 20


def test_cancelled_counted_once_per_instance():
    events = [ev(10, K.TASK_FAILED, "e1"), ev(10, K.TASK_CANCELLED, "e1"), ev(10, K.TASK_CANCELLED, "e1")]
    assert compute_metrics(events, tiny_company(), DAY).workflows["w"].cancelled == 1


def test_engine_run_consistent():
    c = tiny_company(rate_per_hour=4)
    e = Engine(c, RunConfig(seed=7, horizon_minutes=3 * DAY))
    e.run()
    m = compute_metrics(e.events, c, 3 * DAY)
    w = m.workflows["w"]
    assert 0 < w.completed <= w.started
    assert all(0 <= r.utilization <= 1 for r in m.resources.values())
    assert 0 < m.departments["cs"].utilization <= 1
    assert all(row.minutes >= 0 and row.count > 0 for row in m.ledger)
    # analytics also counts work still in progress at the horizon; the engine does not
    assert sum(r.busy_minutes for r in m.resources.values()) >= sum(e.busy_minutes.values()) - 1e-6
