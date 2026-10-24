import copy

import pytest
from conftest import tiny_company

from workforce_twin.model import ModelError, Resource
from workforce_twin.scenario import (
    Absence, AddEmployee, ArrivalMultiplier, RemoveResource, Scenario,
    SetPoolHeadcount, SystemOutage,
)


def test_base_untouched_by_all_overlays():
    base = tiny_company(rate_per_hour=10)
    before = copy.deepcopy(base)
    new = Resource("e2", "cs", {"support"}, pool_id="cs_pool")
    Scenario("s", "S", base, [
        ArrivalMultiplier(1.3), SystemOutage("erp", 600, 720), AddEmployee("cs", new),
        Absence("e1", 100, 200), SetPoolHeadcount("cs_pool", 5), RemoveResource("e1"),
    ]).materialize()
    assert base == before
    assert base.resource("e1").schedule.absences == []


def test_arrival_multiplier():
    base = tiny_company(rate_per_hour=10)
    c = Scenario("s", "S", base, [ArrivalMultiplier(1.3)]).materialize()
    assert c.workflow("w").arrival.rate_per_hour == pytest.approx(13)
    c = Scenario("s", "S", base, [ArrivalMultiplier(2, "nope")]).materialize()
    assert c.workflow("w").arrival.rate_per_hour == pytest.approx(10)


def test_remove_resource_frees_pool_capacity():
    base = tiny_company()
    assert base.resource("cs_pool").capacity == 2
    c = Scenario("s", "S", base, [RemoveResource("e1")]).materialize()
    assert c.resource("cs_pool").capacity == 3
    with pytest.raises(ModelError):
        Scenario("s", "S", base, [RemoveResource("zzz")]).materialize()


def test_set_pool_headcount():
    base = tiny_company()
    with pytest.raises(ModelError):
        Scenario("s", "S", base, [SetPoolHeadcount("cs_pool", 0)]).materialize()
    with pytest.raises(ModelError):
        Scenario("s", "S", base, [SetPoolHeadcount("e1", 2)]).materialize()
    c = Scenario("s", "S", base, [SetPoolHeadcount("cs_pool", 5)]).materialize()
    assert c.resource("cs_pool").capacity == 4


def test_outage():
    base = tiny_company()
    c = Scenario("s", "S", base, [SystemOutage("erp", 600, 720)]).materialize()
    assert ("erp", 600, 720) in c.outages
    with pytest.raises(ModelError):
        Scenario("s", "S", base, [SystemOutage("nope", 0, 1)]).materialize()


def test_add_employee_and_absence_isolated_from_pool():
    base = tiny_company()
    new = Resource("e2", "cs", {"support"}, pool_id="cs_pool")
    c = Scenario("s", "S", base, [AddEmployee("cs", new), Absence("e1", 540, 600)]).materialize()
    assert c.resource("cs_pool").capacity == 1
    assert c.resource("e1").schedule.absences == [(540, 600)]
    assert c.resource("cs_pool").schedule.absences == []
    assert c.resource("e2").schedule is not None
    assert new.schedule is None
