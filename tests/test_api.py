import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from flock_of_pain.api import app
from flock_of_pain.experiment import KPI_KEYS

client = TestClient(app)


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))


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
    assert r.status_code == 422 and r.json()["path"] == "company.departments[0].resources[0].skills"


def test_model_error_422():
    ex = client.get("/example").json()
    ex["company"]["workflows"][0]["steps"][0]["department_id"] = "nope"
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": [], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 422 and r.json()["path"] is None and "nope" in r.json()["message"]


@pytest.mark.parametrize("config,n,events", [({"seed": 1, "days": 365, "replications": 50}, 4, False),
                                             ({"seed": 1, "days": 31}, 1, True),
                                             ({"seed": 1, "days": 0.001, "replications": 1000}, 1, False)])
def test_run_budget_422(config, n, events):
    ex = client.get("/example").json()
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:n], "config": config,
                                       "include_events": events})
    assert r.status_code == 422 and r.json()["path"] == "config"


def _post(**patch):
    ex = client.get("/example").json()
    body = {"company": ex["company"], "scenarios": ex["scenarios"][:1], "config": {"seed": 1, "days": 1}, **patch}
    return client.post("/simulate", json=body)


def test_fastapi_native_422():
    r = _post(config="x")
    assert r.status_code == 422 and "detail" in r.json()


def test_config_schema_error_path():
    r = _post(config={"seed": 1, "days": "x"})
    assert r.status_code == 422 and r.json()["path"] == "config.days"


def test_scenario_schema_error_path():
    r = _post(scenarios=[{"id": "x", "name": "x", "overlays": [{"type": "nope"}]}])
    assert r.status_code == 422 and r.json()["path"] == "scenarios[0].overlays[0].type"


def test_scenario_model_error_path():
    ok = client.get("/example").json()["scenarios"][0]
    bad = {"id": "bad", "name": "bad", "overlays": [{"type": "remove_resource", "resource_id": "nope"}]}
    r = _post(scenarios=[ok, bad])
    assert r.status_code == 422 and r.json()["path"] == "scenarios[1]" and "nope" in r.json()["message"]


def test_duplicate_scenario_ids_422():
    s = client.get("/example").json()["scenarios"][0]
    r = _post(scenarios=[s, s])
    assert r.status_code == 422 and r.json()["path"] == "scenarios"


def test_generate_endpoint(monkeypatch):
    import json
    from flock_of_pain import agent
    ex = client.get("/example").json()
    monkeypatch.setattr(agent, "_ask", lambda messages: json.dumps(ex))
    r = client.post("/generate", json={"prompt": "a small bakery"})
    assert r.status_code == 200 and r.json() == ex


def test_generate_empty_prompt_422():
    assert client.post("/generate", json={"prompt": ""}).status_code == 422


def test_generate_502(monkeypatch):
    from flock_of_pain import agent
    monkeypatch.setattr(agent, "_ask", lambda messages: "not json")
    r = client.post("/generate", json={"prompt": "x"})
    assert r.status_code == 502 and r.json()["path"] is None and "not JSON" in r.json()["message"]


def test_company_store_endpoints():
    ex = client.get("/example").json()
    assert client.get("/companies").json() == []
    r = client.put("/companies/reynolds", json=ex)
    assert r.status_code == 200 and r.json()["id"] == "reynolds"
    assert [c["id"] for c in client.get("/companies").json()] == ["reynolds"]
    assert client.get("/companies/reynolds").json() == ex  # stored in canonical form
    assert client.put("/companies/other", json=ex).status_code == 422
    assert client.put("/companies/other", json=ex).json()["path"] == "company.id"
    bad = {**ex, "scenarios": [{"id": "x", "name": "x", "overlays": [{"type": "nope"}]}]}
    assert client.put("/companies/reynolds", json=bad).status_code == 422
    assert client.get("/companies/nope").status_code == 404
    assert client.delete("/companies/reynolds").status_code == 200
    assert client.delete("/companies/reynolds").status_code == 404


def test_simulate_save_and_run_endpoints():
    ex = client.get("/example").json()
    body = {"company": ex["company"], "scenarios": ex["scenarios"][:1], "config": {"seed": 1, "days": 1},
            "include_events": True, "save": True, "company_id": "reynolds"}
    r = client.post("/simulate", json=body)
    assert r.status_code == 200 and r.json()["run_id"] == 1 and "events" in r.json()["scenarios"][0]["runs"][0]
    runs = client.get("/runs", params={"company_id": "reynolds"}).json()
    assert [x["id"] for x in runs] == [1] and runs[0]["name"] == "Reynolds"
    assert client.get("/runs", params={"company_id": "other"}).json() == []
    run = client.get("/runs/1").json()
    assert run["request"]["config"] == {"seed": 1, "days": 1} and run["request"]["company"] == ex["company"]
    assert run["result"]["kpi_keys"] == r.json()["kpi_keys"] and "events" not in run["result"]["scenarios"][0]["runs"][0]
    assert client.get("/runs/2").status_code == 404
    r2 = client.post("/simulate", json={**body, "save": False})
    assert "run_id" not in r2.json()
