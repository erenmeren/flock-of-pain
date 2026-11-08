# Decision tools, result accuracy and usability

All additions are optional. A Company JSON or run config without them runs exactly as before, and the pinned
event-log hashes stay unchanged. Out of scope: billing, Postgres.

## 1. Result accuracy (core)

- **Pooled percentiles.** `cycle_p50`, `cycle_p90` and `wait_p90` KPIs are true percentiles over all instances of a
  run, computed in `compute_metrics`, replacing the completed-weighted mean of per-workflow values. Per-workflow
  metrics do not change.
- **Confidence interval.** `Stat` gains `ci_low` and `ci_high`: a 95% Student t interval on the mean across
  replications. With fewer than 2 replications both equal the mean. `/simulate` summaries carry them.
- **Comparison.** `compare_to_base(base, other)` returns `{kpi: {delta, ci_low, ci_high, significant}}`, paired by
  replication index (mean(other) - mean(base)). `significant` means the interval excludes 0. With fewer than 2 pairs
  the bounds equal the delta and `significant` is false. `/simulate` adds `comparison` to every scenario after the
  first.
- **Warm-up.** Run config `warmup_days` (default 0, >= 0) is simulated in addition to `days`. Metrics cover only the
  measured window: instances arriving before the warm-up ends are excluded from workflow metrics, and busy time and
  ledger time are clipped to the window. Run-day budgets count `days + warmup_days`.
- **Initial backlog.** `initial_backlog` (int >= 0, default 0) on `arrival` or an inflow creates that many instances
  at time zero. No random numbers are consumed when it is 0.
- **Holidays.** Company `holidays` (list of int day numbers from time zero, default empty): nobody works and nothing
  arrives on those days. Work under way follows the existing shift-end rule.
- **Actuals.** Company `actuals` (`{kpi: number}`, default empty) holds observed values. It is stored and round-tripped,
  and the engine ignores it.
- **Progress and cancel.** `run_experiment(..., on_run=None)`: `on_run()` is called after each finished replication, in
  order. An exception raised by it stops the experiment, cancels pending replications and propagates.

## 2. Authentication

Tenant API keys keep working and act as role `admin`.

- `users` table: email (globally unique, lowercased), tenant, role (`admin`, `editor`, `viewer`), scrypt password hash
  with a per-user salt. Passwords have at least 10 characters.
- `sessions` table: only the SHA-256 of the token is stored. Tokens expire 7 days after login.
- `POST /auth/login` `{email, password}` returns `{token, tenant, email, role, expires_at}`; a wrong email and a wrong
  password give the same 401 and take similar time. After 10 failures for one email in 15 minutes it returns 429.
- `POST /auth/logout` deletes the current session. `GET /auth/me` returns `{tenant, email, role}` (email null for a key).
- Requests authenticate with `X-API-Key` or `Authorization: Bearer <token>`.
- `viewer` may read and run without saving. Writing (saving a company, saving a run, deleting, `/generate`) returns 403.
- Admin only: `GET /users`, `POST /users` `{email, password, role}`, `PATCH /users/{email}` `{role?, password?}`,
  `DELETE /users/{email}`, all scoped to the tenant. Removing or changing a user deletes that user's sessions. The last
  admin user cannot be removed or demoted while the tenant would have none (409).
- `POST /signup` accepts optional `email` and `password`; with both it also creates that admin user.
- CLI: `user create <tenant> <email> [--role ROLE]` (password prompted, or `FLOCK_USER_PASSWORD`), `user list <tenant>`.

## 3. Background jobs

- `POST /jobs` takes the `/simulate` body. Validation errors return 422 at once; otherwise 202 `{id}`.
- `GET /jobs/{id}` returns `{id, kind, status, done, total, result?, error?}`; status is `queued`, `running`, `done`,
  `failed` or `cancelled`. `error` is `{path, message}`.
- `DELETE /jobs/{id}` cancels. Jobs are visible only to their tenant (404 otherwise).
- In memory, one process (the hosting model is already a single uvicorn process). `FLOCK_MAX_JOBS` active jobs per
  tenant (default 2), then 429. A finished job is dropped after 1 hour.
- `/simulate` stays as it is.

## 4. Recommendations

`recommend(summary, ledger, off_shift_minutes, company)` is rule-based, without an LLM. It returns
`[{severity: "high"|"medium"|"info", kind, department_id, message}]`, in `scenarios[i].recommendations`. Rules cover
overloaded and underused departments, the top waiting reason (staff, system outage, batch hold, off-shift),
deadline misses, abandonment and rework.

## 5. Staffing optimizer

`POST /optimize` returns a job (`kind: "optimize"`). Body: `{company, scenarios, base_scenario_id?, config,
target: {kpi, op: "<="|">=", value}, candidates?: [department ids], max_hires: 10}`.

Greedy search with common random numbers forced on: each round tries +1 employee in every candidate department and keeps
the one with the best KPI improvement per added cost per hour. It stops when the target is met, using the pessimistic CI
bound. Result: `{met, stopped: "met"|"max_hires"|"no_improvement"|"budget", hires: {dept: n}, scenario,
path: [{hires, mean, ci_low, ci_high, labor_cost}]}`. `scenario` is a normal scenario with `add_employee` overlays.
A new employee copies skills, schedule, cost and speed from the department's first resource. At least 2 replications are required, since the target is judged on an interval. Total run-days stay within
`FLOCK_MAX_RUN_DAYS`.

## 6. Web

- **Runs** use `/jobs` with a progress bar and a cancel button.
- **Undo and redo** for company and scenarios: top bar buttons, Ctrl+Z and Ctrl+Shift+Z, native undo inside text fields.
- **Autosave** of a draft whose company is already saved, debounced, with its status in the sidebar. A viewer never
  autosaves.
- **Sign in** with email and password or an API key; user management on Settings for admins.
- **Getting started** card on Overview: sign in, then start from the example, a description, or empty, then run.
- **Decisions** page: parameter sweep (staff or demand, chart of a KPI, generated client-side as scenarios for `/jobs`)
  and the staffing optimizer, with "Add as scenario".
- **Analysis and Simulation**: confidence intervals, significant or within-noise labels on deltas, recommendations.
- **Reality check**: enter `actuals` per KPI, compare with simulated mean and interval.
- **Export**: results as CSV, and a print-friendly report page for PDF through the browser.
- **People CSV import** with a preview and row errors, merged into the draft.
- **Forms** for per-day hours, absences, holidays, `initial_backlog` and `warmup_days`, so the JSON tab is no longer
  required for them.
