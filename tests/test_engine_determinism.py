import hashlib

import pytest

from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.examples import reynolds

HASHES = {
    "baseline": "4f60379ed5d3de5bddc73e9e80d97f3076f6cfe57b19f3901fcbd7239345a15e",
    "demand_plus_30": "3f8def688118b1edc4456b2cee7d7d6a978c213c95c6cd9ed92c9a033ae292ac",
    "erp_outage_2h": "376496f88aee7f631654addb5c623d8372d98e206421075b102c51e41db7a8d2",
    "extra_cs_employee": "8dec7b8f3f6904a71f3ee59c9299a1af44c6cc8754dbcaa4202295f7ae6303b4",
}


@pytest.mark.parametrize("scenario", reynolds.scenarios(reynolds.build()), ids=lambda s: s.id)
def test_event_log_hash_pinned(scenario):
    e = Engine(scenario.materialize(), RunConfig(seed=42, horizon_minutes=14400)); e.run()
    h = hashlib.sha256("\n".join(ev.to_json() for ev in e.events).encode()).hexdigest()
    assert h == HASHES[scenario.id]



def _log(scenario, crn):
    e = Engine(scenario.materialize(), RunConfig(seed=42, horizon_minutes=3 * 1440, crn=crn)); e.run()
    return e.events


def test_crn_runs_repeat_and_keep_arrivals_across_scenarios():
    from conftest import tiny_company
    from flock_of_pain.dist import lognormal_mean
    from flock_of_pain.model import Resource, Step
    from flock_of_pain.scenario import AddEmployee, Scenario
    from flock_of_pain.schedule import business_hours
    c = tiny_company(rate_per_hour=6, pool_headcount=1, employees=0,
                     steps=[Step("a", "A", "cs", "support", lognormal_mean(15), failure_prob=0.1, max_retries=1)])
    base = Scenario("b", "b", c)
    extra = Scenario("x", "x", c, [AddEmployee("cs", Resource("new", "cs", {"support"}, schedule=business_hours(9, 17)))])
    assert _log(base, True) == _log(base, True)
    starts = lambda evs: [(e.t, e.workflow_id) for e in evs if e.kind in ("WORKFLOW_STARTED", "TASK_CREATED")]
    assert starts(_log(base, True)) == starts(_log(extra, True))
    assert starts(_log(base, False)) != starts(_log(extra, False))
