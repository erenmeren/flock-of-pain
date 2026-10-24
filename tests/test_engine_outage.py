from conftest import tiny_company

from workforce_twin.dist import const
from workforce_twin.engine import Engine, RunConfig
from workforce_twin.events import EventKind as K
from workforce_twin.events import Reason
from workforce_twin.model import (
    ArrivalSpec, BusinessSystem, Company, Department, Resource, Step, Workflow,
)
from workforce_twin.schedule import business_hours

DAY = 1440


def arrive_at(engine, t):
    engine.run_until(t)
    engine._arrive(engine.company.workflows[0])


def first(engine, kind, task_id):
    return next(e for e in engine.events if e.task_id == task_id and e.kind == kind)


def kinds(engine, kind):
    return [e for e in engine.events if e.kind == kind]


def test_outage_blocks_queued_task():
    c = tiny_company(pool_headcount=1, steps=[Step("a", "A", "cs", "support", const(10), system_id="erp")])
    c.outages = [("erp", 600, 720)]
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 600)
    e.run()
    queued = first(e, K.TASK_QUEUED, "w-000001:a:0")
    assert queued.reason == Reason.SYSTEM_DOWN
    assert queued.system_id == "erp"
    assert first(e, K.TASK_STARTED, "w-000001:a:0").t == 720


def test_outage_pauses_in_progress():
    steps = [Step("a", "A", "cs", "support", const(60), system_id="erp"),
             Step("x", "X", "cs", "support", const(30))]
    c = tiny_company(pool_headcount=1, steps=steps)
    c.outages = [("erp", 570, 690)]
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    a = "w-000001:a:0"
    assert first(e, K.TASK_STARTED, a).t == 540
    blocked = first(e, K.TASK_BLOCKED, a)
    assert (blocked.t, blocked.reason, blocked.system_id) == (570, Reason.SYSTEM_DOWN, "erp")
    assert first(e, K.TASK_UNBLOCKED, a).t == 690
    assert first(e, K.TASK_COMPLETED, a).t == 720
    x_start = first(e, K.TASK_STARTED, "w-000001:x:0")
    assert (x_start.t, x_start.resource_id) == (570, "e1")


def test_overlapping_outages():
    c = tiny_company()
    c.outages = [("erp", 600, 700), ("erp", 650, 800)]
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    e.run()
    assert [x.t for x in kinds(e, K.SYSTEM_OUTAGE_STARTED)] == [600]
    assert [x.t for x in kinds(e, K.SYSTEM_OUTAGE_ENDED)] == [800]
    assert e.system_down["erp"] == 0


def two_dept_company(outages):
    sched = business_hours(9, 17)
    c = Company(
        "two", "Two",
        [Department("cs", "CS", [Resource("e1", "cs", {"support"}, schedule=sched)]),
         Department("ops", "Ops", [Resource("e2", "ops", {"support"}, schedule=sched)])],
        [BusinessSystem("erp", "ERP")],
        [Workflow("w", "W", [
            Step("a", "A", "cs", "support", const(10), system_id="erp"),
            Step("b", "B", "ops", "support", const(5), depends_on=["a"]),
        ], ArrivalSpec(0.0, sched))],
        outages=outages,
    )
    c.resolve()
    return c


def test_cascade_delay():
    def b_queued(outages):
        e = Engine(two_dept_company(outages), RunConfig(seed=1, horizon_minutes=DAY))
        arrive_at(e, 600)
        e.run()
        return first(e, K.TASK_QUEUED, "w-000001:b:0").t

    assert b_queued([("erp", 600, 720)]) - b_queued([]) == 120


def test_failure_self_rework():
    steps = [Step("a", "A", "cs", "support", const(10), failure_prob=1.0, max_retries=2)]
    e = Engine(tiny_company(pool_headcount=1, steps=steps), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    assert len(kinds(e, K.TASK_FAILED)) == 3
    assert len(kinds(e, K.TASK_CANCELLED)) == 1
    assert not kinds(e, K.WORKFLOW_COMPLETED)


def test_rework_to_dependency():
    steps = [Step("a", "A", "cs", "support", const(10)),
             Step("b", "B", "cs", "support", const(5), depends_on=["a"],
                  failure_prob=1.0, rework_to="a", max_retries=1)]
    e = Engine(tiny_company(pool_headcount=1, steps=steps), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    by_step = lambda step, kind: [x for x in e.events if x.step_id == step and x.kind == kind]  # noqa: E731
    assert [x.task_id for x in by_step("a", K.TASK_COMPLETED)] == ["w-000001:a:0"] * 2
    assert [x.task_id for x in by_step("b", K.TASK_FAILED)] == ["w-000001:b:0", "w-000001:b:1"]
    assert [x.task_id for x in by_step("b", K.TASK_CANCELLED)] == ["w-000001:b:1"]
    assert not kinds(e, K.WORKFLOW_COMPLETED)
