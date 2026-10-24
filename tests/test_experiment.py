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
