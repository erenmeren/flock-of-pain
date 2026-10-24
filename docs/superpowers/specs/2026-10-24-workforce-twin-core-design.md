# Workforce Twin — Core Simulation Design (v0)

Date: 2026-10-24
Status: builder check done, approved for planning

## 1. Intent

Workforce Twin is an organizational digital twin: users model a company
(departments, employees, resource pools, skills, schedules, business
systems, cross-department workflows) and run discrete-event simulations
to find bottlenecks and compare what-if scenarios.

v0 proves the core simulation idea works and is trustworthy. It is a
headless Python package with a CLI. No web UI, no database, no
multi-tenancy, no real integrations, no LLM agents. Those come after
v0 shows the engine produces correct, reproducible, explainable results.

The full product vision (multi-tenant SaaS, FastAPI + PostgreSQL + Next.js,
live WebSocket playback, process mining, real AI executors) is recorded in
the master prompt and is explicitly out of scope here. v0 must not block
it: the domain model and engine must be usable unchanged behind a later
API layer.

## 2. Goals

1. One shared discrete-event engine that runs Pool, Individual and Hybrid
   resource modes through interchangeable resource types, not three
   engines.
2. A worker is never counted twice. Individuals carved out of a pool reduce
   that pool's capacity.
3. Same seed, same inputs, byte-identical event log.
4. Every metric is derived from the recorded event log, never computed
   directly inside the engine.
5. Every delay is traceable: each blocked/waiting period records a reason
   code and the resource or system it waited on.
6. Scenarios are overlays on an immutable baseline; running a scenario
   never mutates the baseline.
7. Replications: N runs with seeds `seed+i`, summarized with mean, p10,
   p50, p90.
8. A realistic synthetic company (Reynolds-inspired) and the four
   experiments from the master prompt run from one CLI command and print a
   comparison table.

## 3. Non-goals (v0)

- Web API, persistence, auth, tenants, versioned storage.
- Live playback / WebSockets. Replay = iterating the saved event log.
- Mid-run state snapshots. Pause/resume/step are supported in-process on
  the engine object; serializing a paused engine is not.
- Simulated or real AI executors. The executor abstraction exists so a
  later `SimulatedAIExecutor` is a new resource type, not an engine change.
- Automatic root cause narrative. v0 produces the blocked-reason ledger
  and dependency data that a later analysis layer consumes.
- Calibration from real data. All parameters are assumed; outputs are
  labeled "assumed".
- Performance beyond: 500 resources, 90 simulated days, ~100k task
  instances, one replication in under ~30 s on a laptop.
- Time series (WIP over time, queue length over time) and idle time:
  deferred past v0; `backlog_max` per department is the only queue-size
  metric.

## 4. Anti-goals

- Presenting simulation output as fact. Every report header says
  parameters are assumed.
- Ranking or recommending dismissal of individual employees. Utilization
  is reported per department and per pool; per-individual utilization is
  computed but reported only in the detail dump, never ranked.
- Making the engine depend on any output format.

## 5. Constraints

- Python 3.12+. Core package has zero third-party runtime dependencies
  (dataclasses, heapq, random, statistics, json). Tests use pytest.
- Package name `workforce_twin`, layout `src/workforce_twin/`, `pyproject.toml`,
  installable with `pip install -e .`.
- Simulated time is a float in minutes from simulation epoch. Calendars
  translate to weekday/hour for schedules. No wall-clock anywhere in the
  engine.
- Randomness only through one `random.Random(seed)` instance owned by the
  run. Any module needing randomness receives it; nothing calls the global
  `random`.

## 6. Domain model

All plain `@dataclass`es. Ids are strings chosen by the author of the
model (e.g. `"cs"`, `"emp_017"`). No ORM, no UUIDs.

### Organization

- `Company(id, name, departments: list[Department], systems: list[BusinessSystem], workflows: list[Workflow])`
- `Department(id, name, resources: list[Resource])`
- `Skill` is a plain string id (e.g. `"order_review"`). No proficiency
  levels in v0; eligibility is boolean.
- `Schedule(weekday_hours: dict[int, tuple[float, float]])` — working
  window per weekday 0..6 in hours, absent weekday = off. Plus
  `absences: list[tuple[start_min, end_min]]`.

### Resources (the hybrid core)

`Resource` is the single abstraction the scheduler sees:

- `id`, `department_id`, `skills: set[str]`, `schedule: Schedule`,
  `capacity: int` (concurrent task slots), `cost_per_hour: float`,
  `speed_factor: float` (multiplies sampled durations; 1.0 default).

Two concrete kinds, same class, differ by data:

- **Employee**: `capacity=1`, has `name`.
- **ResourcePool**: `capacity=headcount - carved_out`, where `carved_out`
  is the number of Employees whose `pool_id` points at this pool. Computed
  once when the company is loaded (`Company.resolve()`); the engine never
  sees the raw headcount. Pool and its carved-out Employees share the
  pool's schedule unless the Employee overrides it.

Validation at load: `headcount - carved_out >= 0`, else error. An Employee
may belong to at most one pool.

### Business systems

- `BusinessSystem(id, name)`. Availability is driven only by outage
  events scheduled from the scenario. A task whose step requires a system
  that is down cannot start and, if already in progress, is paused (its
  remaining duration is preserved and resumes when the system returns).

### Workflows

- `Workflow(id, name, steps: list[Step], arrival: ArrivalSpec)`
- `Step(id, name, department_id, required_skill, duration: Dist,
  depends_on: list[step_id], system_id: str | None, priority: int,
  sla_minutes: float | None, failure_prob: float, rework_to: step_id | None,
  max_retries: int)`
- Steps form a DAG. A step becomes `QUEUED` when all `depends_on` steps are
  `COMPLETED`. Parallel branches are steps sharing a parent. Conditional
  branching is out of v0 (every step always runs).
- Failure: on completion, with `failure_prob` the step `FAILED`; if retries
  remain it re-queues `rework_to` (default: itself) and increments the
  instance's retry counter; otherwise the instance is `CANCELLED`.
- `Dist` is a tagged union: `const(v)`, `uniform(a,b)`, `triangular(a,m,b)`,
  `lognormal(mean, sigma)`, `exponential(mean)`. All in minutes.
- `ArrivalSpec`: Poisson process with `rate_per_hour`, active only inside
  `active_hours` (weekday/hour window) so arrivals follow business hours.
  Scenario can multiply the rate.

### Task state machine

`CREATED → QUEUED → ASSIGNED → IN_PROGRESS → COMPLETED`
plus `BLOCKED` (resource assigned but system down, or no eligible resource
on shift), `FAILED`, `CANCELLED`. Transitions are the only place that emit
task events, in one function `transition(task, new_state, reason)`.
Illegal transitions raise.

### Scenario

- `Scenario(id, name, base: Company, overlays: list[Overlay])`
- Overlay kinds in v0: `ArrivalMultiplier(workflow_id, factor)`,
  `SystemOutage(system_id, start_min, end_min)`,
  `AddEmployee(department_id, employee)`, `RemoveResource(resource_id)`,
  `SetPoolHeadcount(pool_id, headcount)`, `Absence(resource_id, start, end)`.
- `Scenario.materialize() -> Company` deep-copies the base and applies
  overlays. The base object is never touched; a test asserts this.

### Run

- `RunConfig(seed, horizon_minutes, replications=1)`
- `RunResult(config, events: list[Event], metrics: Metrics)`
- `Event(t, kind, task_id, workflow_instance_id, resource_id, system_id,
  reason, payload)`; `kind` is an enum covering: TASK_CREATED, TASK_QUEUED,
  RESOURCE_ASSIGNED, TASK_STARTED, TASK_COMPLETED, TASK_FAILED,
  TASK_BLOCKED, TASK_UNBLOCKED, TASK_CANCELLED, RESOURCE_UNAVAILABLE,
  RESOURCE_AVAILABLE, SYSTEM_OUTAGE_STARTED, SYSTEM_OUTAGE_ENDED,
  SLA_BREACHED, WORKFLOW_STARTED, WORKFLOW_COMPLETED.

## 7. Engine

### Event loop

`Engine(company, config)` owns: `clock`, a `heapq` of
`(time, seq, callback)`, the RNG, the event log, resource state, queues.
`seq` is a monotonic counter so ties resolve deterministically.

Public control: `run()`, `run_until(t)`, `step()` (one scheduled
callback), `pause()`/`resume()` (flags checked by `run`). All are
in-process.

### Queues and scheduling policy

One queue per `(department_id, required_skill)`. A task enters the queue
on `QUEUED`. Scheduling happens at these moments only: a task is queued, a
resource frees a slot, a resource comes on shift, a system comes back up.

`SchedulingPolicy` is a protocol with one method
`pick(task, eligible: list[Resource]) -> Resource | None` and a queue
ordering key. v0 ships `fifo`, `priority` (then fifo), and
`least_loaded`. The policy is a run-level setting.

Eligibility: resource in the step's department, has the skill, on shift
now, not absent, has a free slot. If the step needs a system and it is
down, the task is `BLOCKED` with reason `SYSTEM_DOWN` and retried at
outage end.

Blocked reason codes: `NO_ELIGIBLE_RESOURCE`, `ALL_RESOURCES_BUSY`,
`OFF_SHIFT`, `SYSTEM_DOWN`. Each `TASK_BLOCKED` /
`TASK_QUEUED` event carries the code and, when known, the resource or
system id. Waiting time attribution in analytics comes from these.

### Shifts

A task does not start outside the resource's window. If a task's sampled
duration runs past end of shift, v0 lets it finish (overrun) and logs the
overrun minutes in the event payload. Carrying work across shifts is a
documented simplification.

### Outage propagation

`SYSTEM_OUTAGE_STARTED` pauses every `IN_PROGRESS` task on that system
(records remaining duration), blocks queued tasks needing it, and does
nothing to tasks that merely depend on those tasks: they stay
`WAITING_DEPENDENCY`, which is how the cascade shows up in analytics.

### Replications

`run_experiment(scenario, config) -> ExperimentResult` runs
`config.replications` engines with seeds `seed+i`, keeps all per-run
metrics, and produces summary stats. Event logs of individual runs are
kept in memory (list) and optionally written as JSON lines.

## 8. Analytics

`compute_metrics(events) -> Metrics`, a pure function. Computes from the
log only:

- Per workflow: throughput (completed/day), cycle time p50/p90, waiting
  time p50/p90, SLA breach rate, failure/rework rate, started/completed
  counts (the KPI table pools completion rate = completed/started).
- Per department and per resource: utilization (busy minutes / on-shift
  minutes), blocked time, tasks completed, `backlog_max` (peak queued
  tasks per department). WIP and queue-length time series and idle time
  are deferred (see Non-goals).
- Blocked-time ledger: minutes per `(department, reason_code, blocking
  resource/system)`. This is the bottleneck input.
- Cost: labor cost = busy minutes × cost_per_hour; cost per completed
  workflow.

`compare(baseline: ExperimentResult, other: ExperimentResult) -> table`
prints side-by-side mean and p10–p90 for a fixed KPI set.

## 9. Synthetic company and experiments

`workforce_twin.examples.reynolds` builds:

- Departments: Supply Chain, IT, Finance, Sales, Customer Support.
- 24 individual employees with varied schedules (some part-time, one
  on leave for a week), 3 pools (CS pool headcount 12 with 3 carved out,
  Finance pool 6, Supply Chain pool 8), ERP + CRM systems.
- Workflow "Customer Order Modification" (7 steps, 4 departments, ERP
  step), workflow "Support Ticket" (3 steps, CS + IT), workflow "Credit
  Check" (2 steps, Finance + Sales). Lognormal durations, small failure
  probabilities with rework.

CLI: `python -m workforce_twin demo --days 10 --reps 5 --seed 42` runs:

1. Baseline.
2. Arrivals ×1.3 on all workflows.
3. ERP outage, day 3, 10:00–12:00.
4. Baseline + one extra CS employee with order_review skill.

Prints one comparison table (KPIs × experiments) and, per experiment, the
top five blocked-time ledger rows. Header line states all parameters are
assumed values.

## 10. Testing

- Unit: `Dist` sampling with fixed seed, schedule on/off-shift logic,
  state machine legal/illegal transitions, pool carve-out arithmetic,
  scenario overlay does not mutate base (deep equality before/after).
- Engine determinism: same seed → identical event log (compare serialized
  logs), different seed → different log.
- Capacity invariant: at every event time, for each pool,
  `in_progress_count <= capacity`; for each employee `<= 1`. Checked by a
  test that walks the log.
- Outage: a scripted 1-system, 1-resource, 1-task scenario; assert the
  task is blocked exactly for the outage window and completes after.
- Cascade: two-step workflow across two departments; outage on step 1's
  system; assert step 2 waiting time equals the delay.
- Analytics: hand-built tiny event logs with known answers.
- Performance smoke: Reynolds, 30 days, 1 replication, under 30 s.

## 11. Left to the builder

- Internal module split inside `workforce_twin` (suggested:
  `model.py`, `dist.py`, `schedule.py`, `engine.py`, `scheduling.py`,
  `analytics.py`, `scenario.py`, `cli.py`, `examples/reynolds.py`).
- Exact KPI set in the comparison table beyond cycle time p50/p90,
  throughput, SLA breach rate, mean department utilization, labor cost.
- JSON schema for company/scenario files. v0 may define the Reynolds
  company in Python code only; file loading is optional.
- Table formatting.

## 12. Decisions made by the assistant (not by the user)

- Custom heapq event loop instead of SimPy (control over step/pause and
  deterministic tie-breaking; avoids generator state for later snapshots).
- Zero runtime dependencies.
- Minutes as the time unit; floats.
- No proficiency levels, no conditional branches, no shift carry-over
  in v0.
- Eligibility restricted to the step's department (cross-department
  skills modelled by an Employee belonging to one department but a later
  version may allow multi-department membership).

## 13. Builder check resolutions (assistant's calls)

1. **Multi-queue dispatch.** When a resource frees a slot or comes on
   shift, it scans every queue it is eligible for and takes the best task
   by the policy's global order key (`priority` desc, then queued time
   asc for `priority`; queued time only for `fifo`). When a task is
   queued, the policy chooses among eligible free resources
   (`least_loaded` uses busy minutes so far; others take the first).
   `SchedulingPolicy` therefore has two methods: `order_key(task)` and
   `choose_resource(task, eligible)`.
2. **Outage and slots.** An `IN_PROGRESS` task whose system goes down
   moves to `BLOCKED(SYSTEM_DOWN)`, its remaining duration is stored, and
   its resource slot is released so the worker can take other work. On
   `SYSTEM_OUTAGE_ENDED` the task goes back to `QUEUED` keeping its
   original queued time (so it sorts to the front) and any eligible
   resource may resume it. Queued tasks needing a down system stay
   `QUEUED` with reason `SYSTEM_DOWN`; no resource is held. Busy time =
   time in `IN_PROGRESS` only.
3. **Modes are composition, not a switch.** Hybrid means the company
   contains both pools and employees. No run-level conversion.
4. **Rework.** `rework_to` must be the step itself or one of its direct
   `depends_on` steps (validated at load). On failure with retries left:
   the `rework_to` step transitions `COMPLETED → QUEUED` (legal only for
   rework) and the failed step is re-created after it completes. The
   instance retry counter is compared with the failed step's
   `max_retries`.
5. **Analytics input.** `compute_metrics(events, company)`. On-shift
   minutes, capacities, costs and department mapping come from the
   company; the log carries only what happened.
6. **Lazy task creation.** A step's task is created when all its
   dependencies complete (`TASK_CREATED` immediately followed by
   `TASK_QUEUED`). Waiting time = `TASK_QUEUED → TASK_STARTED`. The
   cascade test asserts step 2's queued time shifts by the outage length.
   `ALL_RESOURCES_BUSY`, `OFF_SHIFT`, `NO_ELIGIBLE_RESOURCE` are reason
   codes on `TASK_QUEUED`; the `BLOCKED` state is used only for the paused
   in-progress case in item 2.
7. **SLA.** Per step, clock from `TASK_QUEUED` to `TASK_COMPLETED`;
   `SLA_BREACHED` is emitted at completion if exceeded. A workflow
   instance counts as breached if any step breached. Workflow breach rate
   = breached completed instances / completed instances.

Minor calls also fixed: time zero is Monday 00:00; lognormal takes
(mean, sigma) of the underlying normal; `AddEmployee` adds headcount, it
does not carve from a pool; `RemoveResource` on a carved-out employee
returns the slot to the pool; an absence starting mid-task lets the task
finish.
