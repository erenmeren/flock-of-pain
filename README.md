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
`uv run --extra api python -m flock_of_pain generate "a 40-person e-commerce support team ..." --out c.json` asks Claude for a company plus scenarios (see API `/generate`); `demo --company c.json` then runs those scenarios.
The demo runs the synthetic Reynolds company (`src/flock_of_pain/examples/reynolds.py`) under four scenarios: baseline, demand +30%, a 2-hour ERP outage, and one extra CS employee.

All demo parameters are assumed values, not measurements.

## API

```
uv run --extra api uvicorn flock_of_pain.api:app
```

Every endpoint except `GET /example` needs a tenant API key in the `X-API-Key` header (401 otherwise). Create one with `uv run --extra api python -m flock_of_pain tenant create <id> [--name NAME]` (the key is printed once; only its SHA-256 is stored), rotate with `tenant rotate <id>`, list with `tenant list`. Each tenant sees only its own saved companies and runs. `POST /signup` with `{"id", "name"?, "invite"}` creates a tenant and returns `{"id", "key"}` once when `FLOCK_SIGNUP_CODE` is set (404 when it is not, 401 on a wrong code, 409 when the id exists); the Settings page has the same form.

- `GET /example`: Reynolds company and its four scenarios as JSON.
- `POST /simulate`: body `{"company", "scenarios", "config", "include_events"}`; returns per-scenario KPI summaries, wait ledger and runs. Schema and model errors return 422 `{"path", "message"}`, with `path` prefixed by the request section (`company.`, `scenarios[i].`, `config.`).
  One request may run at most 2000 run-days (days x replications x scenarios), or 30 with `include_events`.
  A workflow carries either `arrival` or `inflows` (`[{id, name, rate_per_hour, window, entry: [step ids]}]`); each inflow runs as its own engine workflow (`order.phone`, `order.web`; the workflow id itself when there is one inflow) and KPIs are reported per channel. `layout` (`{id: [x, y]}`) is stored and ignored by the engine.
- Saved companies (SQLite file from `FLOCK_DB`, default `./flock.db`, scoped to the tenant; a pre-tenant database is migrated to the tenant `default`, rotate its key first): `GET /companies`, `PUT /companies/{id}` with `{"company", "scenarios"}` (validated, stored in canonical form, `company.id` must equal the URL id; a draft is accepted: steps without department or skill, inflows without entries and workflows with neither `arrival` nor `inflows` are stored, and `/simulate` rejects them with 422), `GET /companies/{id}`, `DELETE /companies/{id}`.
- Run history: `POST /simulate` with `"save": true` (plus optional `company_id`, `name`) stores the request and the result without events and returns `run_id`; `GET /runs?company_id=&limit=` lists, `GET /runs/{id}` returns request and result.
- `POST /generate`: body `{"prompt"}`, a plain-language company description; Claude returns `{"company", "scenarios"}` in the `/example` shape, validated by the same loader (one repair round). Needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile); model `claude-opus-5-5`, override with `FLOCK_MODEL`. Failures return 502 `{"path": null, "message"}`. Each tenant gets `FLOCK_GENERATE_DAILY_LIMIT` calls per UTC day (default 20; a failed call counts), then 429.

## Hosting

The API is a single uvicorn process over one SQLite file; put TLS in front of it (Caddy, nginx) and keep the file on persistent storage.

```
FLOCK_DB=/data/flock.db FLOCK_CORS_ORIGINS=https://twin.example.com FLOCK_SIGNUP_CODE=<invite> ANTHROPIC_API_KEY=... \
  uv run --extra api uvicorn flock_of_pain.api:app --host 0.0.0.0 --port 8000
cd web && NEXT_PUBLIC_API_URL=https://api.twin.example.com npm run build && npm start
```

- `FLOCK_CORS_ORIGINS`: comma-separated browser origins allowed to call the API (default the local dev server).
- `FLOCK_SIGNUP_CODE`: enables `POST /signup`; unset keeps tenant creation on the CLI.
- `FLOCK_GENERATE_DAILY_LIMIT`: per-tenant cap on `POST /generate` (the one endpoint that spends Claude tokens).
- `NEXT_PUBLIC_API_URL` is baked in at `npm run build`.
- The tenant key lives in the browser's localStorage, so serve the web app over HTTPS only and treat the key like a password: rotate it with `tenant rotate <id>` if the browser is shared.

## Docs

- Core spec: `docs/superpowers/specs/2026-10-24-workforce-twin-core-design.md`
- Core plan: `docs/superpowers/plans/2026-10-24-workforce-twin-core.md`
- Phase-1 (JSON I/O and API) spec: `docs/superpowers/specs/2026-10-24-flock-of-pain-io-api-design.md`
- Phase-1 plan: `docs/superpowers/plans/2026-10-24-flock-of-pain-io-api.md`
- Phase-2a (AI agent) spec: `docs/superpowers/specs/2026-10-24-flock-of-pain-agent-design.md`

## Web

```
cd web && npm install && npm run dev
```

Set `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`, see `web/.env.example`) to point at the API. Paste a tenant API key on the Settings page; the browser keeps it in localStorage, together with the working draft (company, scenarios, run settings), so a reload keeps your edits.

Pages (left sidebar): Overview (counts, department map, first process flow, active scenarios, last-run KPIs and what-if deltas), Organization (departments, people, pools and systems, each with its own CRUD table; pool membership keeps capacity: a person joining a pool adds one head, leaving subtracts one), Processes (one card per workflow with its step chain; click Edit for the canvas: drag department chips in as steps, connect them with arrows, add inflow nodes for each entry channel), Scenario Lab (scenarios and their overlays as forms, plus the base company's planned outages), Simulation (seed, days, replications, policy, events for playback, save to history; results, playback and blocked-time ledgers), Analysis (run history, KPI bars with deltas vs the first scenario, per-department utilization), Settings (API key, Generate with Claude, saved companies, raw company and scenarios JSON with Apply, download). The top bar picks a saved company or the Reynolds example, saves the draft under its company id (SQLite via the API) and runs the simulation.

Tick "Include events for playback" before Run (days x reps x scenarios must stay under 30) to get a Playback card: pick a scenario and run, scrub or play through virtual time, and watch per-department queued / in-progress / blocked counts, active outages and the live task list.
