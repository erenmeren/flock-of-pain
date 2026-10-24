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

Options: `--policy` picks the dispatch policy, and `--events-dir PATH` writes one `<experiment>-<seed>.jsonl` event log per run.
The demo runs the synthetic Reynolds company (`src/flock_of_pain/examples/reynolds.py`) under four scenarios: baseline, demand +30%, a 2-hour ERP outage, and one extra CS employee.

All demo parameters are assumed values, not measurements.

## Docs

- Spec: `docs/superpowers/specs/2026-10-24-flock-of-pain-core-design.md`
- Plan: `docs/superpowers/plans/2026-10-24-flock-of-pain-core.md`
