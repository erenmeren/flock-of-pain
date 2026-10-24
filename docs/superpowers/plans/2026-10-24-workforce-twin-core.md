# Workforce Twin Core (v0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Python package `workforce_twin` with a deterministic discrete-event engine, hybrid pool/individual resources, scenario overlays, event-log analytics, and a CLI that runs the four Reynolds experiments.

**Architecture:** Plain dataclasses describe the company. A heapq-driven `Engine` emits an append-only event log through one `transition()` function. `compute_metrics(events, company)` is a pure function over that log. Scenarios deep-copy the base company and apply overlays; experiments run N seeded engines and summarize.

**Tech Stack:** Python 3.12+ (dev machine has 3.14), stdlib only at runtime, pytest via `uv`.

**Spec:** `docs/superpowers/specs/2026-10-24-workforce-twin-core-design.md` (read sections 6, 7 and 13 before any engine task).

## Global Constraints

- Python 3.12+. Zero third-party runtime dependencies. Tests use pytest.
- Package `workforce_twin`, layout `src/workforce_twin/`, `pyproject.toml`, `pip install -e .` works.
- Time is a float in minutes; time zero is Monday 00:00. No wall-clock in the engine.
- All randomness through one `random.Random(seed)` owned by the run. Never call module-level `random`.
- Metrics are derived from the event log only (plus static company data). The engine never computes metrics.
- The baseline `Company` is never mutated by scenarios or runs.
- Every `TASK_QUEUED` / `TASK_BLOCKED` event carries a reason code from `{NO_ELIGIBLE_RESOURCE, ALL_RESOURCES_BUSY, OFF_SHIFT, SYSTEM_DOWN}` or `None` when a resource was free.
- Same seed and inputs produce a byte-identical serialized event log.
- Per-individual utilization is computed but never ranked or printed in the comparison table.

## Review Focus

1. Pool `headcount` smaller than the number of employees carved out of it: load must raise `ModelError`, not produce negative capacity. (Task 3)
2. A step whose `required_skill` no resource in its department has: the task must sit `QUEUED` with `NO_ELIGIBLE_RESOURCE` and the run must still end at the horizon without error. (Task 7)
3. A workflow whose `depends_on` graph has a cycle, or references an unknown step: load must raise `ModelError`. (Task 3)
4. Two overlapping outages of the same system, or an outage ending after the horizon: the system must stay down until the last outage ends and never flip "up" early. (Task 8)
5. An empty event log (zero arrivals): `compute_metrics` must return zeroed metrics, not raise `ZeroDivisionError` or `StatisticsError`. (Task 9)

---

### Task 1: Project scaffold and `Dist`

**Files:**
- Create: `pyproject.toml`, `src/workforce_twin/__init__.py`, `src/workforce_twin/dist.py`, `tests/test_dist.py`, `.gitignore`

**Interfaces:**
- Produces: `Dist` frozen dataclass with `kind: str, a: float, b: float = 0.0, c: float = 0.0` and `sample(self, rng: random.Random) -> float`; constructors `const(v)`, `uniform(a, b)`, `triangular(a, mode, b)`, `lognormal(mean, sigma)` (parameters of the underlying normal), `exponential(mean)`. All samples are clamped to `>= 0.0`.

- [ ] **Step 1: Write `pyproject.toml`** with `[project] name = "workforce-twin", version = "0.1.0", requires-python = ">=3.12", dependencies = []`, `[project.optional-dependencies] dev = ["pytest"]`, setuptools build backend with `package-dir = {"" = "src"}`, `[tool.pytest.ini_options] testpaths = ["tests"]`. `.gitignore`: `.venv/`, `__pycache__/`, `*.egg-info/`, `.pytest_cache/`.

- [ ] **Step 2: Write the failing tests** in `tests/test_dist.py`:

```python
def test_const_ignores_rng():
    assert const(5).sample(random.Random(1)) == 5.0

def test_same_seed_same_samples():
    d = lognormal(3.0, 0.5)
    a = [d.sample(random.Random(7)) for _ in range(1)]
    b = [d.sample(random.Random(7)) for _ in range(1)]
    assert a == b

def test_uniform_in_range():
    rng = random.Random(3)
    assert all(10 <= uniform(10, 20).sample(rng) <= 20 for _ in range(100))

def test_exponential_mean_roughly():
    rng = random.Random(11)
    xs = [exponential(30).sample(rng) for _ in range(5000)]
    assert 27 < sum(xs) / len(xs) < 33

def test_never_negative():
    rng = random.Random(5)
    assert all(triangular(-5, 0, 1).sample(rng) >= 0 for _ in range(200))
```

- [ ] **Step 3: Run tests, expect ImportError**

Run: `uv run --extra dev pytest tests/test_dist.py -v`

- [ ] **Step 4: Implement `dist.py`** using `rng.uniform`, `rng.triangular`, `rng.lognormvariate`, `rng.expovariate(1/mean)`.

- [ ] **Step 5: Run tests, expect PASS. Commit** `feat: project scaffold and Dist sampling`.

---

### Task 2: `Schedule`

**Files:**
- Create: `src/workforce_twin/schedule.py`, `tests/test_schedule.py`

**Interfaces:**
- Produces: `MINUTES_PER_DAY = 1440`, `MINUTES_PER_WEEK = 10080`; `weekday(t: float) -> int` (0 = Monday); `Schedule` dataclass with `weekday_hours: dict[int, tuple[float, float]]` (hours, e.g. `{0: (9.0, 17.0)}`) and `absences: list[tuple[float, float]] = field(default_factory=list)` (absolute minutes, half-open). Methods: `is_on(t) -> bool` (inside a window and not inside an absence), `next_on(t) -> float | None` (smallest `t2 >= t` with `is_on(t2)`, searching at most two weeks ahead; `None` if none), `next_off(t) -> float` (end of current window or start of next absence, whichever first; requires `is_on(t)`), `on_minutes(start, end) -> float` (total on-shift minutes in `[start, end)`). Helper `business_hours(start_h, end_h, days=(0,1,2,3,4)) -> Schedule`.

- [ ] **Step 1: Write failing tests** (`business_hours(9, 17)`): `is_on(9*60)` True, `is_on(8*60+59)` False, `is_on(5*1440 + 10*60)` False (Saturday), `next_on(17*60)` equals `1440 + 9*60`, `next_on(4*1440 + 18*60)` equals `7*1440 + 9*60` (Friday evening → Monday), `on_minutes(0, 7*1440) == 5*8*60`, absence `[(1440+9*60, 1440+17*60)]` makes `is_on(1440+10*60)` False and `on_minutes(0, 7*1440) == 4*8*60`, `next_off(9*60) == 17*60`, empty `Schedule({})` has `next_on(0) is None`.

- [ ] **Step 2: Run, expect failure. Step 3: Implement. Step 4: Run, expect PASS. Step 5: Commit** `feat: weekly Schedule with absences`.

---

### Task 3: Domain model and `Company.resolve()`

**Files:**
- Create: `src/workforce_twin/model.py`, `tests/test_model.py`

**Interfaces:**
- Consumes: `Dist`, `Schedule`.
- Produces (all `@dataclass`, mutable):
  - `class ModelError(ValueError)`
  - `Resource(id, department_id, skills: set[str], capacity: int = 1, cost_per_hour: float = 0.0, speed_factor: float = 1.0, name: str = "", schedule: Schedule | None = None, pool_id: str | None = None, headcount: int | None = None)`. Property `is_pool -> bool` (`headcount is not None`). For a pool, `capacity` is overwritten by `resolve()`.
  - `Department(id, name, resources: list[Resource])`
  - `BusinessSystem(id, name)`
  - `ArrivalSpec(rate_per_hour: float, window: Schedule)`
  - `Step(id, name, department_id, required_skill, duration: Dist, depends_on: list[str] = [], system_id: str | None = None, priority: int = 0, sla_minutes: float | None = None, failure_prob: float = 0.0, rework_to: str | None = None, max_retries: int = 0)`
  - `Workflow(id, name, steps: list[Step], arrival: ArrivalSpec)`
  - `Company(id, name, departments, systems, workflows, outages: list[tuple[str, float, float]] = [])`. Methods: `resources() -> list[Resource]` (document order), `resource(id)`, `department(id)`, `workflow(id)`, `step(workflow_id, step_id)`, `resolve() -> None`.
- `resolve()`: for each pool set `capacity = headcount - len(employees with pool_id == pool.id)`; employees with `schedule is None` and a `pool_id` inherit the pool's schedule; then validate and raise `ModelError` on: negative pool capacity, employee `pool_id` unknown, resource `schedule is None` after inheritance, duplicate resource ids, step `depends_on` unknown or cyclic, `rework_to` not self and not in `depends_on`, step `department_id` or `system_id` unknown, `failure_prob` outside `[0,1]`, pool `capacity` and employee `capacity` is 1.

- [ ] **Step 1: Write failing tests**: pool headcount 12 with 3 carved → `capacity == 9`; headcount 2 with 3 carved → `ModelError`; carved employee without schedule inherits pool schedule; cyclic `depends_on` (a→b→a) → `ModelError`; `rework_to` pointing at a non-dependency → `ModelError`; unknown `system_id` → `ModelError`; `company.step("w", "s1").priority == 0` default.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: domain model with pool carve-out and validation`.

---

### Task 4: Events, task states and `transition()`

**Files:**
- Create: `src/workforce_twin/events.py`, `tests/test_events.py`

**Interfaces:**
- Produces:
  - `EventKind(StrEnum)`: `TASK_CREATED, TASK_QUEUED, RESOURCE_ASSIGNED, TASK_STARTED, TASK_COMPLETED, TASK_FAILED, TASK_BLOCKED, TASK_UNBLOCKED, TASK_CANCELLED, RESOURCE_UNAVAILABLE, RESOURCE_AVAILABLE, SYSTEM_OUTAGE_STARTED, SYSTEM_OUTAGE_ENDED, SLA_BREACHED, WORKFLOW_STARTED, WORKFLOW_COMPLETED`.
  - `Reason(StrEnum)`: `NO_ELIGIBLE_RESOURCE, ALL_RESOURCES_BUSY, OFF_SHIFT, SYSTEM_DOWN`.
  - `TaskState(StrEnum)`: `CREATED, QUEUED, ASSIGNED, IN_PROGRESS, BLOCKED, COMPLETED, FAILED, CANCELLED`.
  - `Event(t: float, kind: EventKind, task_id: str | None = None, instance_id: str | None = None, workflow_id: str | None = None, step_id: str | None = None, department_id: str | None = None, resource_id: str | None = None, system_id: str | None = None, reason: Reason | None = None, payload: dict = {})`. `to_json(self) -> str` via `json.dumps(asdict, sort_keys=True, separators=(",", ":"))`.
  - `Task(id, instance_id, workflow_id, step_id, department_id, state: TaskState = CREATED, created_at: float = 0.0, queued_at: float | None = None, started_at: float | None = None, resource_id: str | None = None, remaining: float | None = None, ends_at: float | None = None, run_token: int = 0, retries: int = 0)`.
  - `LEGAL: dict[TaskState, frozenset[TaskState]]`: `CREATED→{QUEUED}`, `QUEUED→{ASSIGNED, CANCELLED}`, `ASSIGNED→{IN_PROGRESS}`, `IN_PROGRESS→{COMPLETED, FAILED, BLOCKED}`, `BLOCKED→{QUEUED}`, `FAILED→{QUEUED, CANCELLED}`, `COMPLETED→{QUEUED}` (allowed only with `rework=True`).
  - `STATE_EVENT: dict[TaskState, EventKind]` mapping each target state to its event; `BLOCKED→QUEUED` emits `TASK_UNBLOCKED` instead of `TASK_QUEUED`.
  - `transition(task: Task, new: TaskState, t: float, log: list[Event], *, reason: Reason | None = None, resource_id: str | None = None, system_id: str | None = None, rework: bool = False, payload: dict | None = None) -> Event`: raises `ValueError` on illegal transition, sets `task.state`, sets `queued_at` on entering `QUEUED` from `CREATED`/`FAILED`/`COMPLETED` (not from `BLOCKED`, which keeps the original), sets `started_at` on `IN_PROGRESS`, appends and returns the event with task ids copied in.

- [ ] **Step 1: Write failing tests**: legal chain CREATED→QUEUED→ASSIGNED→IN_PROGRESS→COMPLETED appends 4 events of the right kinds; `IN_PROGRESS→QUEUED` raises `ValueError`; `COMPLETED→QUEUED` without `rework=True` raises, with it succeeds; `BLOCKED→QUEUED` emits `TASK_UNBLOCKED` and keeps `queued_at`; `Event.to_json()` for two equal events is identical and contains `"kind":"TASK_QUEUED"`.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: event log and task state machine`.

---

### Task 5: Scenario overlays

**Files:**
- Create: `src/workforce_twin/scenario.py`, `tests/test_scenario.py`

**Interfaces:**
- Consumes: `Company`, `Resource`.
- Produces: overlay dataclasses `ArrivalMultiplier(factor: float, workflow_id: str | None = None)` (`None` = every workflow), `SystemOutage(system_id, start, end)` (appends to `company.outages`), `AddEmployee(department_id, employee: Resource)`, `RemoveResource(resource_id)`, `SetPoolHeadcount(pool_id, headcount: int)`, `Absence(resource_id, start, end)`; `Overlay = Union[...]`; `Scenario(id, name, base: Company, overlays: list[Overlay] = [])` with `materialize() -> Company` = `copy.deepcopy(base)`, apply overlays in order, `resolve()`, return.

- [ ] **Step 1: Write failing tests**: build a small company (helper `tiny_company()` in `tests/conftest.py`: one dept `cs`, pool `cs_pool` headcount 3, employee `e1` carved from it, system `erp`, one 2-step workflow `w`); after `materialize()` with every overlay kind, `base` compares equal to a `deepcopy` taken before; `ArrivalMultiplier(1.3)` gives `rate_per_hour == pytest.approx(base_rate * 1.3)`; `RemoveResource("e1")` makes pool capacity go from 2 to 3; `SetPoolHeadcount("cs_pool", 1)` with `e1` still carved → `ModelError`; `SystemOutage("erp", 600, 720)` appears in `outages`.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: scenario overlays over immutable baseline`.

---

### Task 6: Scheduling policies

**Files:**
- Create: `src/workforce_twin/scheduling.py`, `tests/test_scheduling.py`

**Interfaces:**
- Consumes: `Task`, `Step`, `Resource`.
- Produces: `class SchedulingPolicy(Protocol)` with `order_key(self, task: Task, step: Step) -> tuple` (smaller = served first) and `choose_resource(self, task: Task, eligible: list[Resource], busy_minutes: dict[str, float]) -> Resource` (`eligible` non-empty). Classes `Fifo` (key `(queued_at, id)`, first eligible), `Priority` (key `(-priority, queued_at, id)`, first eligible), `LeastLoaded` (same key as `Priority`; resource with smallest `busy_minutes.get(r.id, 0.0) / r.capacity`, ties by list order). `POLICIES: dict[str, type[SchedulingPolicy]] = {"fifo": Fifo, "priority": Priority, "least_loaded": LeastLoaded}`.

- [ ] **Step 1: Write failing tests**: `Priority` orders priority 5 before priority 0 even if queued later; `Fifo` ignores priority; `LeastLoaded` picks the resource with lower `busy_minutes / capacity`; tie goes to first in list.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: fifo, priority and least-loaded scheduling policies`.

---

### Task 7: Engine core (arrivals, queues, dispatch, shifts, completion)

**Files:**
- Create: `src/workforce_twin/engine.py`, `tests/test_engine.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `RunConfig(seed: int, horizon_minutes: float, replications: int = 1, policy: str = "priority")`; `Engine(company: Company, config: RunConfig)` with attributes `now: float`, `events: list[Event]`, `rng: random.Random`, `company` and methods `schedule(t: float, fn: Callable[[], None]) -> None`, `step() -> bool` (pop and run one callback; False when heap empty or `now` would exceed horizon), `run_until(t: float) -> None`, `run() -> None` (until horizon or heap empty, honoring `pause()`), `pause()`, `resume()`. `Engine.__init__` calls `company.resolve()` is NOT done here: the caller passes a resolved company (scenarios already resolve; tests call `resolve()` explicitly).

Engine rules the implementer must follow (spec §7 and §13):
- Heap entries `(t, seq, fn)`; `seq` is a counter. `now` is set to the entry's `t` before `fn()` runs.
- Resource state: `free_slots: dict[str, int]` initialised to `capacity`; `busy_minutes: dict[str, float]`; `on_shift: dict[str, bool]`.
- Shift boundaries: at init, for every resource, walk `schedule.next_on` / `next_off` up to the horizon and schedule callbacks that flip `on_shift`, emit `RESOURCE_AVAILABLE` / `RESOURCE_UNAVAILABLE`, and on becoming available call `_dispatch_resource(r)`.
- Arrivals: per workflow, `_next_arrival(wf, t)`: `t2 = t + rng.expovariate(rate_per_hour / 60)`; if `not window.is_on(t2)`, `t2 = window.next_on(t2)` then draw again from `t2` (loop); schedule `_arrive(wf)` at the final time when `< horizon`. `_arrive` creates an instance (`id = f"{wf.id}-{n:06d}"`, emits `WORKFLOW_STARTED`), creates tasks for all steps with empty `depends_on`, then schedules the next arrival.
- Instance bookkeeping: `completed: set[str]`, `active: dict[str, str]` (step → task id), `retries: int`. `_create_task(instance, step)`: `TASK_CREATED` then `transition(QUEUED)` with the reason from `_try_dispatch_task`, task id `f"{instance.id}:{step.id}:{instance.retries}"`.
- `_eligible(task) -> list[Resource]`: same department, has skill, `on_shift`, `free_slots > 0` (absences are already part of `is_on`, so `on_shift` covers them). Reason when empty: `NO_ELIGIBLE_RESOURCE` if no resource in the department has the skill at all, else `OFF_SHIFT` if none with the skill is on shift, else `ALL_RESOURCES_BUSY`. (`SYSTEM_DOWN` added in Task 8.)
- Queues: `dict[tuple[str, str], list[Task]]` keyed by `(department_id, required_skill)`; the policy's `order_key` is applied with `min()` at dispatch time (no need to keep sorted).
- `_start(task, resource)`: `transition(ASSIGNED)` then `transition(IN_PROGRESS)` at the same `now`, `free_slots -= 1`, duration = `task.remaining` if set else `step.duration.sample(rng) / resource.speed_factor`, `task.run_token += 1`, `task.ends_at = now + duration`, schedule `_finish(task, token)` at `now + duration`. Payload of `TASK_STARTED` includes `{"duration": d, "overrun": max(0, now + d - resource.schedule.next_off(now))}`.
- `_finish(task, token)`: ignore if `task.run_token != token` or state is not `IN_PROGRESS`. Add elapsed to `busy_minutes[resource]`, `free_slots += 1`, then (Task 8 adds failure roll) `transition(COMPLETED)`, emit `SLA_BREACHED` if `sla_minutes` and `now - queued_at > sla_minutes`, add step to `instance.completed`, create tasks for every step whose `depends_on ⊆ completed` and not in `completed` and not in `active`; if `completed == all steps` emit `WORKFLOW_COMPLETED`. Finally `_dispatch_resource(resource)`.
- `_dispatch_resource(r)`: while `free_slots[r] > 0`: gather tasks from every queue `(r.department_id, s)` for `s in r.skills` whose system is up; pick `min` by `order_key`; if none, stop; remove from queue and `_start`.
- `_try_dispatch_task(task) -> Reason | None`: compute eligible; if non-empty, `choose_resource` and `_start`, return `None`; else append to queue and return the reason.
- Determinism: all iteration over resources and queues is in document order; never iterate a `set` where order affects behavior (sort skills when gathering queues).

- [ ] **Step 1: Write failing tests** in `tests/test_engine.py` using `tiny_company()`:
  - `test_single_task_runs`: one employee, one step `const(30)`, arrival rate 0 but call `engine._arrive(wf)` directly at `now = 9*60` after `run_until(9*60)`; after `run()`, event kinds for the task are `[TASK_CREATED, TASK_QUEUED, RESOURCE_ASSIGNED, TASK_STARTED, TASK_COMPLETED]` and `TASK_COMPLETED.t == 9*60 + 30`.
  - `test_waits_for_shift`: arrival at `8*60`, `TASK_STARTED.t == 9*60` and the `TASK_QUEUED` reason is `OFF_SHIFT`.
  - `test_pool_capacity_respected`: pool capacity 2, three tasks arrive at once with `const(60)`; third `TASK_STARTED.t == first + 60`; reason on third `TASK_QUEUED` is `ALL_RESOURCES_BUSY`.
  - `test_missing_skill_never_crashes`: step needs skill nobody has; `run()` ends; the task's last event is `TASK_QUEUED` with `NO_ELIGIBLE_RESOURCE`.
  - `test_two_step_dependency`: step 2 `TASK_CREATED.t == step 1 TASK_COMPLETED.t`.
  - `test_determinism`: `rate_per_hour = 4`, horizon 3 days, two engines seed 42 produce identical `"\n".join(e.to_json() for e in events)`; seed 43 differs.
  - `test_capacity_invariant`: walk the seed-42 log tracking in-progress count per resource (`TASK_STARTED` +1, `TASK_COMPLETED`/`TASK_FAILED`/`TASK_BLOCKED` −1) and assert `<= capacity` at every event.
  - `test_step_and_pause`: `step()` returns True and advances `now`; after `pause()`, `run()` returns with `now < horizon`; `resume(); run()` reaches horizon.

- [ ] **Step 2: Run, expect ImportError. Step 3: Implement `engine.py`. Step 4: Run, expect PASS. Step 5: Commit** `feat: discrete-event engine with hybrid resources`.

---

### Task 8: Outages, failure and rework

**Files:**
- Modify: `src/workforce_twin/engine.py`
- Test: `tests/test_engine_outage.py`

**Interfaces:**
- Consumes: `company.outages`, `Step.failure_prob`, `rework_to`, `max_retries`.
- Produces: engine attribute `system_down: dict[str, int]` (outage depth counter; down when `> 0`).

Rules:
- At init, for each `(system_id, start, end)` in `company.outages` schedule `_outage_start` at `start` and `_outage_end` at `end` (`end` may exceed horizon; then the system never comes back within the run). Counter increments/decrements so overlapping outages do not flip the system up early. Emit `SYSTEM_OUTAGE_STARTED` only on `0→1` and `SYSTEM_OUTAGE_ENDED` only on `1→0`.
- `_outage_start`: for every `IN_PROGRESS` task whose step uses the system: `remaining = scheduled_end - now`, add elapsed to `busy_minutes`, `free_slots += 1`, `transition(BLOCKED, reason=SYSTEM_DOWN, system_id=...)`, `run_token += 1`, then `_dispatch_resource` for the freed resource. (`scheduled_end` is `task.ends_at`, set by `_start` in Task 7.)
- `_eligible` / `_try_dispatch_task`: if step `system_id` is down, do not dispatch; reason `SYSTEM_DOWN` with `system_id`.
- `_outage_end`: every `BLOCKED` task on that system → `transition(QUEUED)` (emits `TASK_UNBLOCKED`, keeps `queued_at`) then `_try_dispatch_task`; then re-try every queued task whose step uses that system (in `order_key` order).
- `_finish`: before `COMPLETED`, if `rng.random() < step.failure_prob`: `transition(FAILED)`. If `instance.retries < step.max_retries`: `instance.retries += 1`; if `rework_to is None or == step.id`, `transition(task, QUEUED)` and `_try_dispatch_task`; else remove `rework_to` and `step.id` from `instance.completed`, find the completed task of `rework_to` and `transition(it, QUEUED, rework=True)` then `_try_dispatch_task(it)` (its completion recreates the failed step via the normal dependency rule). Else `transition(CANCELLED)` on the task and do not create further tasks for this instance (mark `instance.cancelled = True`).
- The random draw for failure happens even when `failure_prob == 0` (one `rng.random()` per completion) so logs stay comparable across scenarios that only change `failure_prob`.

- [ ] **Step 1: Write failing tests**:
  - `test_outage_blocks_queued_task`: outage `erp` 600–720, task needing `erp` arrives at 600; `TASK_QUEUED` reason `SYSTEM_DOWN`, `TASK_STARTED.t == 720`.
  - `test_outage_pauses_in_progress`: task `const(60)` starts at 540 on `erp`, outage 570–690; events include `TASK_BLOCKED` at 570, `TASK_UNBLOCKED` at 690, `TASK_COMPLETED` at 720; the freed employee starts another non-erp task at 570.
  - `test_overlapping_outages`: outages 600–700 and 650–800 → exactly one `SYSTEM_OUTAGE_STARTED` (600) and one `SYSTEM_OUTAGE_ENDED` (800).
  - `test_cascade_delay`: two-step workflow, step 1 uses `erp` in dept A, step 2 in dept B; compare runs with and without outage 600–720 for an arrival at 600: step 2's `TASK_QUEUED.t` differs by exactly 120.
  - `test_failure_self_rework`: `failure_prob = 1.0`, `max_retries = 2` → events contain 3 `TASK_FAILED` and 1 `TASK_CANCELLED`, no `WORKFLOW_COMPLETED`.
  - `test_rework_to_dependency`: steps a→b, b `failure_prob` driven by a seed where first completion fails (choose seed by trial in the test, assert at least one failure occurred), `rework_to="a"`, `max_retries=1`: `a` has two `TASK_COMPLETED` events before `WORKFLOW_COMPLETED`.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: system outages, failure and rework`.

---

### Task 9: Analytics

**Files:**
- Create: `src/workforce_twin/analytics.py`, `tests/test_analytics.py`

**Interfaces:**
- Consumes: `Event`, `Company`, `Schedule.on_minutes`.
- Produces: `percentile(xs: list[float], p: float) -> float` (nearest-rank on sorted list; `0.0` for empty). Dataclasses: `WorkflowMetrics(started, completed, cancelled, throughput_per_day, cycle_p50, cycle_p90, wait_p50, wait_p90, sla_breached, sla_breach_rate, failures, rework_rate, cost_per_completed)`; `ResourceMetrics(busy_minutes, on_shift_minutes, utilization, tasks_completed, blocked_minutes, labor_cost)`; `DeptMetrics(utilization, tasks_completed, backlog_max, wait_p50, labor_cost)`; `LedgerRow(department_id, reason, blocker_id: str | None, minutes, count)`; `Metrics(horizon_minutes, workflows: dict, departments: dict, resources: dict, ledger: list[LedgerRow], labor_cost: float)`. Function `compute_metrics(events: list[Event], company: Company, horizon_minutes: float) -> Metrics`.
- Definitions: cycle time = `WORKFLOW_COMPLETED.t − WORKFLOW_STARTED.t`; wait = `TASK_STARTED.t − queued time` where queued time is the latest `TASK_QUEUED` (not `TASK_UNBLOCKED`) before that start; busy minutes = sum over `TASK_STARTED → (COMPLETED | FAILED | BLOCKED)`; utilization = `busy / (on_shift_minutes × capacity)`; `on_shift_minutes = schedule.on_minutes(0, horizon)`; department utilization = busy-weighted mean of its resources; `throughput_per_day = completed / (horizon / 1440)`; `rework_rate = failures / completed-step-count`; `cost_per_completed = labor_cost / completed` (0 if none); ledger: each wait interval attributed to `(department, reason of its TASK_QUEUED, system_id or None)` and each `TASK_BLOCKED → TASK_UNBLOCKED` interval to `(department, SYSTEM_DOWN, system_id)`; rows sorted by minutes desc; `backlog_max` = max simultaneous queued tasks per department.

- [ ] **Step 1: Write failing tests** with hand-built event lists: one workflow instance queued at 0, started at 10, completed at 40, workflow completed at 40 → `cycle_p50 == 40`, `wait_p50 == 10`, ledger has one row `("cs", OFF_SHIFT, None, 10, 1)` when the queued reason was `OFF_SHIFT`; empty event list → `Metrics` with `labor_cost == 0.0` and no exception; utilization for an employee busy 240 min over a one-day 8h schedule == 0.5; `percentile([1,2,3,4], 50) == 2`.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: event-log analytics`.

---

### Task 10: Experiments, replications and comparison table

**Files:**
- Create: `src/workforce_twin/experiment.py`, `tests/test_experiment.py`

**Interfaces:**
- Consumes: `Scenario`, `RunConfig`, `Engine`, `compute_metrics`.
- Produces: `RunResult(seed, events, metrics)`; `Stat(mean, p10, p50, p90)`; `ExperimentResult(name, runs: list[RunResult], summary: dict[str, Stat])`; `KPI_KEYS = ["throughput_per_day", "cycle_p50", "cycle_p90", "wait_p50", "sla_breach_rate", "rework_rate", "mean_dept_utilization", "labor_cost"]`; `kpis(m: Metrics) -> dict[str, float]` (workflow KPIs pooled across all workflows: cycle and wait percentiles over all instances, throughput summed, plus `util_<dept_id>` per department); `run_experiment(name, scenario, config) -> ExperimentResult` (seeds `config.seed + i`, each on a fresh `scenario.materialize()`); `compare(results: list[ExperimentResult]) -> str` (plain-text table: rows = `KPI_KEYS` then `util_*`, columns = experiments, cell `mean (p10–p90)`, two decimals, first line `All parameters are assumed values; results are simulation estimates, not measurements.`); `top_ledger(result, n=5) -> list[LedgerRow]` (ledger rows summed across runs, divided by replications, top n).

- [ ] **Step 1: Write failing tests**: `run_experiment` with `replications=3` yields 3 runs with seeds 42,43,44 and run 0's log equals a direct `Engine` run with seed 42; `Stat` for `[1,2,3]` has `mean == 2`; `compare` output first line matches the assumption sentence and contains `cycle_p50`; `scenario.base` unchanged after `run_experiment`.

- [ ] **Step 2–5: Run (fail), implement, run (pass), commit** `feat: replicated experiments and comparison table`.

---

### Task 11: Reynolds example, CLI, performance smoke

**Files:**
- Create: `src/workforce_twin/examples/__init__.py`, `src/workforce_twin/examples/reynolds.py`, `src/workforce_twin/cli.py`, `src/workforce_twin/__main__.py`, `tests/test_reynolds.py`, `README.md`

**Interfaces:**
- Produces: `reynolds.build() -> Company` (resolved) and `reynolds.scenarios(base: Company) -> list[Scenario]` returning, in order: `baseline`, `demand_plus_30` (`ArrivalMultiplier(1.3)`), `erp_outage_2h` (`SystemOutage("erp", 2*1440 + 10*60, 2*1440 + 12*60)`), `extra_cs_employee` (`AddEmployee("cs", Resource(id="cs_new", department_id="cs", skills={"order_review", "ticket_triage"}, cost_per_hour=18.0, schedule=business_hours(9, 17)))`). `cli.main(argv: list[str] | None = None) -> int` with subcommand `demo --days 10 --reps 5 --seed 42 --policy priority --events-dir PATH` (optional; writes `<experiment>-<seed>.jsonl`). `__main__.py` calls `sys.exit(main())`.
- Reynolds content (spec §9): departments `supply_chain`, `it`, `finance`, `sales`, `cs`; 24 employees (ids `emp_01..emp_24`) across them with at least 4 distinct schedules (`business_hours(9,17)`, `business_hours(8,16)`, part-time `business_hours(9,13)`, 4-day week), one with a one-week absence in week 2; pools `cs_pool` headcount 12 with 3 employees carved out, `finance_pool` headcount 6, `sc_pool` headcount 8; systems `erp`, `crm`; workflows `order_modification` (7 steps across cs, supply_chain, finance, erp step in cs with `system_id="erp"`, `rate_per_hour=6`), `support_ticket` (3 steps cs→it→cs, `rate_per_hour=3`), `credit_check` (2 steps sales→finance, `rate_per_hour=2`); lognormal durations with means 10–45 min; `failure_prob` 0.02–0.08 with `max_retries=1`; SLA on the order workflow's final step `sla_minutes=480`; costs 15–40 per hour. Exact numbers are the builder's choice within these ranges.

- [ ] **Step 1: Write failing tests**: `build()` returns 24 employees and 3 pools, `cs_pool` capacity 9; `scenarios()` returns 4 with the names above; `demo --days 2 --reps 1` returns 0 and prints the assumption sentence and `cycle_p50`; performance smoke `build()` + 30 days + 1 replication completes in under 30 s (`time.perf_counter`), marked `@pytest.mark.slow` but not deselected by default.

- [ ] **Step 2–5: Run (fail), implement, run (pass).**

- [ ] **Step 6: Write `README.md`** (what it is, `uv run python -m workforce_twin demo --days 10 --reps 5 --seed 42`, pointer to spec). **Commit** `feat: Reynolds example company and demo CLI`.

- [ ] **Step 7: Run the full demo and paste the table into the task report**

Run: `uv run python -m workforce_twin demo --days 10 --reps 5 --seed 42`
Expected: table with 4 columns, `demand_plus_30` shows higher `cycle_p90` than `baseline`, `erp_outage_2h` ledger top row reason `SYSTEM_DOWN` on `erp`.
