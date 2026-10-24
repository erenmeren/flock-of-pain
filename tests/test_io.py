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


def test_metrics_to_dict_is_json():
    c = reynolds.build(); e = Engine(c, RunConfig(seed=1, horizon_minutes=1440)); e.run()
    from flock_of_pain.analytics import compute_metrics
    d = metrics_to_dict(compute_metrics(e.events, c, 1440))
    json.dumps(d)
    assert all(isinstance(r["reason"], (str, type(None))) for r in d["ledger"])
