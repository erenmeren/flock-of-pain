"""Decision-tools spec, section 1: pooled percentiles, CI, comparison, warm-up, backlog, holidays, actuals, progress."""
import math
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace

import pytest

from conftest import tiny_company
from flock_of_pain import experiment
from flock_of_pain.analytics import Metrics, compute_metrics
from flock_of_pain.dist import const
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.events import Event, EventKind as K, Reason
from flock_of_pain.examples import reynolds
from flock_of_pain.experiment import (ExperimentResult, RunResult, _stat, compare, compare_to_base, kpis, run_experiment,
                                      top_ledger)
from flock_of_pain.io import (SchemaError, company_from_dict, company_to_dict, run_config_from_dict, run_config_to_dict)
from flock_of_pain.model import ArrivalSpec, Inflow, Profile, Resource, Step, Workflow
from flock_of_pain.scenario import AddEmployee, Scenario, expand_inflows
from flock_of_pain.schedule import Schedule, business_hours

DAY = 1440
ALWAYS = {d: (0, 24) for d in range(7)}


def wf(t, kind, inst, workflow="w"):
    return Event(t, kind, instance_id=inst, workflow_id=workflow)


def task(t, kind, inst="i", resource_id=None, reason=None, system_id=None):
    return Event(t, kind, f"{inst}:a:0", inst, "w", "a", "cs", resource_id, system_id, reason)


def one_step(minutes=10):
    return [Step("a", "A", "cs", "support", const(minutes))]


def starts(events):
    return [e.t for e in events if e.kind == K.WORKFLOW_STARTED]


def run(c, days=3, **cfg):
    e = Engine(c, RunConfig(seed=7, horizon_minutes=days * DAY, **cfg))
    e.run()
    return e


# --- pooled percentiles ---

def test_kpi_percentiles_are_pooled_across_workflows():
    events = []
    for i, (name, cycle) in enumerate([("w", 10), ("w", 10), ("w", 10), ("w", 10), ("x", 100)]):
        events += [wf(0, K.WORKFLOW_STARTED, f"i{i}", name), wf(cycle, K.WORKFLOW_COMPLETED, f"i{i}", name)]
    m = compute_metrics(events, tiny_company(), DAY)
    assert (m.cycle_p50, m.cycle_p90) == (10, 100)  # the old weighted mean gave 28 for both
    assert (m.workflows["w"].cycle_p90, m.workflows["x"].cycle_p90) == (10, 100)  # per workflow unchanged
    assert (kpis(m)["cycle_p50"], kpis(m)["cycle_p90"]) == (10, 100)


def test_wait_p90_pooled_and_counted_without_completions():
    events = [task(0, K.TASK_QUEUED, "i1"), task(30, K.TASK_STARTED, "i1", "e1"),
              task(0, K.TASK_QUEUED, "i2")]  # i2 still queued at the horizon
    m = compute_metrics(sorted(events, key=lambda e: e.t), tiny_company(), 100)
    assert m.wait_p90 == 100 and kpis(m)["wait_p90"] == 100
    assert kpis(m)["cycle_p90"] == 0


# --- confidence interval ---

def test_stat_ci_t_interval():
    s = _stat([11, 12, 13])
    half = 4.303 / math.sqrt(3)
    assert (s.mean, s.p10, s.p50, s.p90) == (12, 11, 12, 13)
    assert (s.ci_low, s.ci_high) == (pytest.approx(12 - half), pytest.approx(12 + half))


@pytest.mark.parametrize("xs", [[5.0], [5.0, 5.0, 5.0]])
def test_stat_ci_collapses_to_the_mean(xs):
    s = _stat(xs)
    assert s.ci_low == s.ci_high == s.mean == 5


def test_stat_ci_many_replications():
    xs = [float(i % 2) for i in range(41)]  # df = 40, t = 2.021
    s = _stat(xs)
    assert s.ci_high - s.mean == pytest.approx(2.021 * 0.5062 / math.sqrt(41), abs=1e-3)


def test_run_experiment_summary_has_ci():
    res = run_experiment("s", Scenario("s", "S", tiny_company(rate_per_hour=4)),
                         RunConfig(seed=1, horizon_minutes=2 * DAY, replications=3), keep_events=False)
    s = res.summary["throughput_per_day"]
    assert s.ci_low <= s.mean <= s.ci_high


# --- comparison ---

def _costs(*values, **extra):
    return ExperimentResult("x", [RunResult(i, [], Metrics(DAY, labor_cost=v, **extra)) for i, v in enumerate(values)], {})


def test_compare_to_base_paired_and_significant():
    # unpaired, these overlap heavily; paired, the difference is steady
    c = compare_to_base(_costs(10, 20, 30), _costs(12, 23, 34))["labor_cost"]
    half = 4.303 / math.sqrt(3)
    assert c["delta"] == pytest.approx(3)
    assert (c["ci_low"], c["ci_high"]) == (pytest.approx(3 - half), pytest.approx(3 + half))
    assert c["significant"] is True


def test_compare_to_base_within_noise():
    c = compare_to_base(_costs(10, 10, 10), _costs(5, 15, 11))["labor_cost"]
    assert c["ci_low"] < 0 < c["ci_high"] and c["significant"] is False


def test_compare_to_base_negative_delta_is_significant():
    assert compare_to_base(_costs(12, 23, 34), _costs(10, 20, 30))["labor_cost"]["significant"] is True


def test_compare_to_base_single_pair():
    c = compare_to_base(_costs(10), _costs(12))["labor_cost"]
    assert c == {"delta": 2, "ci_low": 2, "ci_high": 2, "significant": False}


def test_compare_to_base_identical_and_empty():
    assert compare_to_base(_costs(1, 2), _costs(1, 2))["labor_cost"]["significant"] is False
    assert compare_to_base(_costs(), _costs()) == {}


def test_compare_to_base_kpi_missing_on_one_side_counts_as_zero():
    from flock_of_pain.analytics import DeptMetrics
    a, b = _costs(1, 1, departments={"cs": DeptMetrics(utilization=0.5)}), _costs(1, 1)
    assert compare_to_base(a, b)["util_cs"]["delta"] == -0.5
    assert compare_to_base(b, a)["util_cs"]["delta"] == 0.5


# --- warm-up: run config ---

def test_warmup_config_round_trip():
    c = run_config_from_dict({"seed": 1, "days": 2, "warmup_days": 1})
    assert (c.horizon_minutes, c.warmup_minutes) == (3 * DAY, DAY)
    assert run_config_to_dict(c) == {"seed": 1, "days": 2, "replications": 1, "policy": "priority", "warmup_days": 1}
    assert run_config_to_dict(run_config_from_dict({"seed": 1, "days": 0.1, "warmup_days": 2}))["days"] == 0.1


def test_warmup_config_default_and_validation():
    c = run_config_from_dict({"seed": 1, "days": 2})
    assert c.warmup_minutes == 0 and "warmup_days" not in run_config_to_dict(c)
    assert run_config_from_dict({"seed": 1, "days": 2, "warmup_days": 0}).horizon_minutes == 2 * DAY
    for bad in (-1, "1", True, None):
        with pytest.raises(SchemaError) as e:
            run_config_from_dict({"seed": 1, "days": 2, "warmup_days": bad})
        assert e.value.path == "warmup_days"


# --- warm-up: metrics ---

def test_warmup_excludes_early_instances_from_workflow_metrics():
    events = [
        wf(5, K.WORKFLOW_STARTED, "early"), task(5, K.TASK_QUEUED, "early"), task(8, K.TASK_STARTED, "early", "e1"),
        wf(10, K.WORKFLOW_STARTED, "late"), task(10, K.TASK_QUEUED, "late"), task(14, K.TASK_STARTED, "late", "e2"),
        task(30, K.TASK_COMPLETED, "early", "e1"), wf(30, K.WORKFLOW_COMPLETED, "early"),
        task(40, K.TASK_COMPLETED, "late", "e2"), wf(40, K.WORKFLOW_COMPLETED, "late"),
    ]
    c = tiny_company(employees=2)
    c.resource("e1").cost_per_hour = 60.0
    c.resource("e2").cost_per_hour = 60.0
    m = compute_metrics(events, c, DAY, 10)
    w = m.workflows["w"]
    assert (w.started, w.completed, w.steps_completed, w.cycle_p50, w.wait_p50) == (1, 1, 1, 30, 4)
    assert (m.cycle_p50, m.wait_p90) == (30, 4)
    assert w.cost_per_completed == 26  # the late instance's run only
    assert m.departments["cs"].wait_p50 == 4


def test_warmup_clips_busy_and_ledger_and_labor():
    events = [
        task(0, K.TASK_QUEUED, "i", reason=Reason.OFF_SHIFT),  # 0-15, 5 in the window
        task(15, K.TASK_STARTED, "i", "e1"),  # 15-25: all in the window
        task(25, K.TASK_COMPLETED, "i", "e1"),
        task(0, K.TASK_QUEUED, "j", reason=Reason.ALL_RESOURCES_BUSY),  # 0-5, before the window
        task(5, K.TASK_STARTED, "j", "e2"),  # 5-12, 2 in the window
        task(12, K.TASK_COMPLETED, "j", "e2"),
        task(1, K.TASK_STARTED, "k", "e3"),  # 1-3: before the window; its completion is not counted
        task(3, K.TASK_COMPLETED, "k", "e3"),
    ]
    c = tiny_company(employees=3)
    for r in c.resources():
        r.schedule = Schedule(ALWAYS)
        r.cost_per_hour = 60.0
    m = compute_metrics(sorted(events, key=lambda e: e.t), c, 100, 10)
    assert m.horizon_minutes == 90
    assert [(x.reason, x.minutes, x.count) for x in m.ledger] == [(Reason.OFF_SHIFT, 5, 1)]
    assert (m.resources["e1"].busy_minutes, m.resources["e2"].busy_minutes, m.resources["e3"].busy_minutes) == (10, 2, 0)
    assert (m.resources["e1"].tasks_completed, m.resources["e2"].tasks_completed, m.resources["e3"].tasks_completed) == (1, 1, 0)
    assert m.resources["e1"].on_shift_minutes == 90
    assert m.resources["e1"].utilization == pytest.approx(10 / 90)
    assert m.labor_cost == 12


def test_warmup_clips_blocked_time():
    events = [task(2, K.TASK_STARTED, "i", "e1"), task(4, K.TASK_BLOCKED, "i", "e1", system_id="erp"),
              task(20, K.TASK_UNBLOCKED, "i", system_id="erp"), task(20, K.TASK_STARTED, "i", "e1"),
              task(30, K.TASK_COMPLETED, "i", "e1")]
    m = compute_metrics(events, tiny_company(), 100, 10)
    assert m.resources["e1"].blocked_minutes == 10
    assert [(x.reason, x.minutes) for x in m.ledger] == [(Reason.SYSTEM_DOWN, 10)]
    assert m.resources["e1"].busy_minutes == 10


def test_warmup_backlog_ignores_queue_gone_before_the_window():
    events = [task(0, K.TASK_QUEUED, "a"), task(0, K.TASK_QUEUED, "b"), task(1, K.TASK_STARTED, "a", "e1"),
              task(1, K.TASK_STARTED, "b", "e1"), task(5, K.TASK_QUEUED, "c"), task(11, K.TASK_STARTED, "c", "e1")]
    assert compute_metrics(events, tiny_company(), 100).departments["cs"].backlog_max == 2
    assert compute_metrics(events, tiny_company(), 100, 10).departments["cs"].backlog_max == 1  # c crosses into the window


def test_warmup_rates_use_the_measured_window():
    c = Scenario("s", "S", tiny_company(rate_per_hour=4))
    cfg = RunConfig(seed=1, horizon_minutes=4 * DAY, warmup_minutes=2 * DAY)
    res = run_experiment("s", c, cfg, keep_events=True)
    m = res.runs[0].metrics
    w = m.workflows["w"]
    assert m.horizon_minutes == 2 * DAY
    assert w.throughput_per_day == w.completed / 2
    assert all(0 < r.utilization <= 1 for r in m.resources.values() if r.busy_minutes)
    assert m.resources["e1"].on_shift_minutes == 2 * 8 * 60
    assert 0 < w.started < sum(e.kind == K.WORKFLOW_STARTED for e in res.runs[0].events)
    # the engine simulates the same thing with or without a warm-up: it only moves where measuring starts
    plain = Engine(tiny_company(rate_per_hour=4), RunConfig(seed=1, horizon_minutes=4 * DAY))
    plain.run()
    assert res.runs[0].events == plain.events


def test_warmup_longer_than_arrivals_gives_zero_kpis():
    base = tiny_company(rate_per_hour=4)
    base.workflows[0].arrival.window = Schedule({d: (9, 17) for d in range(7)}, [(DAY, 100 * DAY)])
    res = run_experiment("s", Scenario("s", "S", base), RunConfig(seed=1, horizon_minutes=3 * DAY, warmup_minutes=2 * DAY))
    k = kpis(res.runs[0].metrics)
    assert res.runs[0].metrics.workflows["w"].started == 0
    assert (k["throughput_per_day"], k["completion_rate"], k["cycle_p50"], k["wait_p90"], k["sla_breach_rate"]) == (0, 0, 0, 0, 0)
    assert res.summary["cycle_p50"].ci_low == 0
    assert compare([res]) and top_ledger(res) == []


def test_warmup_zero_matches_no_warmup_exactly():
    s = Scenario("b", "b", reynolds.build())
    cfg = RunConfig(seed=42, horizon_minutes=3 * DAY)
    assert (run_experiment("b", s, cfg).runs[0].metrics == run_experiment("b", s, replace(cfg, warmup_minutes=0)).runs[0].metrics)


# --- initial backlog ---

def test_initial_backlog_creates_instances_at_zero():
    c = tiny_company(pool_headcount=1, employees=0, steps=one_step())
    c.workflows[0].arrival.initial_backlog = 3
    e = run(c, days=1)
    assert starts(e.events) == [0, 0, 0]
    done = [x.t for x in e.events if x.kind == K.WORKFLOW_COMPLETED]
    assert done == [9 * 60 + 10, 9 * 60 + 20, 9 * 60 + 30]  # they wait for the shift, then one by one


def test_initial_backlog_with_inflows_each_gets_its_own():
    c = tiny_company(steps=one_step())
    w = c.workflows[0]
    w.arrival = None
    w.inflows = [Inflow("p", "P", 0, business_hours(9, 17), ["a"], initial_backlog=2),
                 Inflow("q", "Q", 0, business_hours(9, 17), ["a"], initial_backlog=1)]
    m = Scenario("s", "S", c).materialize()
    assert [(x.id, x.arrival.initial_backlog) for x in m.workflows] == [("w.p", 2), ("w.q", 1)]
    e = Engine(m, RunConfig(seed=1, horizon_minutes=DAY))
    e.run()
    assert sorted(x.workflow_id for x in e.events if x.kind == K.WORKFLOW_STARTED) == ["w.p", "w.p", "w.q"]


def test_initial_backlog_keeps_later_arrivals_under_crn():
    a, b = tiny_company(rate_per_hour=2), tiny_company(rate_per_hour=2)
    b.workflows[0].arrival.initial_backlog = 4
    ta, tb = starts(run(a, crn=True).events), starts(run(b, crn=True).events)
    assert tb[:4] == [0, 0, 0, 0] and tb[4:] == ta and ta


def test_initial_backlog_in_warmup_is_not_measured_but_loads_the_staff():
    c = tiny_company(pool_headcount=1, employees=0, steps=one_step(60))
    c.workflows[0].arrival.initial_backlog = 20  # 20 hours of work: 2.5 eight-hour days
    res = run_experiment("s", Scenario("s", "S", c), RunConfig(seed=1, horizon_minutes=3 * DAY, warmup_minutes=DAY))
    m = res.runs[0].metrics
    assert m.workflows["w"].started == 0 and m.workflows["w"].completed == 0
    assert m.resources["cs_pool"].busy_minutes == 12 * 60  # day 0 clears 8 of the 20 hours, inside the warm-up


def _doc(**extra):
    c = tiny_company(rate_per_hour=1, steps=one_step())
    return {**company_to_dict(c), **extra}


def test_initial_backlog_round_trip_and_validation():
    d = _doc()
    assert "initial_backlog" not in d["workflows"][0]["arrival"]
    d["workflows"][0]["arrival"]["initial_backlog"] = 7
    c = company_from_dict(d)
    assert c.workflows[0].arrival.initial_backlog == 7
    assert company_to_dict(c)["workflows"][0]["arrival"]["initial_backlog"] == 7
    assert company_to_dict(company_from_dict(d, draft=True))["workflows"][0]["arrival"]["initial_backlog"] == 7
    for bad in (-1, 1.5, True, "3", 10 ** 9):
        d["workflows"][0]["arrival"]["initial_backlog"] = bad
        with pytest.raises(SchemaError) as e:
            company_from_dict(d)
        assert e.value.path == "workflows[0].arrival.initial_backlog"


def test_initial_backlog_on_inflow_round_trip_and_validation():
    d = _doc()
    a = d["workflows"][0].pop("arrival")
    d["workflows"][0]["inflows"] = [{"id": "p", "name": "P", **a, "entry": ["a"], "initial_backlog": 2}]
    c = company_from_dict(d)
    assert c.workflows[0].inflows[0].initial_backlog == 2
    assert company_to_dict(c)["workflows"][0]["inflows"][0]["initial_backlog"] == 2
    d["workflows"][0]["inflows"][0]["initial_backlog"] = -1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].inflows[0].initial_backlog"


# --- holidays ---

def _holiday(c, *days):
    c.holidays = list(days)
    c.resolve()
    return c


def _on_day(events, kinds, day):
    return [e for e in events if e.kind in kinds and e.t // DAY == day]


def test_holiday_no_arrivals_no_work():
    c = _holiday(tiny_company(rate_per_hour=6), 1)
    e = run(c)
    assert not _on_day(e.events, (K.WORKFLOW_STARTED, K.TASK_STARTED, K.RESOURCE_AVAILABLE), 1)
    assert _on_day(e.events, (K.WORKFLOW_STARTED,), 0) and _on_day(e.events, (K.WORKFLOW_STARTED,), 2)
    assert compute_metrics(e.events, c, 3 * DAY).resources["e1"].on_shift_minutes == 2 * 8 * 60


def test_holiday_with_profile_thinning():
    c = tiny_company(rate_per_hour=6)
    c.workflows[0].arrival.profile = Profile(hours={10: 3.0}, weekdays={1: 2.0})
    assert _on_day(run(c).events, (K.WORKFLOW_STARTED,), 1)  # day 1 is the busiest day
    assert not _on_day(run(_holiday(c, 1)).events, (K.WORKFLOW_STARTED,), 1)


def test_holiday_overnight_shift_is_cut_at_both_midnights():
    s = Schedule({d: (22, 30) for d in range(7)}, closed=[(DAY, 2 * DAY)])
    assert s.is_on(DAY - 1) and not s.is_on(DAY) and not s.is_on(DAY + 23 * 60)  # day 0's shift ends at midnight
    assert s.is_on(2 * DAY + 1)  # the tail of the holiday's own night falls on the next day
    assert s.next_off(23 * 60) == DAY
    assert s.on_minutes(DAY, 2 * DAY) == 0


def test_holiday_work_under_way_overruns_on_overnight_shift():
    c = tiny_company(pool_headcount=1, employees=0, steps=one_step(120))
    c.resource("cs_pool").schedule = Schedule({d: (22, 30) for d in range(7)})
    c.workflows[0].arrival.initial_backlog = 1
    _holiday(c, 0)
    e = run(c)
    started = next(x for x in e.events if x.kind == K.TASK_STARTED)
    assert started.t == DAY  # the tail of day 0's night shift
    assert not _on_day(e.events, (K.TASK_STARTED,), 0)

    c = tiny_company(pool_headcount=1, employees=0, steps=one_step(120))
    c.resource("cs_pool").schedule = Schedule({d: (22, 30) for d in range(7)})
    c.workflows[0].arrival.window = Schedule({0: (23, 24)})
    c.workflows[0].arrival.rate_per_hour = 600
    _holiday(c, 1)
    e = run(c)
    run_start = next(x for x in e.events if x.kind == K.TASK_STARTED)
    done = next(x for x in e.events if x.kind == K.TASK_COMPLETED)
    assert run_start.t < DAY and done.t == run_start.t + 120 > DAY  # finishes into the holiday, past the shift end
    assert run_start.payload["overrun"] > 0


def test_holiday_with_split_shift():
    s = Schedule({d: [(9, 13), (14, 17)] for d in range(7)}, closed=[(DAY, 2 * DAY)])
    assert s.on_minutes(0, DAY) == 7 * 60 and s.on_minutes(DAY, 2 * DAY) == 0 and s.on_minutes(2 * DAY, 3 * DAY) == 7 * 60
    assert s.next_on(DAY) == 2 * DAY + 9 * 60


def test_holiday_with_release_hours_waits_for_next_shift():
    c = tiny_company(rate_per_hour=20, steps=[Step("a", "A", "cs", "support", const(5), release_hours=[8])])
    _holiday(c, 1)
    e = run(c)
    started = [x.t for x in e.events if x.kind == K.TASK_STARTED]
    assert started and not any(t // DAY == 1 for t in started)
    held = [x for x in e.events if x.kind == K.TASK_QUEUED and x.reason == Reason.BATCH_HOLD]
    assert any(x.t // DAY == 0 for x in held)  # held for 08:00 on the holiday, then off shift until day 2


def test_holiday_on_day_zero_keeps_the_initial_backlog():
    c = tiny_company(pool_headcount=1, employees=0, steps=one_step())
    c.workflows[0].arrival.initial_backlog = 2
    _holiday(c, 0)
    e = run(c)
    assert starts(e.events) == [0, 0]
    assert next(x.t for x in e.events if x.kind == K.TASK_STARTED) == DAY + 9 * 60


def test_holiday_run_longer_than_the_lookahead_does_not_end_arrivals_or_shifts():
    c = _holiday(tiny_company(rate_per_hour=6), *range(30))
    e = run(c, days=32)
    assert starts(e.events) and min(starts(e.events)) >= 30 * DAY
    assert any(x.kind == K.RESOURCE_AVAILABLE and x.t // DAY in (30, 31) for x in e.events)


def test_holiday_applies_to_scenario_employee_and_inflow_windows():
    c = tiny_company(rate_per_hour=6, steps=one_step())
    w = c.workflows[0]
    w.inflows, w.arrival = [Inflow("p", "P", 6, business_hours(9, 17), ["a"])], None
    c.holidays = [1]
    extra = AddEmployee("cs", Resource("new", "cs", {"support"}, schedule=business_hours(9, 17)))
    m = Scenario("s", "S", c, [extra]).materialize()
    assert m.resource("new").schedule.on_minutes(DAY, 2 * DAY) == 0
    assert not m.workflows[0].arrival.window.is_on(DAY + 10 * 60)


def test_holiday_outside_horizon_changes_nothing():
    plain, far = run(tiny_company(rate_per_hour=4)), run(_holiday(tiny_company(rate_per_hour=4), 100))
    assert plain.events == far.events


def test_holidays_round_trip_and_keep_schedules_clean():
    d = _doc(holidays=[3, 1])
    c = company_from_dict(d)
    assert c.holidays == [3, 1]
    out = company_to_dict(c)
    assert out["holidays"] == [3, 1]
    assert all("absences" not in r["schedule"] for r in out["departments"][0]["resources"] if r["schedule"])
    assert out["departments"][0]["resources"][1]["schedule"] is None  # a carved employee still shares the pool's
    assert company_to_dict(company_from_dict(d, draft=True))["holidays"] == [3, 1]
    assert "holidays" not in company_to_dict(company_from_dict(_doc()))


@pytest.mark.parametrize("bad,path", [
    ([-1], "holidays[0]"), ([1, 1.5], "holidays[1]"), ([True], "holidays[0]"), (["2"], "holidays[0]"),
    ([10 ** 12], "holidays[0]"), (3, "holidays"), (list(range(400)), "holidays"),
])
def test_holidays_validation(bad, path):
    with pytest.raises(SchemaError) as e:
        company_from_dict(_doc(holidays=bad))
    assert e.value.path == path


# --- actuals ---

def test_actuals_round_trip_and_engine_ignores_them():
    d = _doc(actuals={"cycle_p90": 240, "labor_cost": 1200.5})
    c = company_from_dict(d)
    assert c.actuals == {"cycle_p90": 240, "labor_cost": 1200.5}
    assert company_to_dict(c)["actuals"] == d["actuals"]
    assert company_to_dict(company_from_dict(d, draft=True))["actuals"] == d["actuals"]
    assert "actuals" not in company_to_dict(company_from_dict(_doc()))
    assert run(c).events == run(company_from_dict(_doc())).events
    assert Scenario("s", "S", c).materialize().actuals == d["actuals"]


@pytest.mark.parametrize("bad,path", [
    ({"x": "1"}, "actuals.x"), ({"x": True}, "actuals.x"), ({"x": None}, "actuals.x"), ({"x": float("inf")}, "actuals.x"),
    ([1], "actuals"),
])
def test_actuals_validation(bad, path):
    with pytest.raises(SchemaError) as e:
        company_from_dict(_doc(actuals=bad))
    assert e.value.path == path


# --- progress and cancel ---

CFG = RunConfig(seed=1, horizon_minutes=DAY, replications=4)


def _sc():
    return Scenario("s", "S", tiny_company(rate_per_hour=2))


@pytest.mark.parametrize("cpus", [1, 2])
def test_on_run_called_once_per_replication(cpus, monkeypatch):
    monkeypatch.setattr(experiment.os, "cpu_count", lambda: cpus)
    calls = []
    res = run_experiment("s", _sc(), CFG, on_run=lambda: calls.append(1))
    assert len(calls) == 4 and len(res.runs) == 4


def test_on_run_raising_stops_single_worker_path(monkeypatch):
    monkeypatch.setattr(experiment.os, "cpu_count", lambda: 1)
    ran = []
    real = experiment._one_run
    monkeypatch.setattr(experiment, "_one_run", lambda *a: (ran.append(1), real(*a))[1])

    def stop():
        raise KeyError("cancelled")

    with pytest.raises(KeyError):
        run_experiment("s", _sc(), CFG, on_run=stop)
    assert len(ran) == 1


def test_on_run_raising_cancels_pending_replications_in_the_pool(monkeypatch):
    futures = []

    class Spy(ProcessPoolExecutor):
        def submit(self, *a, **k):
            futures.append(super().submit(*a, **k))
            return futures[-1]

    monkeypatch.setattr(experiment, "ProcessPoolExecutor", Spy)
    monkeypatch.setattr(experiment.os, "cpu_count", lambda: 2)
    calls = []

    def stop():
        calls.append(1)
        raise KeyError("cancelled")

    # many slow replications: without a cancel this test would take minutes
    cfg = RunConfig(seed=1, horizon_minutes=30 * DAY, replications=100)
    with pytest.raises(KeyError):
        run_experiment("s", Scenario("b", "b", reynolds.build()), cfg, keep_events=False, on_run=stop)
    assert len(calls) == 1
    assert len(futures) == 100 and sum(f.cancelled() for f in futures) > 80


def test_worker_failure_propagates_through_the_pool(monkeypatch):
    monkeypatch.setattr(experiment.os, "cpu_count", lambda: 2)
    bad = Scenario("s", "S", tiny_company(rate_per_hour=2), [AddEmployee("nope", Resource("n", "nope", set(), schedule=business_hours(9, 17)))])
    with pytest.raises(Exception, match="unknown department"):
        run_experiment("s", bad, CFG)


def test_interval_of_a_kpi_never_goes_below_zero():
    from flock_of_pain.experiment import _stat
    s = _stat([0.0, 0.0, 30.0])  # every KPI is a count, rate, time or cost, so a negative bound is impossible
    assert s.ci_low == 0.0 and s.ci_high > 30.0
