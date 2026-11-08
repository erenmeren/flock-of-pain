"""Greedy staffing search: adds the employee with the best KPI gain per added cost per hour until a target is met (pure)."""
from collections.abc import Callable
from dataclasses import dataclass, replace
from itertools import count

from flock_of_pain.engine import RunConfig
from flock_of_pain.experiment import KPI_KEYS, run_experiment
from flock_of_pain.io import SchemaError, _done, _get, _obj, scenario_to_dict
from flock_of_pain.model import Company, Resource
from flock_of_pain.scenario import AddEmployee, Scenario
from flock_of_pain.schedule import Schedule

MAX_HIRES = 50
COST_FLOOR = 1e-9  # a free hire divides by this, so it ranks best


@dataclass
class Plan:
    base: Scenario
    scenario_ids: set[str]
    config: RunConfig
    kpi: str
    op: str
    value: float
    candidates: list[str]
    templates: dict[str, Resource]  # department -> what a new employee there looks like
    taken_ids: set[str]
    max_hires: int
    rounds: int  # how many the budget pays for, at most max_hires

    @property
    def total(self) -> int:
        return self.config.replications * (1 + self.rounds * len(self.candidates))


def _template(source: Resource, pools: dict[str, Resource]) -> Resource:
    """A new one-person employee, also when the source is a pool of many or is carved from one. Absences are personal, so not copied."""
    pool = pools.get(source.pool_id)
    overtime = source.overtime_rate if source.overtime_rate is not None or pool is None else pool.overtime_rate
    return Resource("", source.department_id, set(source.skills), cost_per_hour=source.cost_per_hour,
                    speed_factor=source.speed_factor, schedule=Schedule(source.schedule.weekday_hours), overtime_rate=overtime)


def plan(company: Company, scenarios: list[Scenario], config: RunConfig, target: dict, candidates: list[str] | None,
         max_hires: int, base_scenario_id: str | None, max_run_days: float, max_runs: int) -> Plan:
    """Validates the request; every error is a SchemaError raised before any run."""
    target = _obj(target, "target")
    kpi, op, value = _get(target, "kpi", "target", str), _get(target, "op", "target", str), _get(target, "value", "target", float)
    _done(target, "target")
    if kpi not in KPI_KEYS and kpi not in {f"util_{d.id}" for d in company.departments}:
        raise SchemaError("target.kpi", f"unknown KPI {kpi!r}")
    if op not in ("<=", ">="):
        raise SchemaError("target.op", 'must be "<=" or ">="')
    if config.replications < 2:
        raise SchemaError("config.replications", "must be at least 2: the target is judged on a confidence interval")
    if not 1 <= max_hires <= MAX_HIRES:
        raise SchemaError("max_hires", f"must be between 1 and {MAX_HIRES}")
    if not scenarios:
        raise SchemaError("scenarios", "the optimizer needs a base scenario")
    base = next((s for s in scenarios if base_scenario_id in (None, s.id)), None)
    if base is None:
        raise SchemaError("base_scenario_id", f"unknown scenario {base_scenario_id!r}")

    made = base.materialize()  # what the base scenario really has: its overlays can add or remove the first resource
    departments = {d.id: d for d in made.departments}
    if candidates is None:
        candidates = [d.id for d in made.departments if d.resources]
    elif not candidates:
        raise SchemaError("candidates", "give at least one department, or leave it out for all")
    for i, d in enumerate(candidates):
        if d not in departments:
            raise SchemaError(f"candidates[{i}]", f"unknown department {d!r}")
        if not departments[d].resources:
            raise SchemaError(f"candidates[{i}]", f"department {d!r} has no resource to copy from")
    candidates = list(dict.fromkeys(candidates))
    if not candidates:
        raise SchemaError("candidates", "no department has a resource to copy from")

    reps = config.replications
    budget = min(max_runs, int(max_run_days * 1440 / config.horizon_minutes))
    rounds = min(max_hires, (budget - reps) // (reps * len(candidates)))
    if rounds < 1:
        need = reps * (1 + len(candidates))
        raise SchemaError("config", f"days x replications x (1 + candidates) = {need * config.horizon_minutes / 1440:g} run-days "
                                    f"in {need} runs for one round exceeds the limit of {max_run_days} run-days or {max_runs} runs")
    pools = {r.id: r for r in made.resources() if r.is_pool}
    return Plan(base, {s.id for s in scenarios}, replace(config, crn=True), kpi, op, value, candidates,
                {d: _template(departments[d].resources[0], pools) for d in candidates},
                {r.id for r in (*made.resources(), *base.base.resources())}, max_hires, rounds)


def _free_id(stem: str, taken: set[str], start: int) -> str:
    return next(x for n in count(start) if (x := f"{stem}_{n}") not in taken)


def run(p: Plan, on_run: Callable[[], None] | None = None) -> dict:
    """{met, stopped, hires, scenario, path}; path[0] is the base, each later entry a kept hire with the hires so far."""
    def evaluate(overlays: list) -> dict:
        s = Scenario(p.base.id, p.base.name, p.base.base, overlays)
        return run_experiment(s.name, s, p.config, keep_events=False, on_run=on_run).summary

    def entry(summary: dict) -> dict:
        k = summary[p.kpi]
        return {"hires": dict(hires), "mean": k.mean, "ci_low": k.ci_low, "ci_high": k.ci_high, "labor_cost": summary["labor_cost"].mean}

    def met(summary: dict) -> bool:  # the pessimistic bound, so noise cannot claim the target
        return summary[p.kpi].ci_high <= p.value if p.op == "<=" else summary[p.kpi].ci_low >= p.value

    sign = -1 if p.op == "<=" else 1
    overlays, hires, taken = list(p.base.overlays), {}, set(p.taken_ids)
    current = evaluate(overlays)
    path = [entry(current)]
    is_met = met(current)
    stopped = "met" if is_met else "max_hires" if p.rounds == p.max_hires else "budget"
    # shortcut: greedy, never removes a hire once kept, so it can overshoot the cheapest mix; upgrade with a removal pass if that matters
    for _ in range(p.rounds if not is_met else 0):
        best = None
        for d in p.candidates:
            t = p.templates[d]
            hire = AddEmployee(d, replace(t, id=(new_id := _free_id(f"{d}_hire", taken, 1)), name=f"New hire {new_id.rsplit('_', 1)[1]}"))
            summary = evaluate([*overlays, hire])
            gain = sign * (summary[p.kpi].mean - current[p.kpi].mean)
            score = gain / max(t.cost_per_hour, COST_FLOOR)
            if gain > 0 and (best is None or score > best[0]):
                best = (score, d, hire, summary)
        if best is None:
            stopped = "no_improvement"
            break
        _, d, hire, current = best
        overlays.append(hire)
        taken.add(hire.employee.id)
        hires[d] = hires.get(d, 0) + 1
        path.append(entry(current))
        if met(current):
            is_met, stopped = True, "met"
            break
    new_id = "optimized" if "optimized" not in p.scenario_ids else _free_id("optimized", p.scenario_ids, 2)
    scenario = Scenario(new_id, f"{p.base.name} + optimized staffing", p.base.base, overlays)
    return {"met": is_met, "stopped": stopped, "hires": hires, "scenario": scenario_to_dict(scenario), "path": path}
