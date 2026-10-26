import json
from pathlib import Path
import pytest
from flock_of_pain.io import SchemaError, company_from_dict, company_to_dict, dist_from_dict, load_company
from flock_of_pain.dist import lognormal_mean, lognormal
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.examples import reynolds
from flock_of_pain.model import ModelError

EXAMPLE = Path(reynolds.__file__).with_name("reynolds.json")

def test_lognormal_mean_matches_old_helper():
    from math import log
    assert lognormal_mean(12, 0.4) == lognormal(log(12) - 0.4 * 0.4 / 2, 0.4)

def test_dist_shorthand():
    assert dist_from_dict({"kind": "lognormal_mean", "mean": 12, "sigma": 0.4}, "d") == lognormal_mean(12, 0.4)
    with pytest.raises(SchemaError) as e:
        dist_from_dict({"kind": "weird", "a": 1}, "steps[0].duration")
    assert e.value.path == "steps[0].duration.kind"

def test_round_trip_example_is_stable():
    d = json.loads(EXAMPLE.read_text())
    assert company_to_dict(company_from_dict(d)) == d
    assert company_to_dict(reynolds.build()) == d

def test_round_trip_preserves_event_log():
    base = reynolds.build()
    def log(c):
        e = Engine(c, RunConfig(seed=42, horizon_minutes=3 * 1440)); e.run()
        return [ev.to_json() for ev in e.events]
    loaded = company_from_dict(company_to_dict(base))
    assert log(loaded) == log(base)

def test_unknown_key_path():
    d = company_to_dict(reynolds.build())
    d["departments"][0]["resources"][1]["bogus"] = 1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "departments[0].resources[1].bogus"

def test_skills_must_be_list():
    d = company_to_dict(reynolds.build())
    d["departments"][0]["resources"][1]["skills"] = "erp_entry"
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "departments[0].resources[1].skills"

def test_missing_required_key():
    d = company_to_dict(reynolds.build())
    del d["workflows"][0]["steps"][0]["department_id"]
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].steps[0].department_id"

def test_semantic_error_comes_from_resolve():
    d = company_to_dict(reynolds.build())
    d["workflows"][0]["steps"][0]["department_id"] = "nope"
    with pytest.raises(ModelError) as e:
        company_from_dict(d)
    assert not isinstance(e.value, SchemaError)

def test_carved_employee_inherits_and_exports_null():
    d = company_to_dict(reynolds.build())
    emp = next(r for r in d["departments"][0]["resources"] if r.get("pool_id") == "cs_pool" and r.get("schedule") is None)
    c = company_from_dict(d)
    assert c.resource(emp["id"]).schedule is c.resource("cs_pool").schedule
    assert next(r for r in company_to_dict(c)["departments"][0]["resources"] if r["id"] == emp["id"])["schedule"] is None

def test_load_company(tmp_path):
    p = tmp_path / "c.json"; p.write_text(EXAMPLE.read_text())
    assert load_company(p).id == reynolds.build().id


def test_lognormal_mean_nonpositive_is_schema_error():
    with pytest.raises(SchemaError) as e:
        dist_from_dict({"kind": "lognormal_mean", "mean": 0}, "d")
    assert e.value.path == "d.mean"
    with pytest.raises(SchemaError) as e:
        dist_from_dict({"kind": "lognormal_mean", "mean": 5, "sigma": 0}, "d")
    assert e.value.path == "d.sigma"


def test_step_depends_on_is_copied():
    d = json.loads(EXAMPLE.read_text())
    deps = ["a"]
    d["workflows"][0]["steps"][0]["depends_on"] = deps
    try:
        company_from_dict(d)
    except ModelError:
        pass  # unknown dep id is fine; only aliasing matters
    from flock_of_pain.io import _step_from_dict
    s = _step_from_dict(dict(d["workflows"][0]["steps"][0]), "s")
    assert s.depends_on == deps and s.depends_on is not deps


from flock_of_pain.io import scenario_from_dict, scenario_to_dict, run_config_from_dict, metrics_to_dict


def test_scenario_round_trip():
    base = reynolds.build()
    for s in reynolds.scenarios(base):
        d = scenario_to_dict(s)
        s2 = scenario_from_dict(d, base)
        assert scenario_to_dict(s2) == d
        assert s2.materialize() == s.materialize()


def test_scenario_unknown_type_path():
    with pytest.raises(SchemaError) as e:
        scenario_from_dict({"id": "x", "name": "x", "overlays": [{"type": "nope"}]}, reynolds.build())
    assert e.value.path == "overlays[0].type"


def test_run_config():
    c = run_config_from_dict({"seed": 7, "days": 2, "replications": 3, "policy": "fifo"})
    assert (c.seed, c.horizon_minutes, c.replications, c.policy) == (7, 2880, 3, "fifo")
    with pytest.raises(SchemaError) as e:
        run_config_from_dict({"seed": 7, "days": 2, "policy": "lifo"})
    assert e.value.path == "policy"


@pytest.mark.parametrize("bad,path", [({"days": 0}, "days"), ({"days": 1, "replications": 0}, "replications")])
def test_run_config_ranges(bad, path):
    with pytest.raises(SchemaError) as e:
        run_config_from_dict({"seed": 1, **bad})
    assert e.value.path == path


def test_metrics_to_dict_is_json():
    c = reynolds.build(); e = Engine(c, RunConfig(seed=1, horizon_minutes=1440)); e.run()
    from flock_of_pain.analytics import compute_metrics
    d = metrics_to_dict(compute_metrics(e.events, c, 1440))
    json.dumps(d)
    assert all(isinstance(r["reason"], (str, type(None))) for r in d["ledger"])


@pytest.mark.parametrize("v", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_number_is_schema_error(v):
    with pytest.raises(SchemaError) as e:
        dist_from_dict({"kind": "const", "a": v}, "d")
    assert (e.value.path, e.value.message) == ("d.a", "must be finite")


def _res(**kw):
    return {"departments": [{"resources": [{"id": "r", "skills": [], **kw}]}]}


@pytest.mark.parametrize("patch,path", [
    ({"speed_factor": 0}, "departments[0].resources[0].speed_factor"),
    ({"speed_factor": -1}, "departments[0].resources[0].speed_factor"),
    ({"headcount": -1}, "departments[0].resources[0].headcount"),
    ({"cost_per_hour": -1}, "departments[0].resources[0].cost_per_hour"),
    ({"schedule": {"weekday_hours": {"0": [17, 9]}}}, "departments[0].resources[0].schedule.weekday_hours.0"),
    ({"schedule": {"weekday_hours": {"0": [-1, 9]}}}, "departments[0].resources[0].schedule.weekday_hours.0"),
    ({"schedule": {"weekday_hours": {"0": [24, 30]}}}, "departments[0].resources[0].schedule.weekday_hours.0"),
    ({"schedule": {"weekday_hours": {"0": [2, 30]}}}, "departments[0].resources[0].schedule.weekday_hours.0"),
])
def test_resource_ranges(patch, path):
    d = company_to_dict(reynolds.build())
    d["departments"][0]["resources"][0].update(patch)
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == path


def test_overnight_message_and_ok():
    d = company_to_dict(reynolds.build())
    d["departments"][0]["resources"][0]["schedule"] = {"weekday_hours": {"0": [22, 6]}}
    with pytest.raises(SchemaError, match=r"\[22, 30\]"):
        company_from_dict(d)
    d["departments"][0]["resources"][0]["schedule"] = {"weekday_hours": {"0": [22, 30]}}
    company_from_dict(d)


def test_arrival_rate_range():
    d = company_to_dict(reynolds.build())
    d["workflows"][0]["arrival"]["rate_per_hour"] = -1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].arrival.rate_per_hour"


@pytest.mark.parametrize("dist,key", [
    ({"kind": "exponential", "a": 0}, "a"), ({"kind": "uniform", "a": 2, "b": 1}, "b"),
    ({"kind": "triangular", "a": 2, "b": 1, "c": 3}, "b"), ({"kind": "triangular", "a": 1, "b": 3, "c": 2}, "c"),
    ({"kind": "lognormal", "a": 1, "b": -0.1}, "b"), ({"kind": "lognormal", "a": 900, "b": 0.4}, "a"),
])
def test_dist_ranges(dist, key):
    with pytest.raises(SchemaError) as e:
        dist_from_dict(dist, "d")
    assert e.value.path == f"d.{key}"


def test_dist_ranges_ok():
    for d in ({"kind": "uniform", "a": 1, "b": 1}, {"kind": "triangular", "a": 1, "b": 2, "c": 3},
              {"kind": "lognormal", "a": 2, "b": 0}, {"kind": "exponential", "a": 0.5}):
        dist_from_dict(d, "d")


def _inflow_company():
    d = company_to_dict(reynolds.build())
    w = d["workflows"][0]
    first = w["steps"][0]["id"]
    del w["arrival"]
    w["inflows"] = [
        {"id": "phone", "name": "Phone", "rate_per_hour": 3, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": [first]},
        {"id": "web", "name": "Website", "rate_per_hour": 10, "window": {"weekday_hours": {"0": [0, 24]}}, "entry": [first]},
    ]
    w["layout"] = {"phone": [40, 60], first: [260, 60]}
    return d

def test_inflows_and_layout_round_trip():
    d = _inflow_company()
    assert company_to_dict(company_from_dict(d)) == d

def test_unknown_layout_key_dropped():
    d = _inflow_company()
    d["workflows"][0]["layout"]["ghost"] = [1, 2]
    assert "ghost" not in company_to_dict(company_from_dict(d))["workflows"][0]["layout"]

def test_inflow_rate_range_and_unknown_key():
    d = _inflow_company()
    d["workflows"][0]["inflows"][0]["rate_per_hour"] = -1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].inflows[0].rate_per_hour"
    d = _inflow_company()
    d["workflows"][0]["inflows"][1]["bogus"] = 1
    with pytest.raises(SchemaError) as e:
        company_from_dict(d)
    assert e.value.path == "workflows[0].inflows[1].bogus"

def test_arrival_and_inflows_both_is_error():
    d = _inflow_company()
    d["workflows"][0]["arrival"] = {"rate_per_hour": 1, "window": {"weekday_hours": {"0": [9, 17]}}}
    with pytest.raises(ModelError, match="not both"):
        company_from_dict(d)

def test_inflow_unknown_entry_rejected_in_both_modes():
    d = _inflow_company()
    d["workflows"][0]["inflows"][0]["entry"] = ["nope"]
    for draft in (False, True):
        with pytest.raises(ModelError, match="nope"):
            company_from_dict(d, draft=draft)

def test_inflow_id_must_not_clash_with_step_id():
    d = _inflow_company()
    d["workflows"][0]["inflows"][0]["id"] = d["workflows"][0]["steps"][0]["id"]
    with pytest.raises(ModelError, match="clashes"):
        company_from_dict(d)

@pytest.mark.parametrize("patch", [
    lambda w: w["steps"][0].__setitem__("department_id", ""),
    lambda w: w["steps"][0].__setitem__("required_skill", ""),
    lambda w: w["inflows"][0].__setitem__("entry", []),
])
def test_draft_accepts_what_strict_rejects(patch):
    d = _inflow_company()
    patch(d["workflows"][0])
    with pytest.raises(ModelError):
        company_from_dict(d)
    assert company_to_dict(company_from_dict(d, draft=True)) == d

def test_draft_accepts_workflow_without_entries():
    d = _inflow_company()
    d["workflows"][0]["inflows"] = []
    del d["workflows"][0]["layout"]
    with pytest.raises(ModelError, match="arrival or inflows"):
        company_from_dict(d)
    assert company_to_dict(company_from_dict(d, draft=True)) == d

def test_empty_required_skill_rejected_in_arrival_form():
    d = company_to_dict(reynolds.build())
    d["workflows"][0]["steps"][0]["required_skill"] = ""
    with pytest.raises(ModelError, match="required_skill"):
        company_from_dict(d)
    company_from_dict(d, draft=True)
