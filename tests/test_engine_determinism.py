import hashlib

import pytest

from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.examples import reynolds

HASHES = {
    "baseline": "55196c5154ef758bd8056a369f132f83e8dc006155822401d81d7ca77d71e17a",
    "demand_plus_30": "57302e42cd2377c71703d7ca52f18e57bf51781e8230893216b34b0e4dc0be2a",
    "erp_outage_2h": "40f1341b2652608457f8e6fcaa38a506c97ac0f990b25c4c5de39d8066de98a3",
    "extra_cs_employee": "24fb2c6d33e370385839d1c97edc8994df8f03d91931d49109e077fd571ced49",
}


@pytest.mark.parametrize("scenario", reynolds.scenarios(reynolds.build()), ids=lambda s: s.id)
def test_event_log_hash_pinned(scenario):
    e = Engine(scenario.materialize(), RunConfig(seed=42, horizon_minutes=14400)); e.run()
    h = hashlib.sha256("\n".join(ev.to_json() for ev in e.events).encode()).hexdigest()
    assert h == HASHES[scenario.id]
