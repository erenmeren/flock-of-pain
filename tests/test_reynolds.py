import time

import pytest

from workforce_twin.cli import main
from workforce_twin.engine import Engine, RunConfig
from workforce_twin.examples import reynolds
from workforce_twin.experiment import ASSUMPTION


def test_build_has_24_employees_and_3_pools():
    c = reynolds.build()
    employees = [r for r in c.resources() if not r.is_pool]
    pools = {r.id: r for r in c.resources() if r.is_pool}
    assert sorted(r.id for r in employees) == [f"emp_{i:02d}" for i in range(1, 25)]
    assert set(pools) == {"cs_pool", "finance_pool", "sc_pool"}
    assert pools["cs_pool"].capacity == 9


def test_every_step_skill_is_held_in_its_department():
    c = reynolds.build()
    for w in c.workflows:
        for s in w.steps:
            holders = [r for r in c.department(s.department_id).resources if s.required_skill in r.skills]
            assert holders, f"{w.id}/{s.id}: nobody in {s.department_id} has {s.required_skill}"


def test_scenarios_in_order():
    scenarios = reynolds.scenarios(reynolds.build())
    assert [s.name for s in scenarios] == ["baseline", "demand_plus_30", "erp_outage_2h", "extra_cs_employee"]
    assert scenarios[0].overlays == []
    for s in scenarios:
        s.materialize()  # overlays apply and the result validates


def test_demo_cli_prints_table(capsys, tmp_path):
    assert main(["demo", "--days", "2", "--reps", "1", "--events-dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert out.splitlines()[0] == ASSUMPTION
    assert "cycle_p50" in out
    assert (tmp_path / "baseline-42.jsonl").read_text().count("\n") > 0


@pytest.mark.slow
def test_performance_smoke_30_days():
    t0 = time.perf_counter()
    Engine(reynolds.build(), RunConfig(seed=1, horizon_minutes=30 * 1440)).run()
    assert time.perf_counter() - t0 < 30
