import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from flock_of_pain.api import app
from flock_of_pain.experiment import KPI_KEYS

client = TestClient(app)


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    from flock_of_pain import store
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    client.headers["X-API-Key"] = store.create_tenant("t1", "Tenant 1")
    yield
    del client.headers["X-API-Key"]


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
    odd = {**ex, "company": {**ex["company"], "id": "a/b"}}
    assert client.put("/companies/a%2Fb", json=odd).status_code in (404, 405, 422)  # never a stored company with a slash
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
    assert run["request"]["config"] == {"seed": 1, "days": 1.0, "replications": 1, "policy": "priority"}
    assert run["request"]["company"] == ex["company"]
    assert client.get("/runs", params={"limit": 0}).json() == runs and client.get("/runs", params={"limit": 10000}).status_code == 200
    assert run["result"]["kpi_keys"] == r.json()["kpi_keys"] and "events" not in run["result"]["scenarios"][0]["runs"][0]
    assert client.get("/runs/2").status_code == 404
    r2 = client.post("/simulate", json={**body, "save": False})
    assert "run_id" not in r2.json()


def test_auth_required_except_example():
    from flock_of_pain import store
    ex = client.get("/example", headers={"X-API-Key": ""}).json()
    assert ex["company"]["id"] == "reynolds"
    body = {"company": ex["company"], "scenarios": [], "config": {"seed": 1, "days": 1}}
    for key in ("", "fop_wrong"):
        r = client.post("/simulate", json=body, headers={"X-API-Key": key})
        assert r.status_code == 401 and r.json()["message"].startswith("missing or unknown")
        assert client.get("/companies", headers={"X-API-Key": key}).status_code == 401
        assert client.post("/generate", json={"prompt": "x"}, headers={"X-API-Key": key}).status_code == 401
    r = client.post("/simulate", json=body, headers={})  # fixture key still set on the client
    assert r.status_code == 200
    # a second tenant sees none of the first tenant's data
    client.put("/companies/reynolds", json=ex)
    client.post("/simulate", json={**body, "save": True, "company_id": "reynolds"})
    other = store.create_tenant("t2", "Tenant 2")
    assert client.get("/companies", headers={"X-API-Key": other}).json() == []
    assert client.get("/runs", headers={"X-API-Key": other}).json() == []
    assert client.get("/runs/1", headers={"X-API-Key": other}).status_code == 404
    assert client.get("/companies/reynolds", headers={"X-API-Key": other}).status_code == 404
    assert client.get("/runs/1").status_code == 200


def test_put_draft_company_then_simulate_422():
    ex = client.get("/example").json()
    ex["company"]["workflows"][0]["steps"][0]["department_id"] = ""
    r = client.put("/companies/reynolds", json=ex)
    assert r.status_code == 200, r.text
    assert client.get("/companies/reynolds").json()["company"]["workflows"][0]["steps"][0]["department_id"] == ""
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 422 and "department_id" in r.json()["message"]


def test_simulate_with_inflows():
    ex = client.get("/example").json()
    w = ex["company"]["workflows"][0]
    first = w["steps"][0]["id"]
    del w["arrival"]
    w["inflows"] = [{"id": "phone", "name": "Phone", "rate_per_hour": 2, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": [first]},
                    {"id": "web", "name": "Web", "rate_per_hour": 2, "window": {"weekday_hours": {"0": [9, 17]}}, "entry": [first]}]
    w["layout"] = {"phone": [0, 0]}
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:1], "config": {"seed": 1, "days": 1}})
    assert r.status_code == 200, r.text
    r = client.put("/companies/reynolds", json=ex)
    assert r.status_code == 200, r.text
    assert client.get("/companies/reynolds").json()["company"]["workflows"][0]["layout"] == {"phone": [0, 0]}


def test_generate_daily_quota_429(monkeypatch):
    import json
    from flock_of_pain import agent
    ex = client.get("/example").json()
    monkeypatch.setattr(agent, "_ask", lambda messages: json.dumps(ex))
    monkeypatch.setenv("FLOCK_GENERATE_DAILY_LIMIT", "2")
    assert [client.post("/generate", json={"prompt": "x"}).status_code for _ in range(3)] == [200, 200, 429]
    r = client.post("/generate", json={"prompt": "x"})
    assert r.json()["path"] is None and "limit of 2" in r.json()["message"]
    # another tenant has its own counter
    from flock_of_pain import store
    r = client.post("/generate", json={"prompt": "x"}, headers={"X-API-Key": store.create_tenant("t2", "t2")})
    assert r.status_code == 200


def test_signup(monkeypatch):
    del client.headers["X-API-Key"]
    try:
        assert client.post("/signup", json={"id": "new", "invite": "x"}).status_code == 404  # disabled without a code
        monkeypatch.setenv("FLOCK_SIGNUP_CODE", "open-sesame")
        assert client.post("/signup", json={"id": "new", "invite": "nope"}).status_code == 401
        assert client.post("/signup", json={"id": "bad id", "invite": "open-sesame"}).status_code == 422
        r = client.post("/signup", json={"id": "new", "invite": "open-sesame"})
        assert r.status_code == 200 and r.json()["id"] == "new" and r.json()["key"].startswith("fop_")
        assert client.get("/companies", headers={"X-API-Key": r.json()["key"]}).status_code == 200
        assert client.post("/signup", json={"id": "new", "invite": "open-sesame"}).status_code == 409
    finally:
        client.headers["X-API-Key"] = "x"  # the fixture deletes it on teardown
