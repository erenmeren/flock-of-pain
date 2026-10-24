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
