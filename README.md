# Flock of Pain

Flock of Pain is a zero-dependency Python discrete-event simulation of how work flows through a company's people, pools and business systems.
You describe departments, employees with schedules and skills, staffing pools, systems and multi-step workflows, then run replicated experiments.
Scenario overlays (more demand, a system outage, an extra hire) change a copy of the baseline, and the tool compares KPIs across them.
Every run records an event log, and a blocked-time ledger attributes waiting to a department, a reason and a blocker.
Reports stay at department level; there is no per-individual utilization output.

## Install and test

```sh
uv sync --extra dev
uv run --extra dev pytest
```

## Demo

```sh
uv run python -m flock_of_pain demo --days 10 --reps 5 --seed 42
```

Options: `--policy` picks the dispatch policy, `--events-dir PATH` writes one `<experiment>-<seed>.jsonl` event log per run, and `--company PATH` runs the scenarios against a company JSON file instead of the built-in Reynolds company.
`uv run python -m flock_of_pain export-example PATH` writes the Reynolds company as JSON, a starting point for `--company`.
`uv run python -m flock_of_pain calibrate arrivals FILE.csv [--column N]` and `calibrate durations FILE.csv [--column N]` print a fitted arrival rate and profile or a duration distribution as JSON (see Calibration).
`uv run --extra api python -m flock_of_pain generate "a 40-person e-commerce support team ..." --out c.json` asks Claude for a company plus scenarios (see API `/generate`); `demo --company c.json` then runs those scenarios.
The demo runs the synthetic Reynolds company (`src/flock_of_pain/examples/reynolds.py`) under four scenarios: baseline, demand +30%, a 2-hour ERP outage, and one extra CS employee.

All demo parameters are assumed values, not measurements.

## API

```
uv run --extra api uvicorn flock_of_pain.api:app
```

Every endpoint except `GET /example` needs a tenant API key in the `X-API-Key` header (401 otherwise). Create one with `uv run --extra api python -m flock_of_pain tenant create <id> [--name NAME]` (the key is printed once; only its SHA-256 is stored), rotate with `tenant rotate <id>`, list with `tenant list`. Each tenant sees only its own saved companies and runs. `POST /signup` with `{"id", "name"?, "invite"}` creates a tenant and returns `{"id", "key"}` once when `FLOCK_SIGNUP_CODE` is set (404 when it is not, 401 on a wrong code, 409 when the id exists, 403 once `FLOCK_MAX_TENANTS` tenants exist); the Settings page has the same form.

- `GET /example`: Reynolds company and its four scenarios as JSON.
- `POST /simulate`: body `{"company", "scenarios", "config", "include_events"}`; returns per-scenario KPI summaries, wait ledger and runs. Schema and model errors return 422 `{"path", "message"}`, with `path` prefixed by the request section (`company.`, `scenarios[i].`, `config.`).
  One request may run at most 2000 run-days (days x replications x scenarios), or 30 with `include_events`.
  A workflow carries either `arrival` or `inflows` (`[{id, name, rate_per_hour, window, entry: [step ids]}]`); each inflow runs as its own engine workflow (`order.phone`, `order.web`; the workflow id itself when there is one inflow) and KPIs are reported per channel. `layout` (`{id: [x, y]}`) is stored and ignored by the engine.
- Saved companies (SQLite file from `FLOCK_DB`, default `./flock.db`, scoped to the tenant; a pre-tenant database is migrated to the tenant `default`, rotate its key first): `GET /companies`, `PUT /companies/{id}` with `{"company", "scenarios"}` (validated, stored in canonical form, `company.id` must equal the URL id; a draft is accepted: steps without department or skill, inflows without entries and workflows with neither `arrival` nor `inflows` are stored, and `/simulate` rejects them with 422), `GET /companies/{id}`, `DELETE /companies/{id}` (also deletes that company's saved runs). Creating a new company id past `FLOCK_MAX_COMPANIES` returns 409; updates are always allowed.
- Run history: `POST /simulate` with `"save": true` (plus optional `company_id`, `name`) stores the request and the result without events and returns `run_id`; `GET /runs?company_id=&limit=` lists, `GET /runs/{id}` returns request and result, `DELETE /runs/{id}` deletes one. Each tenant keeps its newest `FLOCK_MAX_RUNS` runs; older ones are deleted on save.
- `POST /generate`: body `{"prompt"}`, a plain-language company description; Claude returns `{"company", "scenarios"}` in the `/example` shape, validated by the same loader (one repair round). Needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile); model `claude-opus-5-5`, override with `FLOCK_MODEL`. Failures return 502 `{"path": null, "message"}`. Each tenant gets `FLOCK_GENERATE_DAILY_LIMIT` calls per UTC day (default 20; a failed call counts), then 429; all tenants together get `FLOCK_GENERATE_GLOBAL_DAILY_LIMIT` (default 200), then 429.
- `POST /calibrate/arrivals` with `{"timestamps": ["2026-10-06T09:14:00", ...]}` (ISO 8601; the wall clock as written counts, an offset is ignored) returns `{"rate_per_hour", "profile", "observed_days"}`; `POST /calibrate/durations` with `{"minutes": [...]}` returns `{"kind": "lognormal_mean", "mean", "sigma", "n", "p50", "p90"}`. At most 100000 entries each (and the 2 MB body cap); fewer than 2 usable values or a bad entry returns 422.

### Calibration

Calibration fits model inputs to observed data instead of guessing them. Arrivals: timestamps are grouped by calendar date (dates without arrivals are not observed); `rate_per_hour` is the mean hourly count over hours that have arrivals, and `hours` / `weekdays` are multipliers against that mean and against the mean weekday total (rounded to 2 decimals, 1.0 omitted). Durations: a lognormal with the sample mean and the population standard deviation of `log(x)` (clamped to 0.05..2); values <= 0 are dropped. Put the result into an `arrival` or inflow and a step `duration`. The fit sees only the data: arrivals already shaped by queueing or durations that include waiting are fitted as they are.

## Hosting

The API is a single uvicorn process over one SQLite file; put TLS in front of it (Caddy, nginx) and keep the file on persistent storage.

```
FLOCK_DB=/data/flock.db FLOCK_CORS_ORIGINS=https://twin.example.com FLOCK_SIGNUP_CODE=<invite> ANTHROPIC_API_KEY=... \
  uv run --extra api uvicorn flock_of_pain.api:app --host 0.0.0.0 --port 8000
cd web && NEXT_PUBLIC_API_URL=https://api.twin.example.com npm run build && npm start
```

- `FLOCK_CORS_ORIGINS`: comma-separated browser origins allowed to call the API (default the local dev server).
- `FLOCK_SIGNUP_CODE`: enables `POST /signup`; unset keeps tenant creation on the CLI.
- `FLOCK_GENERATE_DAILY_LIMIT`: per-tenant cap on `POST /generate` (the one endpoint that spends Claude tokens); 0 turns it off.
- `FLOCK_GENERATE_GLOBAL_DAILY_LIMIT`: cap on `POST /generate` for all tenants together per UTC day (default 200), so new signups cannot raise the Claude spend.
- `FLOCK_MAX_RUN_DAYS`: cap on days × replications × scenarios per `/simulate` (default 2000, 422 above it). Replications run on all CPU cores, so raise it on a bigger machine.
- `FLOCK_MAX_TENANTS`: `POST /signup` returns 403 once this many tenants exist (default 100; the CLI is not capped).
- `FLOCK_MAX_COMPANIES`: saved companies per tenant (default 50).
- `FLOCK_MAX_RUNS`: saved runs kept per tenant, oldest deleted first (default 200).
- Limits are read once at startup; a non-integer value stops the server from starting. Request bodies over 2 MB get 413.
- Docker: `docker compose up --build` starts the API (port 8000, database in the `flock-data` volume) and the web app (port 3000); set `NEXT_PUBLIC_API_URL`, `FLOCK_CORS_ORIGINS`, `FLOCK_SIGNUP_CODE` and `ANTHROPIC_API_KEY` in the environment or a `.env` file next to `compose.yaml`. CI (`.github/workflows/ci.yml`) runs pytest and the web lint, type check, tests and build on every push.
- Back up the database while the API runs with `uv run python -m flock_of_pain backup /backups/flock-$(date +%F).db` (SQLite online backup of `FLOCK_DB`).
- `NEXT_PUBLIC_API_URL` is baked in at `npm run build`.
- The tenant key lives in the browser's localStorage, so serve the web app over HTTPS only and treat the key like a password: rotate it with `tenant rotate <id>` if the browser is shared.

## Docs

- Core spec: `docs/superpowers/specs/2026-10-24-workforce-twin-core-design.md`
- Core plan: `docs/superpowers/plans/2026-10-24-workforce-twin-core.md`
- Phase-1 (JSON I/O and API) spec: `docs/superpowers/specs/2026-10-24-flock-of-pain-io-api-design.md`
- Phase-1 plan: `docs/superpowers/plans/2026-10-24-flock-of-pain-io-api.md`
- Phase-2a (AI agent) spec: `docs/superpowers/specs/2026-10-24-flock-of-pain-agent-design.md`
- Office-floor model spec: `docs/superpowers/specs/2026-11-04-office-floor-model.md`

## Model features

Optional Company JSON additions; a file without them runs exactly as before.

- Demand profile: hour-of-day and weekday rate multipliers on `arrival` or an inflow, default 1.0 per missing key:
  `"profile": {"hours": {"16": 1.6, "17": 2.0}, "weekdays": {"4": 0.7}}`.
- Seasonal surge: an `arrival_multiplier` overlay with a window in minutes from time zero:
  `{"type": "arrival_multiplier", "factor": 1.5, "workflow_id": null, "start": 28800, "end": 57600}`.
- Daily cut-off: `"cutoff_hour": 22` on a workflow; an instance not done by the next 22:00 logs `DEADLINE_MISSED`
  (KPI `deadline_miss_rate`). Run policy `"edd"` serves the earliest due date first.
- Branching: `"branches": [{"to": "credit_check", "prob": 0.15}]` on a step; each target depends on the step, and targets not drawn are skipped.
- Wait step: `"required_skill": null` waits for its duration (a customer reply, say) with nobody working.
- Split shifts: `"weekday_hours": {"0": [[9, 13], [14, 17.5]], "1": [9, 17]}`.
- Batch release: `"release_hours": [12, 17]` on a step holds its new tasks (`BATCH_HOLD` in the ledger) until the next listed hour.
- Abandonment: `"patience": {"kind": "lognormal_mean", "mean": 4, "sigma": 0.6}` on a step; a task still queued after its drawn patience logs `TASK_ABANDONED` and its instance is cancelled (KPI `abandon_rate`).
- Overtime cost: `"overtime_rate": 1.5` on a resource charges busy minutes outside its shift at 1.5x `cost_per_hour`; carved employees inherit the pool's rate (KPI `overtime_hours_per_day`).
- Common random numbers: `"crn": true` in the run config gives arrivals, durations, failures, branches and patience their own random streams, so scenario differences come from the change, not the dice.

## Web

```
cd web && npm install && npm run dev
```

Set `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`, see `web/.env.example`) to point at the API. Paste a tenant API key on the Settings page; the browser keeps it in localStorage, together with the working draft (company, scenarios, run settings), so a reload keeps your edits.

Pages (left sidebar): Overview (counts, department map, first process flow, active scenarios, last-run KPIs and what-if deltas), Organization (departments, people, pools and systems, each with its own CRUD table; pool membership keeps capacity: a person joining a pool adds one head, leaving subtracts one), Processes (one card per workflow with its step chain; click Edit for the canvas: drag department chips in as steps, connect them with arrows, add inflow nodes for each entry channel), Scenario Lab (scenarios and their overlays as forms, plus the base company's planned outages), Simulation (seed, days, replications, policy, events for playback, save to history; results, playback and blocked-time ledgers), Analysis (run history, KPI bars with deltas vs the first scenario, per-department utilization), Settings (API key, Generate with Claude, saved companies, raw company and scenarios JSON with Apply, download). The top bar picks a saved company or the Reynolds example, saves the draft under its company id (SQLite via the API) and runs the simulation.

Tick "Include events for playback" before Run (days x reps x scenarios must stay under 30) to get a Playback card: pick a scenario and run, scrub or play through virtual time, and watch per-department queued / in-progress / blocked counts, active outages and the live task list.
