import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from flock_of_pain.api import app
from flock_of_pain.experiment import KPI_KEYS

client = TestClient(app)


def test_example():
    r = client.get("/example"); assert r.status_code == 200
    body = r.json(); assert body["company"]["id"] == "reynolds" and len(body["scenarios"]) == 4


def test_simulate_roundtrip():
    ex = client.get("/example").json()
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:2],
                                       "config": {"seed": 42, "days": 1, "replications": 2}})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["disclaimer"].startswith("All parameters are assumed values")
    assert b["kpi_keys"][: len(KPI_KEYS)] == list(KPI_KEYS)
    assert all(k.startswith("util_") for k in b["kpi_keys"][len(KPI_KEYS):])
    s = b["scenarios"][0]
    assert set(s["summary"]["cycle_p90"]) == {"mean", "p10", "p50", "p90"}
    assert len(s["runs"]) == 2 and "events" not in s["runs"][0]
    assert isinstance(s["off_shift_minutes"], float)
    assert all(set(row) == {"department_id", "reason", "blocker_id", "minutes", "count"} for row in s["ledger"])


def test_simulate_with_events():
    ex = client.get("/example").json()
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:1],
                                       "config": {"seed": 1, "days": 1}, "include_events": True})
    assert r.json()["scenarios"][0]["runs"][0]["events"][0]["kind"]


def test_schema_error_422():
    ex = client.get("/example").json()
    ex["company"]["departments"][0]["resources"][0]["skills"] = "x"
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": [], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 422 and r.json()["path"] == "departments[0].resources[0].skills"


def test_model_error_422():
    ex = client.get("/example").json()
    ex["company"]["workflows"][0]["steps"][0]["department_id"] = "nope"
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": [], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 422 and r.json()["path"] is None and "nope" in r.json()["message"]


@pytest.mark.parametrize("config,n,events", [({"seed": 1, "days": 365, "replications": 50}, 4, False),
                                             ({"seed": 1, "days": 31}, 1, True)])
def test_run_budget_422(config, n, events):
    ex = client.get("/example").json()
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:n], "config": config,
                                       "include_events": events})
    assert r.status_code == 422 and r.json()["path"] == "config"
