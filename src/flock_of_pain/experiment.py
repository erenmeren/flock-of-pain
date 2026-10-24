"""Replicated experiments, KPI pooling and a plain-text comparison table."""
from collections import defaultdict
from dataclasses import dataclass, replace

from flock_of_pain.analytics import LedgerRow, Metrics, compute_metrics, percentile
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.events import Event
from flock_of_pain.scenario import Scenario

KPI_KEYS = [
    "throughput_per_day", "completion_rate", "cycle_p50", "cycle_p90", "wait_p90",
    "sla_breach_rate", "rework_rate", "mean_dept_utilization", "labor_cost",
]
ASSUMPTION = "All parameters are assumed values; results are simulation estimates, not measurements."


@dataclass
class RunResult:
    seed: int
    events: list[Event]
    metrics: Metrics


@dataclass
class Stat:
    mean: float
    p10: float
    p50: float
    p90: float


@dataclass
class ExperimentResult:
    name: str
    runs: list[RunResult]
    summary: dict[str, Stat]


def _stat(xs: list[float]) -> Stat:
    return Stat(sum(xs) / len(xs), percentile(xs, 10), percentile(xs, 50), percentile(xs, 90))


def kpis(m: Metrics) -> dict[str, float]:
    # shortcut: Metrics keeps no raw samples, so percentiles are completed-weighted
    # means of per-workflow values, not true pooled percentiles.
    ws = list(m.workflows.values())
    n = sum(w.completed for w in ws)
    steps = sum(w.steps_completed for w in ws)

    def wmean(attr: str) -> float:
        return sum(getattr(w, attr) * w.completed for w in ws) / n if n else 0.0

    utils = {f"util_{d}": dm.utilization for d, dm in m.departments.items()}
    return {
        "throughput_per_day": sum(w.throughput_per_day for w in ws),
        "completion_rate": n / started if (started := sum(w.started for w in ws)) else 0.0,
        "cycle_p50": wmean("cycle_p50"),
        "cycle_p90": wmean("cycle_p90"),
        "wait_p90": wmean("wait_p90"),
        "sla_breach_rate": sum(w.sla_breached for w in ws) / n if n else 0.0,
        "rework_rate": sum(w.failures for w in ws) / steps if steps else 0.0,
        "mean_dept_utilization": sum(utils.values()) / len(utils) if utils else 0.0,
        "labor_cost": m.labor_cost,
        **utils,
    }


def run_experiment(name: str, scenario: Scenario, config: RunConfig) -> ExperimentResult:
    runs = []
    for i in range(config.replications):
        company = scenario.materialize()
        engine = Engine(company, replace(config, seed=config.seed + i))
        engine.run()
        runs.append(RunResult(config.seed + i, engine.events,
                              compute_metrics(engine.events, company, config.horizon_minutes)))
    per_run = [kpis(r.metrics) for r in runs]
    keys = per_run[0].keys() if per_run else []
    return ExperimentResult(name, runs, {k: _stat([p.get(k, 0.0) for p in per_run]) for k in keys})


def compare(results: list[ExperimentResult]) -> str:
    utils = sorted({k for r in results for k in r.summary if k.startswith("util_")})
    header = ["KPI", *(r.name for r in results)]
    rows = [header]
    for k in [*KPI_KEYS, *utils]:
        cells = [k]
        for r in results:
            s = r.summary.get(k)
            cells.append(f"{s.mean:.2f} ({s.p10:.2f}–{s.p90:.2f})" if s else "-")
        rows.append(cells)
    widths = [max(len(row[i]) for row in rows) for i in range(len(header))]
    lines = [" | ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip() for row in rows]
    return "\n".join([ASSUMPTION, *lines])


def top_ledger(result: ExperimentResult, n: int = 5) -> list[LedgerRow]:
    acc: dict[tuple, list] = defaultdict(lambda: [0.0, 0])
    for run in result.runs:
        for r in run.metrics.ledger:
            a = acc[r.department_id, r.reason, r.blocker_id]
            a[0] += r.minutes
            a[1] += r.count
    k = len(result.runs) or 1
    rows = [LedgerRow(d, reason, b, m / k, c / k) for (d, reason, b), (m, c) in acc.items()]
    rows.sort(key=lambda r: (-r.minutes, r.department_id, r.reason or "", r.blocker_id or ""))
    return rows[:n]
