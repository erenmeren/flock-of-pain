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
    assert all(t.state == S.QUEUED for q in e.queues.values() for t in q.values())
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


def test_overnight_shift_runs_without_error():
    from flock_of_pain.schedule import Schedule
    c = tiny_company(rate_per_hour=2, pool_headcount=1)
    night = Schedule({d: (22, 30) for d in range(7)})
    for r in c.resources():
        r.schedule = night
    c.workflows[0].arrival.window = Schedule({d: (0, 24) for d in range(7)})
    e = Engine(c, RunConfig(seed=1, horizon_minutes=3 * DAY))
    e.run()
    started = [ev for ev in e.events if ev.kind == K.TASK_STARTED]
    assert started and all(night.is_on(ev.t) for ev in started)


def test_split_shift_on_off_events():
    from flock_of_pain.schedule import Schedule
    c = tiny_company(pool_headcount=1, steps=one_step())
    c.resource("e1").schedule = Schedule({0: [(9, 13), (14, 17.5)]})
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    e.run()
    shifts = [(x.t, x.kind) for x in e.events if x.resource_id == "e1"]
    assert shifts == [(540, K.RESOURCE_AVAILABLE), (780, K.RESOURCE_UNAVAILABLE),
                      (840, K.RESOURCE_AVAILABLE), (1050, K.RESOURCE_UNAVAILABLE)]


def _profile_run(seed=3):
    from flock_of_pain.model import Profile
    from flock_of_pain.schedule import Schedule
    c = tiny_company(rate_per_hour=30, steps=one_step())
    c.workflows[0].arrival.window = Schedule({d: (0, 24) for d in range(7)})
    c.workflows[0].arrival.profile = Profile({h: 2.0 if h < 12 else 0.5 for h in range(24)})
    e = Engine(c, RunConfig(seed=seed, horizon_minutes=3 * DAY))
    e.run()
    return e


def test_profile_thins_arrivals_by_hour():
    e = _profile_run()
    hours = [int(x.t // 60) % 24 for x in e.events if x.kind == K.WORKFLOW_STARTED]
    am, pm = sum(h < 12 for h in hours), sum(h >= 12 for h in hours)
    assert am > 3 * pm > 0  # expected ratio 4
    assert [x.to_json() for x in e.events] == [x.to_json() for x in _profile_run().events]


def _cutoff_run():
    c = tiny_company(pool_headcount=1, steps=one_step(30))
    c.workflows[0].cutoff_hour = 9.75
    e = Engine(c, RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60, n=3)
    assert sorted(t.due_at for q in e.queues.values() for t in q.values()) == [585, 585]
    arrive_at(e, 10 * 60)
    assert e.instances["w-000004"].due_at == DAY + 585
    e.run()
    return e


def test_deadline_missed_once_per_late_instance():
    e = _cutoff_run()
    missed = [(x.t, x.instance_id, x.workflow_id) for x in e.events if x.kind == K.DEADLINE_MISSED]
    assert missed == [(585, "w-000002", "w"), (585, "w-000003", "w")]
    assert all(x.to_json() for x in e.events)


def test_deadline_miss_rate_metric():
    from flock_of_pain.analytics import compute_metrics
    e = _cutoff_run()
    w = compute_metrics(e.events, e.company, DAY).workflows["w"]
    assert (w.started, w.deadline_missed, w.deadline_miss_rate) == (4, 2, 0.5)


def _always_on(c):
    from flock_of_pain.schedule import Schedule
    for r in c.resources():
        r.schedule = Schedule({d: (0, 24) for d in range(7)})
    c.workflows[0].arrival.window = Schedule({d: (0, 24) for d in range(7)})
    return c


def _created(e, step_id):
    return {x.instance_id for x in e.events if x.kind == K.TASK_CREATED and x.step_id == step_id}


def test_branch_chosen_at_its_probability():
    steps = [Step("a", "A", "cs", "support", const(1), branches=[("b", 0.3)]),
             Step("b", "B", "cs", "support", const(1), depends_on=["a"])]
    e = Engine(_always_on(tiny_company(rate_per_hour=30, steps=steps)), RunConfig(seed=7, horizon_minutes=2 * DAY))
    e.run()
    a_done = {x.instance_id for x in e.events if x.kind == K.TASK_COMPLETED and x.step_id == "a"}
    completed = {x.instance_id for x in e.events if x.kind == K.WORKFLOW_COMPLETED}
    assert len(a_done) > 1000
    assert 0.25 < len(_created(e, "b") & a_done) / len(a_done) < 0.35
    assert a_done - _created(e, "b") <= completed  # unchosen branch skipped, instance still completes


def test_skipped_branching_step_skips_its_targets():
    steps = [Step("a", "A", "cs", "support", const(1), branches=[("b", 0.0)]),
             Step("b", "B", "cs", "support", const(1), depends_on=["a"], branches=[("c", 1.0)]),
             Step("c", "C", "cs", "support", const(1), depends_on=["b"]),
             Step("d", "D", "cs", "support", const(1), depends_on=["c"])]
    e = Engine(_always_on(tiny_company(rate_per_hour=2, steps=steps)), RunConfig(seed=1, horizon_minutes=DAY))
    e.run()
    assert not _created(e, "b") and not _created(e, "c")
    started = {x.instance_id for x in e.events if x.kind == K.WORKFLOW_STARTED}
    assert started and _created(e, "d") == started
    assert {x.instance_id for x in e.events if x.kind == K.WORKFLOW_COMPLETED} >= started - set(e.instances)


def test_rework_into_skipped_conditional_step_activates_it():
    steps = [Step("a", "A", "cs", "support", const(1), branches=[("c", 0.0)]),
             Step("c", "C", "cs", "support", const(1), depends_on=["a"]),
             Step("f", "F", "cs", "support", const(1), depends_on=["c"], failure_prob=1.0, max_retries=1,
                  rework_to="c")]
    e = Engine(_always_on(tiny_company(steps=steps)), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 60)
    e.run()
    kinds = [x.kind for x in e.events if x.step_id == "c"]
    assert kinds[0] == K.TASK_CREATED and K.TASK_COMPLETED in kinds
    assert [x.kind for x in e.events if x.step_id == "f"].count(K.TASK_FAILED) == 2


def _wait_steps(**c_kw):
    return [Step("a", "A", "cs", "support", const(10)),
            Step("w", "Await", "cs", None, const(240), depends_on=["a"], sla_minutes=1),
            Step("c", "C", "cs", "support", const(5), depends_on=["w"], **c_kw)]


def test_wait_step_runs_with_no_resource():
    from flock_of_pain.analytics import compute_metrics
    e = Engine(tiny_company(pool_headcount=1, steps=_wait_steps()), RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60)
    e.run()
    evs = task_events(e, "w-000001:w:0")
    assert [(x.t, x.kind, x.resource_id) for x in evs] == [
        (550, K.TASK_CREATED, None), (550, K.TASK_STARTED, None), (790, K.TASK_COMPLETED, None)]
    assert first(e, K.TASK_STARTED, "w-000001:c:0").t == 790
    kinds = [x.kind for x in e.events]
    assert K.WORKFLOW_COMPLETED in kinds and K.SLA_BREACHED not in kinds
    m = compute_metrics(e.events, e.company, DAY)
    assert m.resources["e1"].busy_minutes == 15 and m.departments["cs"].tasks_completed == 2
    assert m.workflows["w"].wait_p90 == 0 and m.workflows["w"].steps_completed == 3
    assert m.ledger == []


def test_rework_into_wait_step():
    e = Engine(tiny_company(pool_headcount=1, steps=_wait_steps(failure_prob=1.0, max_retries=1, rework_to="w")),
               RunConfig(seed=1, horizon_minutes=DAY))
    arrive_at(e, 9 * 60)
    e.run()
    assert [x.t for x in task_events(e, "w-000001:w:0") if x.kind == K.TASK_STARTED] == [550, 795]


def test_release_hours_hold_until_release():
    e = Engine(tiny_company(pool_headcount=1, steps=[Step("a", "A", "cs", "support", const(10), release_hours=[12, 17])]),
               RunConfig(seed=1, horizon_minutes=2 * DAY))
    arrive_at(e, 540)
    arrive_at(e, 600)
    assert sum(getattr(f, "func", None) == e._release for _, _, f in e._heap) == 1  # one callback per release moment
    arrive_at(e, 750)
    e.run()
    q = lambda tid: [(x.t, x.reason) for x in task_events(e, tid) if x.kind == K.TASK_QUEUED]
    assert q("w-000001:a:0") == [(540, Reason.BATCH_HOLD)]
    assert q("w-000002:a:0") == [(600, Reason.BATCH_HOLD), (720, Reason.ALL_RESOURCES_BUSY)]
    assert q("w-000003:a:0") == [(750, Reason.BATCH_HOLD), (1020, Reason.OFF_SHIFT)]  # released after shift end
    assert [first(e, K.TASK_STARTED, f"w-00000{i}:a:0").t for i in (1, 2, 3)] == [720, 730, DAY + 540]


def test_patience_abandons_only_still_queued_tasks():
    from flock_of_pain.analytics import compute_metrics
    e = Engine(tiny_company(pool_headcount=1, steps=[Step("a", "A", "cs", "support", const(60), patience=const(60))]),
               RunConfig(seed=1, horizon_minutes=DAY))
    for t in (540, 560, 570):
        arrive_at(e, t)
    e.run()
    assert [(x.t, x.task_id) for x in e.events if x.kind == K.TASK_ABANDONED] == [(630, "w-000003:a:0")]
    assert first(e, K.TASK_STARTED, "w-000002:a:0").t == 600  # started before its patience ran out at 620
    assert task_events(e, "w-000003:a:0")[-1].kind == K.TASK_CANCELLED and "w-000003" not in e.instances
    w = compute_metrics(e.events, e.company, DAY).workflows["w"]
    assert (w.started, w.completed, w.abandoned, w.abandon_rate) == (3, 2, 1, 1 / 3)
