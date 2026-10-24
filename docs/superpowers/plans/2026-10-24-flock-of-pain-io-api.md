# Flock of Pain phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JSON contract for companies and scenarios, engine hardening, a stateless FastAPI service, and one plain Next.js page that runs experiments.

**Architecture:** `io.py` converts between JSON dicts and the existing dataclasses, calling `resolve()` for semantic validation. Engine changes keep every existing event log byte-identical (pinned hashes). `api.py` is the only module importing FastAPI and only calls `io`, `experiment` and `reynolds`. `web/` is a single Next.js page calling the API with `fetch`.

**Tech Stack:** Python 3.12+ stdlib; FastAPI + uvicorn + httpx behind the `api` extra; Next.js 15 app router, TypeScript, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-24-flock-of-pain-io-api-design.md` (sections §4–§8 are authoritative). The v0 spec `docs/superpowers/specs/2026-10-24-workforce-twin-core-design.md` describes the engine.

## Global Constraints

- Core package keeps zero runtime dependencies; only `src/flock_of_pain/api.py` imports `fastapi`.
- Engine changes must keep these seed-42, 10-day (`horizon_minutes=14400`) event-log SHA-256 hashes (joined by `"\n"` over `e.to_json()`):
  `baseline 55196c5154ef758bd8056a369f132f83e8dc006155822401d81d7ca77d71e17a`,
  `demand_plus_30 57302e42cd2377c71703d7ca52f18e57bf51781e8230893216b34b0e4dc0be2a`,
  `erp_outage_2h 40f1341b2652608457f8e6fcaa38a506c97ac0f990b25c4c5de39d8066de98a3`,
  `extra_cs_employee 24fb2c6d33e370385839d1c97edc8994df8f03d91931d49109e077fd571ced49`.
- Disclaimer string and `KPI_KEYS` come from `flock_of_pain.experiment`; never restate them.
- Tests: `uv run --extra dev pytest -q`. Slow tests use the registered `slow` marker.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Reply language for the user is Turkish; code, docs and commits are English.

## Review Focus

1. JSON with an unknown key or a `"skills"` string instead of list must raise `SchemaError` with the exact path, not `TypeError` deep inside dataclasses (Task 1 tests).
2. A carved employee with `schedule: null` must inherit the pool schedule after load (`resolve()`), and export must write `null` back, not the inherited schedule (Task 1 test).
3. `lognormal_mean` shorthand must produce the same `Dist` as the old `reynolds.lognormal_minutes` so the Reynolds hashes hold (Task 1 round-trip test).
4. Dispatch rewrite must keep tie-break order of `min` (first minimum wins) or the hashes change (Task 3 hash test).
5. API 422 body for a `ModelError` from `resolve()` (unknown department id) must carry `path: null` and the message, not a 500 (Task 5 test).

---

### Task 1: Company JSON load/export

**Files:**
- Create: `src/flock_of_pain/io.py`
- Modify: `src/flock_of_pain/dist.py` (add `lognormal_mean`), `src/flock_of_pain/examples/reynolds.py` (use it, drop `lognormal_minutes`), `tests/test_reynolds.py` if it imports `lognormal_minutes`
- Create: `src/flock_of_pain/examples/reynolds.json`
- Test: `tests/test_io.py`

**Interfaces:**
- Consumes: `Company`, `Department`, `Resource`, `BusinessSystem`, `Workflow`, `Step`, `ArrivalSpec`, `ModelError` from `model.py`; `Dist` from `dist.py`; `Schedule` from `schedule.py`.
- Produces:
  ```python
  class SchemaError(ModelError):
      def __init__(self, path: str, message: str): ...   # str(e) == f"{path}: {message}"
      path: str; message: str
  def company_from_dict(d: dict) -> Company
  def company_to_dict(c: Company) -> dict
  def load_company(path: str | os.PathLike) -> Company
  def dist_from_dict(d: dict, path: str) -> Dist
  def dist_to_dict(x: Dist) -> dict
  def schedule_from_dict(d: dict | None, path: str) -> Schedule | None
  def schedule_to_dict(s: Schedule | None) -> dict | None
  def resource_from_dict(d: dict, department_id: str, path: str) -> Resource
  def resource_to_dict(r: Resource) -> dict
  ```
  `dist.lognormal_mean(mean: float, sigma: float = 0.4) -> Dist` = `lognormal(log(mean) - sigma * sigma / 2, sigma)`.

JSON shape and rules: spec §4. Key points the implementer must apply: resource `department_id` is implied by the enclosing department; `capacity` never appears in JSON; `skills` list ↔ sorted list on export; `weekday_hours` keys are strings `"0".."6"`; absent optional fields take dataclass defaults; unknown keys, missing required keys, wrong types, unknown `kind` → `SchemaError(path, ...)`; `company_from_dict` calls `resolve()` before returning. Export order: `id, name, systems, departments, workflows, outages`; resource keys `id, name, skills, cost_per_hour, speed_factor, schedule, pool_id, headcount` with `headcount`/`pool_id` omitted when `None`, `name` omitted when `""`, `speed_factor` omitted when `1.0`; step keys in dataclass order with defaults omitted. `outages` exported as lists `[system_id, start, end]`. A carved employee whose schedule is the pool's object (`r.schedule is pool.schedule`) exports `schedule: null`.

- [ ] **Step 1: Write failing tests in `tests/test_io.py`**

```python
import json, hashlib
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
```

- [ ] **Step 2: Run `uv run --extra dev pytest tests/test_io.py -q`, expect ImportError**
- [ ] **Step 3: Add `lognormal_mean` to `dist.py`; replace `lognormal_minutes` in `reynolds.py` with it (same values); run full suite, expect green.**
- [ ] **Step 4: Implement `io.py` per Interfaces.** Approach: a tiny `_get(d, key, path, type, default=_REQUIRED)` helper does presence/type checks and raises `SchemaError(f"{path}.{key}", ...)`; after reading known keys, any leftover key raises on `f"{path}.{key}"`. Containers use `f"{path}[{i}]"`.
- [ ] **Step 5: Generate `reynolds.json`:** `uv run python -c "import json; from flock_of_pain.io import company_to_dict; from flock_of_pain.examples import reynolds; print(json.dumps(company_to_dict(reynolds.build()), indent=2))" > src/flock_of_pain/examples/reynolds.json`. Add `package-data` to `pyproject.toml` so the JSON ships: `[tool.setuptools.package-data] flock_of_pain = ["examples/*.json"]`.
- [ ] **Step 6: Run `uv run --extra dev pytest -q`, expect all green (107 + 10).**
- [ ] **Step 7: Commit** `feat: JSON load/export for Company with path-addressed SchemaError`

---

### Task 2: Scenario, RunConfig, Metrics JSON and CLI

**Files:**
- Modify: `src/flock_of_pain/io.py`, `src/flock_of_pain/cli.py`
- Test: `tests/test_io.py` (append), `tests/test_cli.py` (create)

**Interfaces:**
- Consumes: Task 1 functions; overlay classes from `scenario.py`; `RunConfig` from `engine.py`; `Metrics`, `LedgerRow` from `analytics.py`; `Reason` from `events.py`.
- Produces:
  ```python
  OVERLAY_TYPES: dict[str, type] = {"arrival_multiplier": ArrivalMultiplier, "system_outage": SystemOutage,
      "add_employee": AddEmployee, "remove_resource": RemoveResource, "set_pool_headcount": SetPoolHeadcount,
      "absence": Absence}
  def scenario_from_dict(d: dict, base: Company) -> Scenario
  def scenario_to_dict(s: Scenario) -> dict          # {"id","name","overlays":[{"type",...fields}]}
  def run_config_from_dict(d: dict) -> RunConfig     # keys seed, days, replications, policy; days -> horizon_minutes
  def metrics_to_dict(m: Metrics) -> dict            # dataclasses.asdict; Reason -> str
  ```
  `add_employee` JSON: `{"type": "add_employee", "department_id": "cs", "employee": <resource JSON>}`; the employee's `department_id` is filled from the overlay's `department_id`. Unknown `type`, bad fields, unknown policy → `SchemaError` with path like `overlays[1].type`. `policy` must be in `scheduling.POLICIES`.

CLI (`cli.py`): `demo` gains `--company PATH` (loads via `load_company`, then `reynolds.scenarios(company)`); new subcommand `export-example PATH` writes `json.dumps(company_to_dict(reynolds.build()), indent=2)`.

- [ ] **Step 1: Append failing tests to `tests/test_io.py`**

```python
from flock_of_pain.io import scenario_from_dict, scenario_to_dict, run_config_from_dict, metrics_to_dict
from flock_of_pain.scenario import AddEmployee, ArrivalMultiplier

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
```

And `tests/test_cli.py`:

```python
import json
from flock_of_pain.cli import main
from flock_of_pain.io import company_to_dict
from flock_of_pain.examples import reynolds

def test_export_example_and_company_flag(tmp_path, capsys):
    p = tmp_path / "c.json"
    assert main(["export-example", str(p)]) == 0
    assert json.loads(p.read_text()) == company_to_dict(reynolds.build())
    assert main(["demo", "--company", str(p), "--days", "1", "--reps", "1"]) == 0
    assert "baseline" in capsys.readouterr().out
```

- [ ] **Step 2: Run the new tests, expect ImportError / argparse error.**
- [ ] **Step 3: Implement in `io.py` and `cli.py`.** `scenario_to_dict` uses `dataclasses.fields` of the overlay and `resource_to_dict` for `employee`. Note `Scenario.__eq__` compares `base` too; the test compares materialized companies instead.
- [ ] **Step 4: Full suite green. Commit** `feat: scenario/run-config/metrics JSON and CLI --company, export-example`

---

### Task 3: Dispatch cost and bounded memory

**Files:**
- Modify: `src/flock_of_pain/engine.py`
- Test: `tests/test_engine_determinism.py` (create), `tests/test_reynolds.py` (perf test)

**Interfaces:**
- Consumes: `Engine.queues`, `_dispatch_resource`, `_start`, `_finish`, `_outage_start`, `_outage_end`, `_tasks`.
- Produces: `Engine.in_progress: dict[str, set[str]]` (system id → task ids running on it); `_tasks` removed. Public behaviour unchanged.

- [ ] **Step 1: Write the hash test (must pass BEFORE any engine change)**

```python
import hashlib
import pytest
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.examples import reynolds

HASHES = {
    "baseline": "55196c5154ef758bd8056a369f132f83e8dc006155822401d81d7ca77d71e17a",
    "demand_plus_30": "57302e42cd2377c71703d7ca52f18e57bf51781e8230893216b34b0e4dc0be2a",
    "erp_outage_2h": "40f1341b2652608457f8e6fcaa38a506c97ac0f990b25c4c5de39d8066de98a3",
    "extra_cs_employee": "24fb2c6d33e370385839d1c97edc8994df8f03d91931d49109e077fd571ced49",
}

@pytest.mark.parametrize("scenario", reynolds.scenarios(reynolds.build()), ids=lambda s: s.id)
def test_event_log_hash_pinned(scenario):
    e = Engine(scenario.materialize(), RunConfig(seed=42, horizon_minutes=14400)); e.run()
    h = hashlib.sha256("\n".join(ev.to_json() for ev in e.events).encode()).hexdigest()
    assert h == HASHES[scenario.id]
```

Run it: expect PASS on the untouched engine. If it fails, stop and report; the pinned values were captured on commit `a466bc3`.

- [ ] **Step 2: Add perf test to `tests/test_reynolds.py`**

```python
@pytest.mark.slow
def test_three_x_load_90_days_under_budget():
    import time
    from flock_of_pain.scenario import ArrivalMultiplier, Scenario
    c = Scenario("x3", "x3", reynolds.build(), [ArrivalMultiplier(3.0)]).materialize()
    t = time.perf_counter()
    Engine(c, RunConfig(seed=42, horizon_minutes=90 * 1440)).run()
    assert time.perf_counter() - t < 8.0
```

Run with `uv run --extra dev pytest -q -m slow tests/test_reynolds.py`; expect FAIL (currently 15.6 s).

- [ ] **Step 3: Rewrite `_dispatch_resource`** as one pass over `sorted(r.skills)` queues tracking `(best_key, best_queue, best_index)`; skip tasks where `_down(t)`; strict `<` so the first minimum wins exactly as `min` did; `del best_queue[best_index]`. Profile with `python -m cProfile -s cumtime` on the x3 run if still over budget; `_retag_queue` and `_outage_*` loops are the next suspects. Do not change policy semantics.
- [ ] **Step 4: Replace `_tasks`** with `self.in_progress: dict[str, set[str]] = defaultdict(set)`: `_start` adds `task.id` under `step.system_id` when not None, `_finish` and the outage block path discard it. The outage block path and the any other `for task in self._tasks` loop iterate `[self.tasks_by_id[i] for i in sorted(self.in_progress[system_id])]` — keep a `tasks_by_id: dict[str, Task]` that drops entries on COMPLETED/CANCELLED/FAILED terminal states so memory stays bounded. Iteration order must match the old document order: verify with the hash test; if the old loop ordered by creation, sort by `created_at` then id.
- [ ] **Step 5: Run full suite incl. slow: `uv run --extra dev pytest -q -m "slow or not slow"`. Hash test must still pass; perf test under 8 s.**
- [ ] **Step 6: Commit** `perf: single-pass dispatch and bounded in-progress tracking`

---

### Task 4: Cancellation of queued siblings and ledger presentation

**Files:**
- Modify: `src/flock_of_pain/engine.py` (`_finish` cancel path), `src/flock_of_pain/experiment.py` (`top_ledger`), `src/flock_of_pain/cli.py`
- Test: `tests/test_engine.py` (append), `tests/test_experiment.py` (append)

**Interfaces:**
- Consumes: `transition`, `TaskState.CANCELLED`, `Engine.queues`, `Instance.active`, `tiny_company` fixture from `tests/conftest.py` (`tiny_company(rate_per_hour, pool_headcount, employees, steps)`).
- Produces: `top_ledger(result, n=5, exclude=(Reason.OFF_SHIFT,)) -> list[LedgerRow]`; `off_shift_minutes(result) -> float` in `experiment.py` (sum over runs of ledger rows with `reason == Reason.OFF_SHIFT`).

Engine rule: when `inst.cancelled` becomes true in `_finish`, every task of that instance still in a queue is removed from its queue and transitioned to CANCELLED at `self.now`. In-progress siblings finish normally and spawn nothing (existing behaviour). Hash test must still pass: the Reynolds scenarios do cancel instances, so if the hash changes, that is expected only if the old log lacked those TASK_CANCELLED events; in that case re-pin the four hashes in `tests/test_engine_determinism.py` and say so in the report.

- [ ] **Step 1: Failing engine test** (append to `tests/test_engine.py`; read the fixture first to match its signature):

```python
def test_cancel_removes_queued_sibling():
    # two parallel steps in one dept, one employee: step a fails and exhausts retries while b waits
    from flock_of_pain.dist import const
    from flock_of_pain.events import EventKind as K, TaskState as S
    steps = [
        Step("a", "a", "d", "s", const(10), failure_prob=1.0, max_retries=0),
        Step("b", "b", "d", "s", const(10)),
    ]
    c = tiny_company(rate_per_hour=1, pool_headcount=0, employees=1, steps=steps)
    e = Engine(c, RunConfig(seed=1, horizon_minutes=60)); e.run()
    first = next(ev.instance_id for ev in e.events if ev.kind == K.INSTANCE_STARTED)
    kinds = [ev.kind for ev in e.events if ev.instance_id == first and ev.step_id == "b"]
    assert K.TASK_CANCELLED in kinds and K.TASK_STARTED not in kinds
```

Adjust event kind names to those in `events.py` (`EventKind` members); the assertion intent is: sibling `b` of the first instance is cancelled and never starts. If `tiny_company` cannot express two parallel steps with a single employee, build the `Company` inline.

- [ ] **Step 2: Run, expect FAIL. Implement in `_finish`.** Then run the hash test; follow the re-pin rule above.
- [ ] **Step 3: Failing experiment test** (append to `tests/test_experiment.py`):

```python
def test_top_ledger_excludes_off_shift_by_default():
    base = reynolds.build()
    r = run_experiment("b", Scenario("b", "b", base), RunConfig(seed=42, horizon_minutes=3 * 1440))
    assert all(row.reason != Reason.OFF_SHIFT for row in top_ledger(r))
    assert any(row.reason == Reason.OFF_SHIFT for row in top_ledger(r, exclude=()))
    assert off_shift_minutes(r) > 0
```

- [ ] **Step 4: Implement `exclude` and `off_shift_minutes`; CLI prints `OFF_SHIFT total: {minutes:.1f}` on the line after `Top blocked time: {name}`.** Run full suite green.
- [ ] **Step 5: Commit** `feat: cancel queued siblings; ledger excludes OFF_SHIFT by default`

---

### Task 5: FastAPI service

**Files:**
- Create: `src/flock_of_pain/api.py`
- Modify: `pyproject.toml` (`api = ["fastapi", "uvicorn", "httpx"]` extra)
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `io.company_from_dict`, `io.scenario_from_dict`, `io.run_config_from_dict`, `io.metrics_to_dict`, `io.company_to_dict`, `io.scenario_to_dict`, `io.SchemaError`; `experiment.run_experiment`, `experiment.KPI_KEYS`, `experiment.top_ledger`, `experiment.off_shift_minutes`, the disclaimer (first line of `compare([])`, or a `DISCLAIMER` constant if `experiment.py` already has one; if not, extract one in this task and make `compare` use it); `reynolds.build`, `reynolds.scenarios`; `model.ModelError`.
- Produces: `app: FastAPI` with `GET /example` and `POST /simulate` per spec §6. Request body `{"company": dict, "scenarios": list[dict], "config": dict, "include_events": bool = false}` (use a pydantic model with `dict`/`list[dict]` fields, validation of the inner shapes stays in `io`). Error handler maps `SchemaError` → 422 `{"path": e.path, "message": e.message}`, other `ModelError` → 422 `{"path": null, "message": str(e)}`. CORS origin `http://localhost:3000`.

Response per scenario: `{"id", "name", "summary": {key: {"mean","p10","p50","p90"}}, "ledger": [top_ledger rows as dicts, reason as str], "off_shift_minutes", "runs": [{"seed", "metrics", "events"?}]}`. `kpi_keys` at the top level is `[*KPI_KEYS, *sorted util_* keys present]`. `events` = `[json.loads(e.to_json()) for e in run.events]` only when requested.

- [ ] **Step 1: Add the extra to `pyproject.toml`; `uv sync --extra api --extra dev`.**
- [ ] **Step 2: Failing tests `tests/test_api.py`** (skip module if fastapi missing: `pytest.importorskip("fastapi")`):

```python
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
    s = b["scenarios"][0]
    assert set(s["summary"]["cycle_p90"]) == {"mean", "p10", "p50", "p90"}
    assert len(s["runs"]) == 2 and "events" not in s["runs"][0]
    assert isinstance(s["off_shift_minutes"], float)

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
```

Check `Event.to_json()` field names before asserting `["kind"]`; use the actual key.

- [ ] **Step 3: Implement `api.py`. Run `uv run --extra api --extra dev pytest -q`, expect green. Also run plain `uv run --extra dev pytest -q` to confirm the module skips cleanly without fastapi (if `uv run` syncs the api extra anyway, note it in the report).**
- [ ] **Step 4: Smoke: `uv run --extra api uvicorn flock_of_pain.api:app --port 8000 &`, `curl -s localhost:8000/example | head -c 200`, kill it.**
- [ ] **Step 5: README: add "API" section with the run command and the two endpoints. Commit** `feat: FastAPI simulate/example endpoints behind api extra`

---

### Task 6: Next.js + shadcn page

**Files:**
- Create: `web/` (Next.js app), `web/app/page.tsx`, `web/lib/api.ts`, `web/.env.example`
- Modify: `README.md` (web section), `.gitignore` (`web/node_modules`, `web/.next`)

**Interfaces:**
- Consumes: `GET /example`, `POST /simulate` as in Task 5. Response types declared in `web/lib/api.ts`:
  ```ts
  export type Stat = { mean: number; p10: number; p50: number; p90: number };
  export type LedgerRow = { department_id: string; reason: string | null; blocker_id: string | null; minutes: number; count: number };
  export type ScenarioResult = { id: string; name: string; summary: Record<string, Stat>; ledger: LedgerRow[]; off_shift_minutes: number };
  export type SimulateResponse = { disclaimer: string; kpi_keys: string[]; scenarios: ScenarioResult[] };
  export type ApiError = { path: string | null; message: string };
  export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  export async function getExample(): Promise<{ company: unknown; scenarios: unknown[] }>
  export async function simulate(body: unknown): Promise<SimulateResponse>   // throws ApiError on 422
  ```

- [ ] **Step 1: Scaffold:** `cd web && npx --yes create-next-app@latest . --ts --app --tailwind --eslint --no-src-dir --import-alias "@/*" --use-npm` (run from an empty `web/`), then `npx --yes shadcn@latest init -d` and `npx --yes shadcn@latest add button input textarea table select alert card`. Commit the scaffold separately: `chore: scaffold web (Next.js + shadcn)`.
- [ ] **Step 2: Write `web/lib/api.ts` per Interfaces.**
- [ ] **Step 3: Write `web/app/page.tsx`** as a client component: state for company text, scenarios text, seed (42), days (10), reps (5), policy (`priority|fifo|least_loaded`, read the exact names from `flock_of_pain/scheduling.py` `POLICIES`), result, error. On mount `getExample()` fills both textareas with `JSON.stringify(x, null, 2)`. Run button: `JSON.parse` both (parse error → Alert), `simulate(...)`, render. KPI table: first column key, one column per scenario, cell `${mean.toFixed(2)} (${p10.toFixed(2)}–${p90.toFixed(2)})`. Per scenario a Card with the off-shift line and a ledger Table. Disclaimer shown once above the KPI table. Two-column grid at `md`, stacked below.
- [ ] **Step 4: Verify:** `npm run lint` clean, `npm run build` succeeds. Manual smoke with the API running: load page, click Run, see table. Record the exact commands and the first KPI row in the report.
- [ ] **Step 5: README web section (`cd web && npm install && npm run dev`, env var). Commit** `feat: web page running experiments against the API`
