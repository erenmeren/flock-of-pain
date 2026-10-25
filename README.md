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

- `GET /example`: Reynolds company and its four scenarios as JSON.
- `POST /simulate`: body `{"company", "scenarios", "config", "include_events"}`; returns per-scenario KPI summaries, wait ledger and runs. Schema and model errors return 422 `{"path", "message"}`, with `path` prefixed by the request section (`company.`, `scenarios[i].`, `config.`).
  One request may run at most 2000 run-days (days x replications x scenarios), or 30 with `include_events`.
- Saved companies (SQLite file from `FLOCK_DB`, default `./flock.db`; single user, no tenants): `GET /companies`, `PUT /companies/{id}` with `{"company", "scenarios"}` (validated, stored in canonical form, `company.id` must equal the URL id), `GET /companies/{id}`, `DELETE /companies/{id}`.
- Run history: `POST /simulate` with `"save": true` (plus optional `company_id`, `name`) stores the request and the result without events and returns `run_id`; `GET /runs?company_id=&limit=` lists, `GET /runs/{id}` returns request and result.
- `POST /generate`: body `{"prompt"}`, a plain-language company description; Claude returns `{"company", "scenarios"}` in the `/example` shape, validated by the same loader (one repair round). Needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile); model `claude-opus-5-5`, override with `FLOCK_MODEL`. Failures return 502 `{"path": null, "message"}`.

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

Set `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`, see `web/.env.example`) to point at the API.

One page: describe the company in words and press Generate, or edit it directly. The Editor tab has forms for systems, departments, pools and people (skills, cost, headcount, pool membership, weekly shift) and for workflows (arrival rate and window, steps with department, skill, mean duration, dependencies, system, priority, SLA, failure and rework); the JSON tab holds the full company JSON (per-day hours, absences, outages, non-lognormal durations) and the scenarios. Both views edit the same company JSON, which Run sends to `/simulate`. Nothing is saved: copy the JSON out to keep it.

Tick "Include events for playback" before Run (days x reps x scenarios must stay under 30) to get a Playback card: pick a scenario and run, scrub or play through virtual time, and watch per-department queued / in-progress / blocked counts, active outages and the live task list.
