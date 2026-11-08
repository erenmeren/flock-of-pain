import logging
import threading
import time

import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from conftest import tiny_company
from flock_of_pain import api, jobs, store
from flock_of_pain.api import app
from flock_of_pain.io import SchemaError, company_to_dict
from flock_of_pain.model import ModelError

client = TestClient(app)
REAL_RUN = api.run_experiment
PW = "correct horse battery"


def body(scenarios=2, **patch):
    return {"company": company_to_dict(tiny_company(rate_per_hour=2)),
            "scenarios": [{"id": f"s{i}", "name": f"S{i}", "overlays": []} for i in range(scenarios)],
            "config": {"seed": 1, "days": 1}, **patch}


def wait_until(check, deadline=20.0):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.005)
    raise AssertionError("deadline passed")


def poll(job_id, headers, *statuses):
    def check():
        j = client.get(f"/jobs/{job_id}", headers=headers).json()
        return j if j["status"] in statuses else None
    return wait_until(check)


def finished(job_id, headers):
    return poll(job_id, headers, "done", "failed", "cancelled")


class Gate:
    """Replaces run_experiment: each call waits at the gate, then runs for real."""
    def __init__(self, monkeypatch, after=False):
        self.open, self.after, self.calls = threading.Event(), after, 0
        monkeypatch.setattr(api, "run_experiment", self)

    def __call__(self, *a, **kw):
        self.calls += 1
        if not self.after:
            assert self.open.wait(20)
        out = REAL_RUN(*a, **kw)
        if self.after:
            assert self.open.wait(20)
        return out


@pytest.fixture(autouse=True)
def h(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    monkeypatch.setattr(store, "SCRYPT_N", 16)
    yield {"X-API-Key": store.create_tenant("t1", "Tenant 1")}
    wait_until(lambda: not any(j.status in jobs.ACTIVE for j in jobs._jobs.values()))  # threads end before the temp DB goes
    jobs._jobs.clear()


def start(headers, **kw):
    r = client.post("/jobs", json=body(**kw), headers=headers)
    assert r.status_code == 202, r.text
    return r.json()["id"]


def test_job_matches_simulate(h):
    r = client.post("/jobs", json=body(), headers=h)
    assert r.status_code == 202 and set(r.json()) == {"id"} and len(r.json()["id"]) == 32
    j = finished(r.json()["id"], h)
    assert set(j) == {"id", "kind", "status", "done", "total", "result"}
    assert (j["kind"], j["status"], j["done"], j["total"]) == ("simulate", "done", 2, 2)
    assert j["result"] == client.post("/simulate", json=body(), headers=h).json()


def test_job_replications_counted_across_scenarios_on_a_process_pool(h):
    b = body()
    b["config"]["replications"] = 2
    j = finished(client.post("/jobs", json=b, headers=h).json()["id"], h)
    assert (j["status"], j["done"], j["total"]) == ("done", 4, 4)
    assert j["result"] == client.post("/simulate", json=b, headers=h).json()


def test_job_saves_like_simulate(h):
    j = finished(start(h, save=True, company_id="tiny", name="N"), h)
    assert j["result"]["run_id"] == 1
    run = client.get("/runs/1", headers=h).json()
    assert run["name"] == "N" and run["company_id"] == "tiny"
    assert "recommendations" in run["result"]["scenarios"][0]


def test_progress_visible_while_running(h, monkeypatch):
    gate = Gate(monkeypatch)
    jid = start(h)
    j = poll(jid, h, "running")
    assert (j["done"], j["total"]) == (0, 2) and "result" not in j
    gate.open.set()
    assert finished(jid, h)["done"] == 2


def test_cancel_running_ends_cancelled_and_stops_later_scenarios(h, monkeypatch):
    gate = Gate(monkeypatch)
    jid = start(h, save=True)
    poll(jid, h, "running")
    r = client.delete(f"/jobs/{jid}", headers=h)
    assert r.status_code == 200 and r.json()["id"] == jid and r.json()["status"] == "running"
    gate.open.set()
    j = finished(jid, h)
    assert j["status"] == "cancelled" and "result" not in j and "error" not in j and j["done"] <= j["total"]
    assert gate.calls == 1 and client.get("/runs", headers=h).json() == []


def test_cancel_after_the_last_replication_is_never_done_and_saves_nothing(h, monkeypatch):
    gate = Gate(monkeypatch, after=True)
    jid = start(h, scenarios=1, save=True)
    wait_until(lambda: client.get(f"/jobs/{jid}", headers=h).json()["done"] == 1)
    assert client.delete(f"/jobs/{jid}", headers=h).status_code == 200
    gate.open.set()
    j = finished(jid, h)
    assert j["status"] == "cancelled" and "result" not in j
    assert client.get("/runs", headers=h).json() == []


def test_cancel_while_queued(h, monkeypatch):
    held = []

    class Held:  # holds the worker back, so the job stays queued
        def __init__(self, target, args, daemon):
            assert daemon
            held.append((target, args))

        def start(self):
            pass

    monkeypatch.setattr(jobs.threading, "Thread", Held)
    jid = start(h)
    assert client.get(f"/jobs/{jid}", headers=h).json()["status"] == "queued"
    assert client.delete(f"/jobs/{jid}", headers=h).json()["status"] == "cancelled"
    target, args = held[0]
    target(*args)  # the worker starting late changes nothing
    j = client.get(f"/jobs/{jid}", headers=h).json()
    assert j["status"] == "cancelled" and j["done"] == 0 and "result" not in j


def test_cancel_finished_job_changes_nothing(h):
    jid = start(h)
    finished(jid, h)
    assert client.delete(f"/jobs/{jid}", headers=h).json()["status"] == "done"
    assert client.get(f"/jobs/{jid}", headers=h).json()["status"] == "done"


def test_tenant_isolation(h):
    other = {"X-API-Key": store.create_tenant("t2", "t2")}
    jid = start(h)
    assert client.get(f"/jobs/{jid}", headers=other).status_code == 404
    assert client.delete(f"/jobs/{jid}", headers=other).status_code == 404
    assert finished(jid, h)["status"] == "done"  # the other tenant's delete did not cancel it
    assert client.get("/jobs/nope", headers=h).status_code == 404
    assert client.delete("/jobs/nope", headers=h).status_code == 404
    assert client.get(f"/jobs/{jid}", headers={"X-API-Key": "fop_wrong"}).status_code == 401


def test_cap_429_per_tenant(h, monkeypatch):
    monkeypatch.setattr(jobs, "MAX_JOBS", 1)
    gate = Gate(monkeypatch)
    jid = start(h)
    r = client.post("/jobs", json=body(), headers=h)
    assert r.status_code == 429 and r.json()["path"] is None and "1 active" in r.json()["message"]
    other = {"X-API-Key": store.create_tenant("t2", "t2")}
    other_job = start(other)
    client.delete(f"/jobs/{jid}", headers=h)  # still counts until it has really stopped
    assert client.post("/jobs", json=body(), headers=h).status_code == 429
    gate.open.set()
    finished(jid, h), finished(other_job, other)
    assert finished(start(h), h)["status"] == "done"  # a finished job frees the slot


def test_default_cap_is_two():
    assert jobs.MAX_JOBS == 2 or "FLOCK_MAX_JOBS" in jobs.os.environ


def test_viewer(h):
    store.create_user("t1", "v@x.io", PW, "viewer")
    viewer = {"Authorization": f"Bearer {store.login('v@x.io', PW)['token']}"}
    assert client.post("/jobs", json=body(save=True), headers=viewer).status_code == 403
    assert jobs._jobs == {}
    jid = start(viewer)
    assert finished(jid, viewer)["status"] == "done"


def test_bad_input_422_before_a_job_exists(h):
    b = body()
    b["config"]["days"] = "x"
    r = client.post("/jobs", json=b, headers=h)
    assert r.status_code == 422 and r.json()["path"] == "config.days"
    b = body()
    b["config"] = {"seed": 1, "days": 365, "replications": 50}
    assert client.post("/jobs", json=b, headers=h).json()["path"] == "config"
    b = body()
    b["config"] = {"seed": 1, "days": 31}
    assert client.post("/jobs", json={**b, "include_events": True}, headers=h).status_code == 422
    assert client.post("/jobs", json={"company": {}}, headers=h).status_code == 422
    assert jobs._jobs == {}


def test_no_auth_401():
    assert client.post("/jobs", json=body()).status_code == 401


@pytest.mark.parametrize("exc,path,message", [(ModelError("bad model"), None, "bad model"),
                                              (SchemaError("config.days", "nope"), "config.days", "nope")])
def test_model_errors_keep_their_shape(h, monkeypatch, exc, path, message):
    def fail(*a, **kw):
        raise exc
    monkeypatch.setattr(api, "run_experiment", fail)
    j = finished(start(h), h)
    assert j["status"] == "failed" and j["error"] == {"path": path, "message": message} and "result" not in j


def test_unexpected_error_is_generic_and_logged(h, monkeypatch, caplog):
    def fail(*a, **kw):
        raise RuntimeError("secret /etc/path")
    monkeypatch.setattr(api, "run_experiment", fail)
    with caplog.at_level(logging.ERROR, logger="flock_of_pain.jobs"):
        j = finished(start(h), h)
    assert j["status"] == "failed" and j["error"]["path"] is None and "secret" not in j["error"]["message"]
    assert "secret" in caplog.text


def test_finished_jobs_evicted_after_an_hour(h, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(jobs, "_clock", lambda: now[0])
    jid = start(h)
    finished(jid, h)
    now[0] += jobs.TTL_SECONDS - 1
    assert client.get(f"/jobs/{jid}", headers=h).status_code == 200
    now[0] += 1
    assert client.get(f"/jobs/{jid}", headers=h).status_code == 404
    assert jid not in jobs._jobs


def test_running_job_is_not_evicted(h, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(jobs, "_clock", lambda: now[0])
    gate = Gate(monkeypatch)
    jid = start(h)
    now[0] += 10 * jobs.TTL_SECONDS
    assert client.get(f"/jobs/{jid}", headers=h).status_code == 200
    gate.open.set()
    finished(jid, h)


def test_done_never_exceeds_total():
    seen = []

    def fn(progress):
        for _ in range(5):
            progress()
            seen.append(jobs._jobs[jid].done)
        return {}

    gate = threading.Event()
    jid = jobs.submit("t", "simulate", 3, lambda p: (gate.wait(20), fn(p))[1])
    gate.set()
    wait_until(lambda: jobs.get("t", jid)["status"] == "done")
    assert seen == [1, 2, 3, 3, 3] and jobs.get("t", jid)["done"] == 3


def test_finished_job_shows_a_full_bar_when_it_ran_less_than_the_upper_bound():
    jid = jobs.submit("t", "optimize", 10, lambda p: {"x": 1})
    wait_until(lambda: jobs.get("t", jid)["status"] == "done")
    j = jobs.get("t", jid)
    assert (j["done"], j["total"], j["result"]) == (10, 10, {"x": 1})


def test_finished_jobs_capped_per_tenant(monkeypatch):
    monkeypatch.setattr(jobs, "MAX_FINISHED", 2)
    monkeypatch.setattr(jobs, "_jobs", {})
    ids = []
    for _ in range(3):
        ids.append(jobs.submit("capped", "simulate", 1, lambda progress: {}))
        wait_until(lambda: jobs.get("capped", ids[-1])["status"] == "done")
    assert jobs.get("capped", ids[0]) is None  # the oldest result is dropped, so results cannot fill the memory
    assert jobs.get("capped", ids[1]) and jobs.get("capped", ids[2])
