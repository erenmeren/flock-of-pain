"""Greedy staffing search: adds the employee with the best KPI gain per added cost per hour until a target is met (pure)."""
from collections.abc import Callable
from dataclasses import dataclass, replace
from itertools import combinations_with_replacement, count

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
    budget: int  # runs the run-day and run limits pay for

    @property
    def total(self) -> int:
        """An upper bound: at most max_hires rounds of singles, and each pair round adds two hires."""
        n = len(self.candidates)
        return min(self.budget, self.config.replications * (1 + self.max_hires * n + self.max_hires // 2 * n * (n + 1) // 2))


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
    if reps * (1 + len(candidates)) > budget:
        need = reps * (1 + len(candidates))
        raise SchemaError("config", f"days x replications x (1 + candidates) = {need * config.horizon_minutes / 1440:g} run-days "
                                    f"in {need} runs for one round exceeds the limit of {max_run_days} run-days or {max_runs} runs")
    pools = {r.id: r for r in made.resources() if r.is_pool}
    return Plan(base, {s.id for s in scenarios}, replace(config, crn=True), kpi, op, value, candidates,
                {d: _template(departments[d].resources[0], pools) for d in candidates},
                {r.id for r in (*made.resources(), *base.base.resources())}, max_hires, budget)


def _free_id(stem: str, taken: set[str], start: int) -> str:
    return next(x for n in count(start) if (x := f"{stem}_{n}") not in taken)


def run(p: Plan, on_run: Callable[[], None] | None = None) -> dict:
    """{met, stopped, hires, scenario, path}; path[0] is the base, each later entry a kept hire (or pair) with the hires so far.

    A round tries +1 in every candidate; when none improves the KPI mean it tries every pair, the same department twice
    included, since two departments in series may both have to grow before the KPI moves."""
    def evaluate(overlays: list) -> dict:
        s = Scenario(p.base.id, p.base.name, p.base.base, overlays)
        return run_experiment(s.name, s, p.config, keep_events=False, on_run=on_run).summary

    def entry(summary: dict) -> dict:
        k = summary[p.kpi]
        return {"hires": dict(hires), "mean": k.mean, "ci_low": k.ci_low, "ci_high": k.ci_high, "labor_cost": summary["labor_cost"].mean}

    def met(summary: dict) -> bool:  # the pessimistic bound, so noise cannot claim the target
        return summary[p.kpi].ci_high <= p.value if p.op == "<=" else summary[p.kpi].ci_low >= p.value

    def best_of(groups) -> tuple | None:
        """(score, hires) of the group of departments with the best KPI gain per added cost per hour, if any gains."""
        best = None
        for ds in groups:
            ids, added = set(taken), []
            for d in ds:
                new_id = _free_id(f"{d}_hire", ids, 1)
                ids.add(new_id)
                added.append(AddEmployee(d, replace(p.templates[d], id=new_id, name=f"New hire {new_id.rsplit('_', 1)[1]}")))
            summary = evaluate([*overlays, *added])
            gain = sign * (summary[p.kpi].mean - current[p.kpi].mean)
            score = gain / max(sum(p.templates[d].cost_per_hour for d in ds), COST_FLOOR)
            if gain > 0 and (best is None or score > best[0]):
                best = (score, added, summary)
        return best

    sign = -1 if p.op == "<=" else 1
    overlays, hires, taken = list(p.base.overlays), {}, set(p.taken_ids)
    reps, singles = p.config.replications, [(d,) for d in p.candidates]
    pairs = list(combinations_with_replacement(p.candidates, 2))
    current = evaluate(overlays)
    path, used = [entry(current)], reps
    is_met = met(current)
    stopped = "met"
    # shortcut: greedy, never removes a hire once kept, so it can overshoot the cheapest mix, and it misses three or more
    # departments that only help together; upgrade with a removal pass or a wider step if that matters
    while not is_met:
        if sum(hires.values()) >= p.max_hires:
            stopped = "max_hires"
            break
        if used + reps * len(singles) > p.budget:
            stopped = "budget"
            break
        used += reps * len(singles)
        best = best_of(singles)
        if best is None:  # the pair step: needs room for two hires and the budget for every pair
            if sum(hires.values()) + 2 > p.max_hires:
                stopped = "max_hires"
                break
            if used + reps * len(pairs) > p.budget:
                stopped = "budget"
                break
            used += reps * len(pairs)
            best = best_of(pairs)
            if best is None:
                stopped = "no_improvement"
                break
        _, added, current = best
        for hire in added:
            overlays.append(hire)
            taken.add(hire.employee.id)
            hires[hire.department_id] = hires.get(hire.department_id, 0) + 1
        path.append(entry(current))
        if met(current):
            is_met, stopped = True, "met"
    new_id = "optimized" if "optimized" not in p.scenario_ids else _free_id("optimized", p.scenario_ids, 2)
    scenario = Scenario(new_id, f"{p.base.name} + optimized staffing", p.base.base, overlays)
    return {"met": is_met, "stopped": stopped, "hires": hires, "scenario": scenario_to_dict(scenario), "path": path}
