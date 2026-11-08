import time

import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from conftest import tiny_company
from flock_of_pain import jobs, optimize, store
from flock_of_pain.agent import load_bundle
from flock_of_pain.api import app
from flock_of_pain.dist import const
from flock_of_pain.engine import RunConfig
from flock_of_pain.experiment import run_experiment
from flock_of_pain.io import SchemaError, company_to_dict, run_config_from_dict, scenario_from_dict
from flock_of_pain.model import ArrivalSpec, BusinessSystem, Company, Department, Resource, Step, Workflow
from flock_of_pain.scenario import AddEmployee, Scenario
from flock_of_pain.schedule import business_hours

client = TestClient(app)
PW = "correct horse battery"
BASE = {"id": "base", "name": "Base", "overlays": []}
CFG = {"seed": 1, "days": 1, "replications": 2}
FAR = {"kpi": "cycle_p90", "op": "<=", "value": 0.001}  # never met
UTIL = {"kpi": "util_ops", "op": "<=", "value": 0.0001}  # never met, and every Operations hire improves it


def company(ops_cost=20.0, idle_cost=30.0, extra=()):
    """Operations and Billing are both overloaded; the Idle team never gets work."""
    s = business_hours(9, 17)
    c = Company("c", "C", [
        Department("ops", "Operations", [Resource("o1", "ops", {"do"}, cost_per_hour=ops_cost, schedule=s), *extra]),
        Department("bill", "Billing", [Resource("b1", "bill", {"bill"}, cost_per_hour=40.0, schedule=s)]),
        Department("idle", "Idle", [Resource("i1", "idle", {"other"}, cost_per_hour=idle_cost, schedule=s)]),
        Department("empty", "Empty", []),
    ], [BusinessSystem("erp", "ERP")], [Workflow("w", "W", [
        Step("a", "A", "ops", "do", const(30)),
        Step("b", "B", "bill", "bill", const(20), depends_on=["a"]),
    ], ArrivalSpec(4, business_hours(9, 17)))])
    c.resolve()
    return c


def plan(c=None, target=FAR, candidates=None, max_hires=2, scenarios=(BASE,), base_id=None, config=CFG, run_days=2000, runs=400):
    c = c or company()
    return optimize.plan(c, [scenario_from_dict(s, c) for s in scenarios], run_config_from_dict(config), target, candidates,
                         max_hires, base_id, run_days, runs)


def body(**patch):
    return {"company": company_to_dict(company()), "scenarios": [BASE], "config": CFG, "target": FAR, "max_hires": 1, **patch}


def finish(jid, h):
    end = time.monotonic() + 30
    while time.monotonic() < end:
        j = client.get(f"/jobs/{jid}", headers=h).json()
        if j["status"] not in jobs.ACTIVE:
            return j
        time.sleep(0.01)
    raise AssertionError("deadline passed")


@pytest.fixture(autouse=True)
def h(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    monkeypatch.setattr(store, "SCRYPT_N", 16)
    yield {"X-API-Key": store.create_tenant("t1", "Tenant 1")}
    end = time.monotonic() + 30
    while time.monotonic() < end and any(j.status in jobs.ACTIVE for j in jobs._jobs.values()):
        time.sleep(0.01)
    jobs._jobs.clear()


def test_path_and_shape_when_the_target_is_met():
    p = plan(target={"kpi": "throughput_per_day", "op": ">=", "value": 0.1}, config={"seed": 1, "days": 2, "replications": 2})
    assert p.config.crn is True
    base = run_experiment("b", p.base, p.config, keep_events=False).summary["throughput_per_day"]
    target = {"kpi": "throughput_per_day", "op": ">=", "value": base.mean + 1}
    out = optimize.run(plan(target=target, config={"seed": 1, "days": 2, "replications": 2}, candidates=["ops", "bill"], max_hires=6))
    assert set(out) == {"met", "stopped", "hires", "scenario", "path"}
    assert out["met"] is True and out["stopped"] == "met"
    assert out["path"][0]["hires"] == {} and out["path"][0]["mean"] == pytest.approx(base.mean)
    assert all(set(e) == {"hires", "mean", "ci_low", "ci_high", "labor_cost"} for e in out["path"])
    assert sum(out["path"][-1]["hires"].values()) == len(out["path"]) - 1
    assert out["hires"] == out["path"][-1]["hires"]
    assert out["path"][-1]["ci_low"] >= target["value"]  # the pessimistic bound, not only the mean
    assert all(e["ci_low"] < target["value"] for e in out["path"][:-1])
    assert out["path"][-1]["labor_cost"] > 0


def test_lower_is_better_uses_ci_high():
    first = optimize.run(plan(candidates=["ops"], max_hires=1, config={"seed": 1, "days": 2, "replications": 3}))
    hired = first["path"][1]
    assert hired["ci_low"] < hired["ci_high"]  # the bounds differ, so the test can tell them apart
    between = (hired["mean"] + hired["ci_high"]) / 2
    out = optimize.run(plan(target={"kpi": "cycle_p90", "op": "<=", "value": between}, candidates=["ops"], max_hires=1,
                            config={"seed": 1, "days": 2, "replications": 3}))
    assert out["path"][1]["mean"] <= between < out["path"][1]["ci_high"] and out["met"] is False
    out = optimize.run(plan(target={"kpi": "cycle_p90", "op": "<=", "value": hired["ci_high"]}, candidates=["ops"], max_hires=1,
                            config={"seed": 1, "days": 2, "replications": 3}))
    assert out["met"] is True


def test_base_already_meets_target():
    out = optimize.run(plan(target={"kpi": "cycle_p90", "op": "<=", "value": 1e9}))
    assert out["met"] is True and out["stopped"] == "met" and out["hires"] == {} and len(out["path"]) == 1
    assert out["path"][0]["hires"] == {}


def test_no_improvement():
    out = optimize.run(plan(candidates=["idle"]))
    assert out["met"] is False and out["stopped"] == "no_improvement" and out["hires"] == {} and len(out["path"]) == 1


def test_max_hires():
    out = optimize.run(plan(max_hires=1, candidates=["ops", "bill"]))
    assert out["stopped"] == "max_hires" and out["met"] is False and sum(out["hires"].values()) == 1 and len(out["path"]) == 2


def test_budget_stops_before_exceeding_run_days():
    runs = []
    p = plan(candidates=["ops", "bill"], max_hires=5, config={"seed": 1, "days": 2, "replications": 2}, run_days=20)  # 10 runs: base + 2 rounds
    assert p.total == 10
    out = optimize.run(p, lambda: runs.append(1))
    assert out["stopped"] == "budget" and len(runs) == 10 and len(runs) * 2 <= 20 and sum(out["hires"].values()) == 2


def test_budget_also_caps_runs():
    p = plan(candidates=["ops", "bill"], max_hires=50, config={"seed": 1, "days": 0.01, "replications": 2}, runs=10)
    assert p.budget == 10 and p.total == 10


def pair_company():
    """Operations and Billing work in series at the same pace, so a hire in only one of them moves nothing."""
    s = business_hours(9, 17)
    c = Company("c", "C", [
        Department("ops", "Operations", [Resource("o1", "ops", {"do"}, cost_per_hour=20.0, schedule=s)]),
        Department("bill", "Billing", [Resource("b1", "bill", {"bill"}, cost_per_hour=40.0, schedule=s)]),
    ], [], [Workflow("w", "W", [
        Step("a", "A", "ops", "do", const(30)),
        Step("b", "B", "bill", "bill", const(30), depends_on=["a"]),
    ], ArrivalSpec(20, business_hours(9, 17)))])
    c.resolve()
    return c


MORE = {"kpi": "throughput_per_day", "op": ">=", "value": 1e9}  # never met


def test_pair_step_when_two_departments_must_both_grow():
    c, cfg = pair_company(), {"seed": 1, "days": 1, "replications": 2}
    base = run_experiment("b", plan(c, config=cfg).base, plan(c, config=cfg).config, keep_events=False).summary["throughput_per_day"].mean
    runs = []
    p = plan(c, target=MORE, max_hires=2, config=cfg)
    out = optimize.run(p, lambda: runs.append(1))
    assert out["hires"] == {"ops": 1, "bill": 1} and out["stopped"] == "max_hires"
    assert [e["hires"] for e in out["path"]] == [{}, {"ops": 1, "bill": 1}]  # one path entry for the pair
    assert out["path"][1]["mean"] > base
    assert len(runs) == 2 * (1 + 2 + 3) <= p.total  # base, the singles, then the pairs (ops+ops, ops+bill, bill+bill)
    ids = [o["employee"]["id"] for o in out["scenario"]["overlays"]]
    assert sorted(ids) == ["bill_hire_1", "ops_hire_1"]


def test_pair_step_respects_max_hires_and_budget():
    c, cfg = pair_company(), {"seed": 1, "days": 1, "replications": 2}
    out = optimize.run(plan(c, target=MORE, max_hires=1, config=cfg))
    assert out["stopped"] == "max_hires" and out["hires"] == {} and len(out["path"]) == 1  # a pair would pass max_hires
    runs = []
    p = plan(c, target=MORE, max_hires=5, config=cfg, run_days=10)  # base + singles fit, the pairs do not
    out = optimize.run(p, lambda: runs.append(1))
    assert out["stopped"] == "budget" and out["hires"] == {} and len(runs) == 6 <= p.total
    assert optimize.run(plan(c, target=MORE, max_hires=5, config=cfg, run_days=12))["hires"] == {"ops": 1, "bill": 1}


def test_warmup_counts_towards_the_budget():
    with pytest.raises(SchemaError) as e:
        plan(candidates=["ops"], config={"seed": 1, "days": 1, "replications": 2, "warmup_days": 1}, run_days=6)
    assert e.value.path == "config" and "run-days" in e.value.message


def test_budget_for_no_round_is_refused_up_front():
    with pytest.raises(SchemaError) as e:
        plan(candidates=["ops"], run_days=1)
    assert e.value.path == "config"


def test_zero_cost_hire_ranks_best_without_dividing_by_zero():
    c = company(ops_cost=0.0)
    out = optimize.run(plan(c, candidates=["bill", "ops"], max_hires=1))
    assert out["hires"] == {"ops": 1}


def test_best_improvement_per_cost_wins():
    target = {"kpi": "mean_dept_utilization", "op": "<=", "value": 0.0001}  # any busy department's hire improves it
    out = optimize.run(plan(company(ops_cost=1000000.0), target=target, candidates=["ops", "bill"], max_hires=1))
    assert out["hires"] == {"bill": 1}


def test_deterministic():
    assert optimize.run(plan(candidates=["ops", "bill"])) == optimize.run(plan(candidates=["ops", "bill"]))


def test_default_candidates_skip_departments_without_resources():
    assert plan().candidates == ["ops", "bill", "idle"]
    assert plan(candidates=["ops", "ops"]).candidates == ["ops"]


def hire(out):
    return [o for o in out["scenario"]["overlays"] if o["type"] == "add_employee"][-1]["employee"]


def test_pool_first_resource_hires_one_employee_not_a_second_pool():
    s = business_hours(9, 17)
    c = Company("c", "C", [Department("ops", "Operations", [
        Resource("pool", "ops", {"do"}, cost_per_hour=25.0, schedule=s, headcount=3, overtime_rate=1.5),
        Resource("p1", "ops", {"do"}, pool_id="pool"),
    ])], [], [Workflow("w", "W", [Step("a", "A", "ops", "do", const(30))], ArrivalSpec(30, business_hours(9, 17)))])
    c.resolve()
    out = optimize.run(plan(c, candidates=["ops"], max_hires=1))
    e = hire(out)
    assert out["hires"] == {"ops": 1}
    assert e["skills"] == ["do"] and e["cost_per_hour"] == 25.0 and e["overtime_rate"] == 1.5
    assert e["schedule"]["weekday_hours"]["0"] == [9, 17]
    assert "headcount" not in e and "pool_id" not in e
    made = scenario_from_dict(out["scenario"], c).materialize()
    assert made.resource(e["id"]).capacity == 1
    assert made.resource("pool").capacity == 2  # the pool is unchanged


def test_carved_first_resource_gets_the_pool_schedule_and_overtime():
    s = business_hours(8, 12)
    c = Company("c", "C", [Department("ops", "Operations", [
        Resource("p1", "ops", {"do"}, cost_per_hour=9.0, pool_id="pool"),
        Resource("pool", "ops", {"do"}, cost_per_hour=25.0, schedule=s, headcount=2, overtime_rate=2.0),
    ])], [], [Workflow("w", "W", [Step("a", "A", "ops", "do", const(30))], ArrivalSpec(30, business_hours(8, 12)))])
    c.resolve()
    e = hire(optimize.run(plan(c, candidates=["ops"], max_hires=1)))
    assert e["cost_per_hour"] == 9.0 and e["overtime_rate"] == 2.0 and e["schedule"]["weekday_hours"]["0"] == [8, 12]
    assert "pool_id" not in e


def test_a_personal_absence_is_not_copied():
    c = company()
    scenario = {"id": "base", "name": "Base", "overlays": [{"type": "absence", "resource_id": "o1", "start": 0, "end": 60}]}
    out = optimize.run(plan(c, target=UTIL, candidates=["ops"], max_hires=1, scenarios=[scenario]))
    assert "absences" not in hire(out)["schedule"] and out["scenario"]["overlays"][0]["type"] == "absence"


def test_employee_and_scenario_ids_do_not_collide():
    s = business_hours(9, 17)
    c = company(extra=[Resource("ops_hire_1", "ops", {"do"}, schedule=s)])
    taken = [{"id": "optimized", "name": "Taken", "overlays": []}, {**BASE, "id": "optimized_2"}, BASE]
    out = optimize.run(plan(c, target=UTIL, candidates=["ops"], max_hires=2, base_id="base", scenarios=taken))
    ids = [o["employee"]["id"] for o in out["scenario"]["overlays"]]
    assert out["scenario"]["id"] == "optimized_3"
    assert len(ids) == len(set(ids)) == 2 and "ops_hire_1" not in ids and "o1" not in ids


def test_base_scenario_overlays_kept_and_removed_first_resource_respected():
    c = company()
    s = business_hours(9, 17)
    keep = AddEmployee("ops", Resource("o9", "ops", {"do"}, cost_per_hour=5.0, schedule=s))
    from flock_of_pain.io import scenario_to_dict
    extra = scenario_to_dict(Scenario("x", "X", c, [keep]))
    removal = {"id": "gone", "name": "Gone", "overlays": [{"type": "remove_resource", "resource_id": "b1"}]}
    out = optimize.run(plan(c, target=UTIL, candidates=["ops"], max_hires=1, scenarios=[BASE, extra], base_id="x"))
    assert out["scenario"]["overlays"][0]["employee"]["id"] == "o9" and len(out["scenario"]["overlays"]) == 2
    # with the only Billing resource removed, Billing has nobody to copy from in that scenario
    with pytest.raises(SchemaError) as e:
        plan(c, scenarios=[removal], candidates=["bill"])
    assert e.value.path == "candidates[0]"
    assert "bill" not in plan(c, scenarios=[removal]).candidates


# --- through the API ------------------------------------------------------

def test_scenario_runs_through_simulate(h):
    r = client.post("/optimize", json=body(max_hires=2, candidates=["ops", "bill"]), headers=h)
    assert r.status_code == 202 and set(r.json()) == {"id"}
    j = finish(r.json()["id"], h)
    assert j["kind"] == "optimize" and j["status"] == "done" and j["done"] == j["total"] and j["total"] == 16  # an upper bound
    out = j["result"]
    assert sum(out["hires"].values()) == 2
    sim = client.post("/simulate", json={"company": body()["company"], "scenarios": [BASE, out["scenario"]], "config": {**CFG, "crn": True}},
                      headers=h)
    assert sim.status_code == 200, sim.text
    scenarios = sim.json()["scenarios"]
    assert scenarios[1]["id"] == "optimized"
    assert scenarios[1]["summary"]["cycle_p90"]["mean"] == pytest.approx(out["path"][-1]["mean"])
    assert scenarios[1]["summary"]["labor_cost"]["mean"] == pytest.approx(out["path"][-1]["labor_cost"])
    assert load_bundle(body()["company"], [out["scenario"]])


def test_include_events_is_ignored(h):
    assert finish(client.post("/optimize", json=body(include_events=True, candidates=["ops"]), headers=h).json()["id"], h)["status"] == "done"


@pytest.mark.parametrize("patch,path", [
    ({"target": {"kpi": "nope", "op": "<=", "value": 1}}, "target.kpi"),
    ({"target": {"kpi": "util_nope", "op": "<=", "value": 1}}, "target.kpi"),
    ({"target": {"kpi": "cycle_p90", "op": "<", "value": 1}}, "target.op"),
    ({"target": {"kpi": "cycle_p90", "op": "<=", "value": "x"}}, "target.value"),
    ({"target": {"kpi": "cycle_p90", "op": "<="}}, "target.value"),
    ({"target": {"kpi": "cycle_p90", "op": "<=", "value": 1, "more": 1}}, "target.more"),
    ({"candidates": ["nope"]}, "candidates[0]"),
    ({"candidates": ["ops", "empty"]}, "candidates[1]"),
    ({"candidates": []}, "candidates"),
    ({"max_hires": 0}, "max_hires"),
    ({"max_hires": 51}, "max_hires"),
    ({"base_scenario_id": "nope"}, "base_scenario_id"),
    ({"scenarios": []}, "scenarios"),
    ({"config": {"seed": 1, "days": "x"}}, "config.days"),
    ({"config": {"seed": 1, "days": 1000, "replications": 2}}, "config"),
])
def test_validation_422_before_a_job_exists(h, patch, path):
    r = client.post("/optimize", json=body(**patch), headers=h)
    assert r.status_code == 422 and r.json()["path"] == path, r.text
    assert jobs._jobs == {}


def test_util_kpi_is_accepted(h):
    b = body(target={"kpi": "util_ops", "op": "<=", "value": 0.0001}, candidates=["ops"])
    j = finish(client.post("/optimize", json=b, headers=h).json()["id"], h)
    assert j["status"] == "done" and j["result"]["hires"] == {"ops": 1}


def test_viewer_may_optimize_tenant_isolation_and_cap(h, monkeypatch):
    store.create_user("t1", "v@x.io", PW, "viewer")
    viewer = {"Authorization": f"Bearer {store.login('v@x.io', PW)['token']}"}
    jid = client.post("/optimize", json=body(candidates=["ops"]), headers=viewer)
    assert jid.status_code == 202
    other = {"X-API-Key": store.create_tenant("t2", "t2")}
    assert client.get(f"/jobs/{jid.json()['id']}", headers=other).status_code == 404
    finish(jid.json()["id"], h)
    monkeypatch.setattr(jobs, "MAX_JOBS", 0)
    assert client.post("/optimize", json=body(), headers=h).status_code == 429


def test_cancel_optimize(h, monkeypatch):
    real = optimize.run_experiment
    calls = []

    def slow(*a, **kw):
        calls.append(1)
        if len(calls) == 1:
            end = time.monotonic() + 20
            while time.monotonic() < end and not any(j.cancel for j in jobs._jobs.values()):
                time.sleep(0.005)
        return real(*a, **kw)

    monkeypatch.setattr(optimize, "run_experiment", slow)
    jid = client.post("/optimize", json=body(max_hires=5), headers=h).json()["id"]
    client.delete(f"/jobs/{jid}", headers=h)
    j = finish(jid, h)
    assert j["status"] == "cancelled" and "result" not in j and len(calls) <= 1  # 0 if cancelled while queued


def test_one_replication_is_refused():
    with pytest.raises(SchemaError) as e:
        plan(config={"seed": 1, "days": 1, "replications": 1})
    assert e.value.path == "config.replications"


def test_new_hire_works_at_the_speed_of_the_department():
    c = tiny_company()
    source = c.departments[0].resources[0]
    source.speed_factor = 0.5
    assert optimize._template(source, {}).speed_factor == 0.5
