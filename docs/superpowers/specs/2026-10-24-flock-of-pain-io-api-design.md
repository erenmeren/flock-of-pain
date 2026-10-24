# Flock of Pain phase 1: JSON contract, engine hardening, API, thin UI

Date: 2026-10-24. Builds on `2026-10-24-workforce-twin-core-design.md` (v0 engine, package `flock_of_pain`).

## 1. Intent

v0 proves the engine but a company can only be defined in Python. The product
will get company definitions from two places: an AI agent that turns a prompt
into a definition, and CRUD pages (people, departments, workflows). Both need
one serializable contract. This phase adds that contract, fixes the engine gaps
that would show in a demo, wraps the engine in a small HTTP API, and puts one
plain page in front of it.

## 2. Goals

- A JSON format for `Company`, `Scenario` overlays and `RunConfig` with a
  loader that reports errors by JSON path, and an exporter that round-trips.
- `examples/reynolds.json` generated from `reynolds.build()`, byte-identical
  on re-export, usable verbatim in an AI prompt as the worked example.
- Engine: sub-quadratic dispatch, bounded memory, cancelled instances stop
  their queued siblings, ledger presentation that surfaces non-structural
  waits.
- FastAPI service, stateless, in-memory: one simulate endpoint, one example
  endpoint. Optional dependency extra; core package stays dependency-free.
- Next.js + shadcn page: paste/edit company JSON, list scenarios, run, see KPI
  comparison and ledger. No playback yet.

## 3. Non-goals (this phase)

- Persistence, tenants, auth, background jobs, run history.
- Event playback UI and WebSocket streaming. The API already returns the
  event list when asked, so playback is purely frontend work later.
- AI agent integration itself. Only its input contract (the JSON format and
  the example) ships now.
- JSON Schema document generation. The loader is the validator; a schema file
  can be derived later if the UI needs it.
- UI design. shadcn defaults, no custom styling.

## 4. JSON contract (`flock_of_pain/io.py`)

Mirrors the dataclasses one to one. Units are the engine's: minutes for
absences, outages and SLA; hours for shift windows; `rate_per_hour` for
arrivals. Time zero is Monday 00:00.

```json
{
  "id": "reynolds", "name": "Reynolds",
  "systems": [{"id": "erp", "name": "ERP"}],
  "departments": [{
    "id": "cs", "name": "Customer Support",
    "resources": [
      {"id": "cs_pool", "skills": ["erp_entry", "order_review"], "cost_per_hour": 18.0,
       "schedule": {"weekday_hours": {"0": [9, 17], "1": [9, 17]}, "absences": []}, "headcount": 12},
      {"id": "emp_01", "name": "Employee 1", "skills": ["erp_entry"], "cost_per_hour": 18.0, "pool_id": "cs_pool"}
    ]
  }],
  "workflows": [{
    "id": "order_modification", "name": "Order Modification",
    "arrival": {"rate_per_hour": 4.0, "window": {"weekday_hours": {"0": [9, 17]}}},
    "steps": [{
      "id": "review", "name": "Review", "department_id": "cs", "required_skill": "order_review",
      "duration": {"kind": "lognormal_mean", "mean": 12, "sigma": 0.4},
      "depends_on": [], "system_id": "erp", "priority": 1, "sla_minutes": 60,
      "failure_prob": 0.05, "rework_to": null, "max_retries": 1
    }]
  }],
  "outages": [["erp", 600, 720]]
}
```

Rules:

- `department_id` on a resource is implied by the enclosing department; the
  loader fills it. `capacity` is never in JSON: pools get it from
  `resolve()`, employees are always 1. `speed_factor` optional, default 1.
- `skills` is a JSON list; loader builds a `set`, exporter writes it sorted.
- `schedule` keys are weekday strings `"0".."6"` (JSON has no int keys).
  `schedule: null` or absent on a carved employee means "inherit pool".
- `duration` accepts every `Dist.kind` as `{"kind", "a", "b", "c"}` and one
  shorthand: `{"kind": "lognormal_mean", "mean", "sigma"}` which becomes
  `lognormal(log(mean) - sigma²/2, sigma)`. The exporter writes the raw form.
  `reynolds.lognormal_minutes` moves to `dist.lognormal_mean(mean, sigma)`;
  the example keeps calling it by the new name.
- Optional fields with dataclass defaults are optional in JSON. Required
  fields missing, wrong types, unknown keys, and unknown `kind` raise
  `SchemaError(path, message)` where `path` is like
  `departments[0].resources[2].skills`. `SchemaError` subclasses `ModelError`.
  Semantic errors (unknown ids, cycles, carve-out overflow) still come from
  `resolve()` as `ModelError` and the loader calls `resolve()` before
  returning.
- Scenario JSON: `{"id", "name", "overlays": [{"type": "arrival_multiplier",
  "factor": 1.3, "workflow_id": null}, ...]}`. `type` is the snake_case of the
  overlay class; the remaining keys are its fields. `add_employee` carries an
  `employee` object in resource JSON form plus `department_id`.
- Run config JSON: `{"seed": 42, "days": 10, "replications": 5,
  "policy": "priority"}`. `days` is converted to `horizon_minutes`.

Public functions:

```python
def company_from_dict(d: dict) -> Company          # resolves before returning
def company_to_dict(c: Company) -> dict            # inverse; stable key order
def scenario_from_dict(d: dict, base: Company) -> Scenario
def run_config_from_dict(d: dict) -> RunConfig
def metrics_to_dict(m: Metrics) -> dict            # dataclasses.asdict, Reason as str
def load_company(path) -> Company                  # json.load + company_from_dict
```

Round trip property: `company_to_dict(company_from_dict(d)) == d` for the
exported example, and `company_from_dict(company_to_dict(reynolds.build()))`
produces a byte-identical event log for seed 42, 3 days.

CLI: `demo --company path.json` runs the given company with the four
Reynolds overlay sets; `export-example path.json` writes the example.
`src/flock_of_pain/examples/reynolds.json` is committed and a test asserts it
matches `company_to_dict(build())`.

## 5. Engine hardening (`engine.py`, `experiment.py`)

1. **Dispatch cost.** `_dispatch_resource` scans every queued task per free
   slot and `list.remove` is linear. Keep the queues as lists but replace the
   per-call rebuild with a single pass that tracks the best task and index,
   and pop by index. Acceptance: Reynolds with `ArrivalMultiplier(3.0)` for
   90 days under 8 s (today 15.6 s for 1.03 M events; 10-day baseline runs at
   roughly 7 µs per event, so 8 s is near the linear floor), and event logs
   for the existing seeds byte-identical to
   the current implementation (capture hashes before changing the code; a
   test pins seed 42, 10 days, all four scenarios). If a heap is needed to
   hit the budget, the policy `order_key` must stay the sole ordering input
   and ties break on `(queued_at, task.id)` exactly as `min` does now.
2. **Memory.** `_tasks` grows forever; it exists only for outage handling.
   Replace with `in_progress: dict[str, set[str]]` keyed by system id, kept
   current by `_start`, `_finish`, and the outage block path. Then drop
   `_tasks`.
3. **Cancellation.** When an instance is cancelled, its tasks still in a
   queue are removed and transitioned to CANCELLED; tasks in progress run to
   completion but spawn nothing (already true). Add a test: two parallel
   steps, one fails past `max_retries`, the sibling queued task gets a
   TASK_CANCELLED event and never starts.
4. **Ledger presentation.** `top_ledger(result, n=5, exclude=(Reason.OFF_SHIFT,))`.
   The CLI prints one summary line `OFF_SHIFT total: <minutes>` above the
   table. Ledger data is unchanged; analytics untouched.

Deferred again: 24/7 schedules emitting midnight shift events; true pooled
percentiles.

## 6. API (`src/flock_of_pain/api.py`, extra `api = ["fastapi", "uvicorn"]`)

Stateless. Runs synchronously inside the request; fine at demo scale
(4 scenarios × 5 reps ≈ 1.2 s).

- `GET /example` → Reynolds company JSON plus its four scenarios as
  `{"company": {...}, "scenarios": [...]}`.
- `POST /simulate` body:
  `{"company": {...}, "scenarios": [...], "config": {...}, "include_events": false}`.
  Response:
  ```json
  {"disclaimer": "All parameters are assumed values; results are simulation estimates, not measurements.",
   "kpi_keys": ["throughput_per_day", ...],
   "scenarios": [{"id", "name", "summary": {"cycle_p90": {"mean", "p10", "p50", "p90"}, ...},
                  "ledger": [{"department_id", "reason", "blocker_id", "minutes", "count"}],
                  "off_shift_minutes": 0.0,
                  "runs": [{"seed", "metrics": {...}, "events": [...]}]}]}
  ```
  `events` present only when `include_events` is true; each event is
  `json.loads(e.to_json())`.
- Errors: `SchemaError` and `ModelError` → 422 with `{"path", "message"}`
  (`path` null for `ModelError`). FastAPI's own validation errors stay 422.
- CORS: allow `http://localhost:3000`.
- Run: `uv run --extra api uvicorn flock_of_pain.api:app`.
- Tests use `fastapi.testclient`; `httpx` comes with the extra.

## 7. UI (`web/`, Next.js app router, TypeScript, shadcn)

One page. Left column: textarea with company JSON (loaded from `/example`
on mount), textarea with scenarios JSON, inputs for seed, days, reps,
policy select, Run button. Right column: KPI comparison table (rows =
`kpi_keys` + `util_*`, cells `mean (p10–p90)` formatted like the CLI), then
one ledger table per scenario with the off-shift line above it. Errors from
422 shown in a red `Alert` with the path. API base URL from
`NEXT_PUBLIC_API_URL`, default `http://localhost:8000`.

shadcn components allowed: `button`, `input`, `textarea`, `table`, `select`,
`alert`, `card`. Nothing else is installed. No state library, no form
library, `fetch` only. No tests beyond `npm run build` passing and
`npm run lint` clean.

## 8. Constraints

- Core package keeps zero runtime dependencies; `fastapi` lives behind the
  `api` extra and `api.py` is the only module that imports it.
- Determinism and byte-identical logs for a given seed are preserved by every
  engine change (pinned-hash test).
- All disclaimers and KPI key names come from `experiment.py`; the API and UI
  never restate them.
- Python ≥ 3.12, pytest via `uv run --extra dev pytest`. Node 26 for `web/`.

## 9. Left to the builder

- Exact `SchemaError` message wording.
- Whether the dispatch fix needs a heap; the hash test decides correctness.
- shadcn init flags and the layout grid.
