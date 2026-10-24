import pytest

from conftest import tiny_company

from flock_of_pain.dist import const
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.events import EventKind as K
from flock_of_pain.events import Reason
from flock_of_pain.model import Step
from flock_of_pain.schedule import business_hours

DAY = 1440


def one_step(duration=30, skill="support"):
    return [Step("a", "A", "cs", skill, const(duration))]


def arrive_at(engine, t, n=1):
    engine.run_until(t)
    wf = engine.company.workflows[0]
    for _ in range(n):
        engine._arrive(wf)


def task_events(engine, task_id):
    return [e for e in engine.events if e.task_id == task_id]


def first(engine, kind, task_id):
    return next(e for e in task_events(engine, task_id) if e.kind == kind)


def test_single_task_runs():
    # pool headcount 1 minus carved e1 -> only e1 can work
    e = Engine(tiny_company(pool_headcount=1, steps=one_step(30)), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60)
    e.run()
    evs = task_events(e, "w-000001:a:0")
    assert [x.kind for x in evs] == [
        K.TASK_CREATED, K.TASK_QUEUED, K.RESOURCE_ASSIGNED, K.TASK_STARTED, K.TASK_COMPLETED,
    ]
    assert evs[1].reason is None
    assert evs[-1].t == 9 * 60 + 30
    assert evs[-1].resource_id == "e1"


def test_waits_for_shift():
    e = Engine(tiny_company(pool_headcount=1, steps=one_step(30)), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 8 * 60)
    e.run()
    assert first(e, K.TASK_QUEUED, "w-000001:a:0").reason == Reason.OFF_SHIFT
    assert first(e, K.TASK_STARTED, "w-000001:a:0").t == 9 * 60


def test_pool_capacity_respected():
    c = tiny_company(pool_headcount=2, employees=0, steps=one_step(60))
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60, n=3)
    e.run()
    starts = [first(e, K.TASK_STARTED, f"w-00000{i}:a:0").t for i in (1, 2, 3)]
    assert starts == [9 * 60, 9 * 60, 9 * 60 + 60]
    assert first(e, K.TASK_QUEUED, "w-000003:a:0").reason == Reason.ALL_RESOURCES_BUSY


def test_missing_skill_never_crashes():
    e = Engine(tiny_company(steps=one_step(skill="welding")), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60)
    e.run()
    last = task_events(e, "w-000001:a:0")[-1]
    assert last.kind == K.TASK_QUEUED
    assert last.reason == Reason.NO_ELIGIBLE_RESOURCE
    assert e.now == DAY


def test_two_step_dependency():
    e = Engine(tiny_company(), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60)
    e.run()
    assert first(e, K.TASK_CREATED, "w-000001:b:0").t == first(e, K.TASK_COMPLETED, "w-000001:a:0").t
    assert [x.kind for x in e.events if x.instance_id == "w-000001"][-1] == K.WORKFLOW_COMPLETED


def run_log(seed):
    e = Engine(tiny_company(rate_per_hour=4), RunConfig(seed=seed, horizon_minutes=3 * DAY))
    e.run()
    return e


def test_determinism():
    log = lambda e: "\n".join(x.to_json() for x in e.events)  # noqa: E731
    a = run_log(42)
    assert any(x.kind == K.TASK_COMPLETED for x in a.events)
    assert log(a) == log(run_log(42))
    assert log(a) != log(run_log(43))


def test_capacity_invariant():
    e = run_log(42)
    busy: dict[str, int] = {}
    for ev in e.events:
        if ev.kind == K.TASK_STARTED:
            busy[ev.resource_id] = busy.get(ev.resource_id, 0) + 1
        elif ev.kind in (K.TASK_COMPLETED, K.TASK_FAILED, K.TASK_BLOCKED):
            busy[ev.resource_id] -= 1
        if ev.resource_id:
            assert busy.get(ev.resource_id, 0) <= e.company.resource(ev.resource_id).capacity
    assert busy  # some work actually ran


def test_step_and_pause():
    e = Engine(tiny_company(), RunConfig(seed=1, horizon_minutes=DAY))
    e.pause()
    e.run()
    assert len(e.events) == 0 and e.now == 0
    e.resume()
    assert e.step() is True
    assert e.now == 9 * 60
    e.schedule(600, e.pause)
    e.run()
    assert e.now == 600
    e.resume()
    e.run()
    assert e.now == DAY
    assert e.step() is False


def test_sla_breach_logged_on_late_completion():
    steps = [Step("a", "A", "cs", "support", const(60), sla_minutes=90)]
    e = Engine(tiny_company(pool_headcount=2, employees=0, steps=steps), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60, n=3)
    e.run()
    assert [x.task_id for x in e.events if x.kind == K.SLA_BREACHED] == ["w-000003:a:0"]


def test_successor_does_not_jump_queue():
    e = Engine(tiny_company(pool_headcount=1), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60, n=2)
    e.run()
    assert first(e, K.TASK_STARTED, "w-000002:a:0").t == 550
    assert first(e, K.TASK_STARTED, "w-000001:b:0").t == 560


def test_fully_carved_pool_ignored_for_reason():
    c = tiny_company(pool_headcount=1, steps=one_step())
    c.resource("e1").schedule = business_hours(10, 17)  # pool (capacity 0) on at 9, e1 not yet
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60)
    assert first(e, K.TASK_QUEUED, "w-000001:a:0").reason == Reason.OFF_SHIFT


def test_cancel_removes_queued_sibling():
    # two parallel steps, one employee: a fails with no retries while b waits in the queue
    from flock_of_pain.events import TaskState as S
    steps = [
        Step("a", "A", "cs", "support", const(10), failure_prob=1.0, max_retries=0),
        Step("b", "B", "cs", "support", const(10)),
    ]
    e = Engine(tiny_company(rate_per_hour=1, pool_headcount=1, employees=1, steps=steps),
               RunConfig(seed=1, horizon_minutes=7 * DAY))
    e.run()
    first = next(ev.instance_id for ev in e.events if ev.kind == K.WORKFLOW_STARTED)
    kinds = [ev.kind for ev in e.events if ev.instance_id == first and ev.step_id == "b"]
    assert K.TASK_QUEUED in kinds and K.TASK_CANCELLED in kinds and K.TASK_STARTED not in kinds
    assert all(t.state == S.QUEUED for q in e.queues.values() for t in q)
    assert len(e._queue_keys) == sum(len(q) for q in e.queues.values())


@pytest.mark.parametrize("i", range(4))
def test_bounded_tracking_after_reynolds_run(i):
    from flock_of_pain.examples import reynolds
    e = Engine(reynolds.scenarios(reynolds.build())[i].materialize(), RunConfig(seed=1, horizon_minutes=3 * DAY))
    e.run()
    assert not any(inst.cancelled for inst in e.instances.values())
    assert not e.tasks_by_id
    assert not any(e.in_progress.values())
    assert len(e._queue_keys) == sum(len(q) for q in e.queues.values())
