import pytest
from conftest import tiny_company

from workforce_twin.dist import const
from workforce_twin.engine import Engine, RunConfig
from workforce_twin.events import EventKind as K
from workforce_twin.events import Reason
from workforce_twin.model import (
    ArrivalSpec, BusinessSystem, Company, Department, ModelError, Resource, Step, Workflow,
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


def test_concurrent_rework_to_same_dependency():
    steps = [Step("a", "A", "cs", "support", const(10)),
             Step("b", "B", "cs", "support", const(5), depends_on=["a"],
                  failure_prob=1.0, rework_to="a", max_retries=2),
             Step("c", "C", "cs", "support", const(8), depends_on=["a"],
                  failure_prob=1.0, rework_to="a", max_retries=2)]
    e = Engine(tiny_company(pool_headcount=2, employees=0, steps=steps), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()  # c fails at 558 while a's rework runs 555-565: must not re-queue a again
    assert [x.t for x in kinds(e, K.TASK_COMPLETED) if x.step_id == "a"] == [550, 565]
    created = [x.task_id for x in kinds(e, K.TASK_CREATED)]
    assert "w-000001:b:2" in created and "w-000001:c:2" in created


def test_retry_does_not_jump_queue():
    steps = [Step("a", "A", "cs", "support", const(10), failure_prob=1.0, max_retries=1),
             Step("x", "X", "cs", "support", const(30))]
    e = Engine(tiny_company(pool_headcount=1, steps=steps), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    assert first(e, K.TASK_QUEUED, "w-000001:x:0").reason == Reason.ALL_RESOURCES_BUSY
    assert first(e, K.TASK_STARTED, "w-000001:x:0").t == 550
    a_starts = [x.t for x in e.events if x.task_id == "w-000001:a:0" and x.kind == K.TASK_STARTED]
    assert a_starts == [540, 580]


def test_queued_task_retagged_on_outage():
    steps = [Step("x", "X", "cs", "support", const(60)),
             Step("a", "A", "cs", "support", const(10), system_id="erp")]
    c = tiny_company(pool_headcount=1, steps=steps)
    c.outages = [("erp", 560, 600)]
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    queued = [x for x in e.events if x.task_id == "w-000001:a:0" and x.kind == K.TASK_QUEUED]
    assert [(x.t, x.reason) for x in queued] == [
        (540, Reason.ALL_RESOURCES_BUSY), (560, Reason.SYSTEM_DOWN), (600, Reason.ALL_RESOURCES_BUSY),
    ]
    assert (queued[1].system_id, queued[1].payload) == ("erp", {"retag": True})


def test_queued_task_retagged_at_outage_end():
    steps = [Step("x", "X", "cs", "support", const(90)),
             Step("a", "A", "cs", "support", const(10), system_id="erp")]
    c = tiny_company(pool_headcount=1, steps=steps)
    c.outages = [("erp", 560, 600)]
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    queued = [x for x in e.events if x.task_id == "w-000001:a:0" and x.kind == K.TASK_QUEUED]
    assert [(x.t, x.reason, x.system_id) for x in queued] == [
        (540, Reason.ALL_RESOURCES_BUSY, None), (560, Reason.SYSTEM_DOWN, "erp"),
        (600, Reason.ALL_RESOURCES_BUSY, None),
    ]
    assert queued[2].payload == {"retag": True}
    assert first(e, K.TASK_STARTED, "w-000001:a:0").t == 630


def test_queued_task_retagged_on_shift_change():
    c = tiny_company(pool_headcount=1, steps=[Step("x", "X", "cs", "support", const(60))])
    e = Engine(c, RunConfig(seed=1, horizon_minutes=2 * DAY))
    arrive_at(e, 990)  # 16:30, runs past 17:00
    arrive_at(e, 1015)  # 16:55, e1 busy
    e.run()
    t2 = "w-000002:x:0"
    queued = [(x.t, x.reason) for x in e.events if x.task_id == t2 and x.kind == K.TASK_QUEUED]
    assert queued == [(1015, Reason.ALL_RESOURCES_BUSY), (1020, Reason.OFF_SHIFT)]
    assert first(e, K.TASK_STARTED, t2).t == DAY + 540


def test_unresolved_company_rejected():
    c = tiny_company()
    c._index = {}
    with pytest.raises(ModelError):
        Engine(c, RunConfig(seed=1, horizon_minutes=DAY))


def test_shift_walk_survives_long_absence():
    from workforce_twin.scenario import Absence, Scenario
    c = Scenario("s", "S", tiny_company(), [Absence("e1", 1 * DAY, 16 * DAY)]).materialize()
    e = Engine(c, RunConfig(seed=1, horizon_minutes=30 * DAY))
    e.run()
    on = [x.t for x in kinds(e, K.RESOURCE_AVAILABLE) if x.resource_id == "e1"]
    assert on[0] == 540 and any(t > 16 * DAY for t in on)
    assert all(not DAY <= t < 16 * DAY for t in on)


def test_rework_then_success():
    steps = [Step("a", "A", "cs", "support", const(10)),
             Step("b", "B", "cs", "support", const(5), depends_on=["a"],
                  failure_prob=0.5, rework_to="a", max_retries=3)]
    for seed in range(51):
        e = Engine(tiny_company(pool_headcount=1, steps=steps), RunConfig(seed=seed, horizon_minutes=DAY))
        arrive_at(e, 540)
        e.run()
        if len(kinds(e, K.TASK_FAILED)) == 1 and len(kinds(e, K.WORKFLOW_COMPLETED)) == 1:
            break
    else:
        pytest.fail("no seed in 0..50 gives exactly one failure then success")
    b_tasks = [x.task_id for x in kinds(e, K.TASK_CREATED) if x.step_id == "b"]
    assert b_tasks == ["w-000001:b:0", "w-000001:b:1"]
    assert len([x for x in kinds(e, K.TASK_COMPLETED) if x.step_id == "a"]) == 2


@pytest.mark.parametrize("outage", [("crm", 600, 700), ("erp", 700, 700)])
def test_invalid_outage_rejected(outage):
    c = tiny_company()
    c.outages = [outage]
    with pytest.raises(ModelError):
        Engine(c, RunConfig(seed=1, horizon_minutes=DAY))


def test_blocked_twice_completes_on_time():
    c = tiny_company(pool_headcount=1, steps=[Step("a", "A", "cs", "support", const(60), system_id="erp")])
    c.outages = [("erp", 560, 600), ("erp", 620, 650)]
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 540)
    e.run()
    assert [x.t for x in e.events if x.kind == K.TASK_BLOCKED] == [560, 620]
    assert first(e, K.TASK_COMPLETED, "w-000001:a:0").t == 670
    assert e.busy_minutes["e1"] == 60
