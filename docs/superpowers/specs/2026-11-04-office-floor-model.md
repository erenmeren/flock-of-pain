# Office-floor model: demand profiles, cut-off deadlines, branching, wait steps, split shifts

Date: 2026-11-04. Status: approved by the user 2026-11-04 ("tamam bunlara basla").

## 1. Intent

The first real company to model is the office floor of a UK foodservice wholesaler (order desk, telesales, credit control, procurement, planning, complaints). Five things the current model cannot express make its queues disagree with reality: demand that peaks before the daily order cut-off, work that is late when it misses the cut-off rather than after N minutes, orders that take different paths, time spent waiting on a customer or supplier with nobody working, and shifts with a lunch break or split hours.

Everything here is an additive, optional extension of the Company JSON. A company written before this spec loads and runs byte-identically (the pinned event-log hashes in `tests/test_engine_determinism.py` must not change). The engine draws from the seeded RNG only for features a company actually uses.

## 2. Contract changes (`src/flock_of_pain/io.py`, mirrored in `web/lib/company.ts`)

### 2.1 Demand profile on `arrival` and on each inflow

```json
"arrival": {
  "rate_per_hour": 20,
  "window": {"weekday_hours": {"0": [8, 18], "...": "..."}},
  "profile": {
    "hours": {"8": 0.4, "9": 0.8, "16": 1.6, "17": 2.0},
    "weekdays": {"0": 1.3, "4": 0.7}
  }
}
```

- `profile` is optional. `hours` keys are hour-of-day `"0"`..`"23"` (an overnight window's hour 25 reads as 1); `weekdays` keys are `"0"`..`"6"`. Values are multipliers `>= 0`, default `1.0` for a missing key. `rate_per_hour` is the base rate; the effective rate at time t is `rate_per_hour * hours[hour(t)] * weekdays[weekday(t)]`.
- Engine: non-homogeneous Poisson by thinning. Candidates are drawn at `rate_per_hour * max(hours) * max(weekdays)`; each candidate is accepted with probability `mult(t) / max_mult` using one extra `rng.random()`. Without a `profile` nothing changes: no extra draw, same stream, same hashes.
- Validation: unknown keys, negative values and a profile whose every multiplier is 0 are `SchemaError`s. `MAX_RATE_PER_HOUR` applies to `rate_per_hour * max_mult`.
- `company_to_dict` writes `profile` only when present.

### 2.2 Windowed `arrival_multiplier` overlay (seasonality)

The existing overlay gains optional `start` and `end` in minutes from time zero:

```json
{"type": "arrival_multiplier", "factor": 1.5, "workflow_id": null, "start": 28800, "end": 57600}
```

Without `start`/`end` the overlay behaves as today (whole horizon, applied at materialize). With a window the factor applies only to arrivals whose time falls inside `[start, end)`, again by thinning against the max factor. `end > start` is required.

### 2.3 Cut-off deadline on a workflow and the `edd` policy

```json
{"id": "order_to_invoice", "name": "...", "cutoff_hour": 22, "steps": [...]}
```

- `cutoff_hour` is optional, `0 <= cutoff_hour < 24`. An instance that starts at time t is due at the next moment whose hour-of-day equals `cutoff_hour` (same day if t is before it, otherwise the next day; weekends count as days).
- Engine: `Instance.due_at` is set at start. Every task created for that instance carries `due_at`. At `due_at` the engine fires one `DEADLINE_MISSED` event for the instance if it has not completed (a heap callback scheduled at instance start; it checks completion and no-ops otherwise). Instances without a cut-off never get the callback, so the stream and hashes are unchanged for them.
- New scheduling policy `edd` (earliest due date) in `scheduling.py`: `order_key = (due_at or +inf, -priority, queued_at, id)`; `choose_resource` as `Priority`. `run_config.policy` accepts `"edd"`. Fifo/priority/least_loaded ignore `due_at`.
- Analytics per workflow: `deadline_missed` (count of `DEADLINE_MISSED` events) and `deadline_miss_rate = deadline_missed / started`. `deadline_miss_rate` joins `KPI_KEYS` after `sla_breach_rate`. The web `KPI_LABEL`, `BASE_KPIS` and `hints.ts` gain the key ("Missed cut-off %").

### 2.4 Probabilistic branching on a step

```json
{"id": "intake", "...": "...", "branches": [{"to": "credit_check", "prob": 0.15}, {"to": "stock_query", "prob": 0.05}]}
```

- `branches` is optional. Each `to` is a step id in the same workflow that lists the branching step in its `depends_on`; `prob` values are in `[0, 1]` and sum to `<= 1`. A step may be the target of at most one branching step. The remaining probability means "none of the targets".
- Semantics: a step that appears in some `branches` list is *conditional*. When the branching step completes, the engine draws one `rng.random()` and activates exactly one target (or none). Targets not chosen are *skipped* for this instance. A skipped step counts as done for its dependents (so the workflow continues past it) and creates no task and no events. The instance completes when every non-skipped step is done.
- A skipped step that is itself a branching step skips all of its targets. Dependents of a skipped step that are also conditional stay governed by their own branching step.
- Without `branches` nothing changes (no draw).
- Draft mode (`draft=True`) tolerates missing targets and probabilities that do not sum correctly; a real run rejects them with `ModelError`.
- Analytics: skipped steps add nothing (no task, no wait, no completion). `rework_to` may still point at a conditional step; rework re-activates it.

### 2.5 Wait step (nobody works)

```json
{"id": "await_customer", "name": "Await customer reply", "department_id": "credit", "required_skill": null, "duration": {"kind": "lognormal_mean", "mean": 240, "sigma": 0.6}}
```

- `required_skill: null` makes a wait step. `department_id` stays required (it says who is waiting; cycle time is attributed there). `system_id` must be null, `failure_prob` must be 0, `rework_to` null, `priority`/`sla_minutes` allowed but unused (no queue).
- Engine: when ready, the step starts at once with no resource and completes after one duration draw. Events: `TASK_CREATED`, `TASK_STARTED` (resource null), `TASK_COMPLETED`. No `TASK_QUEUED`, no utilization, no wait sample, no ledger row. Draft mode treats it like any other step.
- `agent._validate`'s "every step skill is held in its department" check skips wait steps. The agent system prompt documents the form.

### 2.6 Several windows per weekday

`weekday_hours` values accept either one pair or a list of pairs:

```json
"weekday_hours": {"0": [[9, 13], [14, 17.5]], "1": [9, 17], "...": "..."}
```

- Internal `Schedule.weekday_hours: dict[int, list[tuple[float, float]]]`. `schedule_from_dict` normalises a single pair to a one-element list. Windows within a day must be sorted and non-overlapping, each `0 <= start < end <= start + 24`, and a window may not overlap the next day's first window after the day roll (same rule as the overnight check, applied per window).
- `_segments`, `is_on`, `next_on`, `next_off`, `on_minutes`, `business_hours` and the engine's on/off event loop iterate windows. With one window per day behaviour and hashes are unchanged.
- `company_to_dict` writes a bare pair when a day has exactly one window, so existing files round-trip byte-identically.
- Web `Schedule` type: `Record<string, Hours | Hours[]>`. The schedule editor keeps its one-row "uniform" view for the first window and gains an "Add break" affordance that splits the window at a chosen hour (two windows); a second row edits the second window; "Remove break" merges back. Days are still edited together (the uniform model the editor already has); per-day lists that differ keep working through the raw JSON.

## 3. Web

- `checkCompany` accepts the new shapes and rejects: `branches` whose `to` is not a step in the workflow; a wait step with a system; `cutoff_hour` outside `[0, 24)`; `profile` multipliers that are not numbers.
- Canvas (`web/components/process/`): a wait step renders with a dashed border and an hourglass glyph instead of the department chip; a conditional step shows its probability on the incoming edge label (`15%`); a workflow with `cutoff_hour` shows "Cut-off 22:00" in the header next to the name.
- Detail panel: step skill picker gets a first option "Waiting (nobody works)" that sets `required_skill: null`; a "Branches" section on a step lists its outgoing `depends_on` children with a probability box each (empty = always). Inflow panel and the arrival panel get a "Demand profile" disclosure with a 24-hour bar row (one small number input per hour, default 1) and a 7-day row.
- Scenario Lab: the arrival multiplier form gets optional start/end day+hour pickers (minutes computed as today's `DAY`/`minuteLabel` helpers do).
- Simulation page: policy select gains `edd`. Analysis/Overview KPI tables show `deadline_miss_rate` when any workflow has a cut-off (0 otherwise; show it always, it is one more column).
- `scripts/check.ts`: asserts for `checkCompany` on each new shape, for `derive.ts` where a wait step or skipped step could affect `handoffs`/`mapEdges` (a wait step still has a department, so hand-offs count as before), and for the schedule split/merge helpers.

## 4. Out of scope

Batch/wave processing, abandonment, overtime cost, common random numbers per scenario, CSV calibration. Each is its own spec.

## 5. Acceptance

- `pytest -q` green, pinned hashes unchanged, `examples/reynolds.json` round-trips byte-identically.
- New tests: profile thinning changes arrival counts in the expected direction and is deterministic; windowed multiplier only affects its window; `edd` orders by due date; `DEADLINE_MISSED` fires once per late instance and never for an on-time one; `deadline_miss_rate` KPI; branching chooses each target at roughly its probability over many instances and skipped steps never create tasks; a wait step completes with no resource and no utilization; split shifts produce the right on/off events and `on_minutes`; one-window schedules round-trip as a bare pair.
- Web: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` green.
