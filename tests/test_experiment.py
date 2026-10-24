import copy

from conftest import tiny_company
from workforce_twin.engine import Engine, RunConfig
from workforce_twin.experiment import KPI_KEYS, Stat, compare, run_experiment, top_ledger
from workforce_twin.scenario import Scenario

CFG = RunConfig(seed=42, horizon_minutes=3 * 1440, replications=3)
SENTENCE = "All parameters are assumed values; results are simulation estimates, not measurements."


def _scenario():
    return Scenario("s", "S", tiny_company(rate_per_hour=4))


def test_replications_seeds_and_determinism():
    res = run_experiment("base", _scenario(), CFG)
    assert [r.seed for r in res.runs] == [42, 43, 44]
    eng = Engine(tiny_company(rate_per_hour=4), RunConfig(seed=42, horizon_minutes=3 * 1440))
    eng.run()
    assert res.runs[0].events == eng.events
    assert set(KPI_KEYS) <= set(res.summary)
    assert "util_cs" in res.summary


def test_stat_mean():
    from workforce_twin.experiment import _stat
    assert _stat([1, 2, 3]) == Stat(2, 1, 2, 3)


def test_compare_and_ledger_and_base_unchanged():
    sc = _scenario()
    before = copy.deepcopy(sc.base)
    res = run_experiment("base", sc, CFG)
    assert sc.base == before
    lines = compare([res]).splitlines()
    assert lines[0] == SENTENCE
    assert lines[1].startswith("KPI") and "base" in lines[1]
    assert any(l.startswith("cycle_p50") for l in lines)
    assert len(top_ledger(res, 2)) <= 2


def _res(name, summary, ledgers=()):
    from workforce_twin.analytics import Metrics
    from workforce_twin.experiment import ExperimentResult, RunResult
    return ExperimentResult(name, [RunResult(0, [], Metrics(1, ledger=l)) for l in ledgers], summary)


def test_compare_two_experiments_missing_util():
    full = {k: Stat(1, 0, 1, 2) for k in KPI_KEYS} | {"util_cs": Stat(.5, .4, .5, .6)}
    a = _res("a", full)
    b = _res("b", {k: Stat(2, 1, 2, 3) for k in KPI_KEYS})
    lines = compare([a, b]).splitlines()
    assert all(len(l.split(" | ")) == 3 for l in lines[1:])
    assert lines[-1].split(" | ")[2].strip() == "-"
    assert "0.50 (0.40–0.60)" in lines[-1]


def test_top_ledger_averages_and_orders():
    from workforce_twin.analytics import LedgerRow
    r1 = [LedgerRow("cs", None, None, 10, 1), LedgerRow("it", None, None, 4, 2)]
    r2 = [LedgerRow("cs", None, None, 20, 3)]
    top = top_ledger(_res("x", {}, [r1, r2]), 5)
    assert [(r.department_id, r.minutes, r.count) for r in top] == [("cs", 15, 2), ("it", 2, 1)]
    assert len(top_ledger(_res("x", {}, [r1, r2]), 1)) == 1


def test_kpis_hand_built():
    from workforce_twin.analytics import DeptMetrics, Metrics, WorkflowMetrics
    from workforce_twin.experiment import kpis
    m = Metrics(1440, {
        "a": WorkflowMetrics(started=4, completed=2, throughput_per_day=2, sla_breached=1, failures=1,
                             steps_completed=4, wait_p90=10),
        "b": WorkflowMetrics(started=4, completed=2, throughput_per_day=3, sla_breached=0, failures=1,
                             steps_completed=4, wait_p90=30),
    }, {"cs": DeptMetrics(utilization=0.5), "it": DeptMetrics(utilization=0.25)}, labor_cost=7.0)
    k = kpis(m)
    assert (k["throughput_per_day"], k["sla_breach_rate"], k["rework_rate"], k["labor_cost"]) == (5, 0.25, 0.25, 7.0)
    assert k["util_cs"] == 0.5 and k["mean_dept_utilization"] == 0.375
    assert (k["completion_rate"], k["wait_p90"]) == (0.5, 20)
