import copy

import pytest
from conftest import tiny_company

from flock_of_pain.model import ModelError, Resource
from flock_of_pain.scenario import (
    Absence, AddEmployee, ArrivalMultiplier, RemoveResource, Scenario,
    SetPoolHeadcount, SystemOutage,
)
from flock_of_pain.schedule import business_hours


def test_base_untouched_by_all_overlays():
    base = tiny_company(rate_per_hour=10)
    before = copy.deepcopy(base)
    new = Resource("e2", "cs", {"support"}, schedule=business_hours(9, 17))
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
    with pytest.raises(ModelError):
        Scenario("s", "S", base, [ArrivalMultiplier(2, "nope")]).materialize()


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


def test_add_employee_with_pool_id_rejected():
    new = Resource("e2", "cs", {"support"}, pool_id="cs_pool")
    with pytest.raises(ModelError):
        Scenario("s", "S", tiny_company(), [AddEmployee("cs", new)]).materialize()


def test_add_employee_and_absence_isolated_from_pool():
    base = tiny_company()
    new = Resource("e2", "cs", {"support"}, schedule=business_hours(9, 17))
    c = Scenario("s", "S", base, [AddEmployee("cs", new), Absence("e1", 540, 600)]).materialize()
    assert c.resource("cs_pool").capacity == 2  # headcount added, pool not carved
    assert c.resource("e2").capacity == 1
    assert c.resource("e1").schedule.absences == [(540, 600)]
    assert c.resource("cs_pool").schedule.absences == []


from flock_of_pain.dist import const
from flock_of_pain.engine import Engine, RunConfig
from flock_of_pain.model import Inflow, Step
from flock_of_pain.scenario import expand_inflows


def _canvas_company():
    # a -> b -> c (c reworks to b), a -> d; phone enters at a, web enters at c
    c = tiny_company(steps=[
        Step("a", "A", "cs", "support", const(10)),
        Step("b", "B", "cs", "support", const(5), depends_on=["a"]),
        Step("c", "C", "cs", "support", const(5), depends_on=["b"], failure_prob=0.1, rework_to="b"),
        Step("d", "D", "cs", "support", const(5), depends_on=["a"]),
    ])
    w = c.workflow("w")
    w.arrival = None
    w.inflows = [Inflow("phone", "Phone", 3, business_hours(9, 17), ["a"]),
                 Inflow("web", "Web", 10, business_hours(0, 24), ["c"])]
    w.layout = {"phone": (0, 0), "a": (256, 0)}
    c.resolve()
    return c


def test_expand_inflows_splits_per_channel():
    c = _canvas_company()
    expand_inflows(c)
    assert [w.id for w in c.workflows] == ["w.phone", "w.web"]
    phone, web = c.workflows
    assert phone.name == "W · Phone" and phone.arrival.rate_per_hour == 3
    assert [s.id for s in phone.steps] == ["a", "b", "c", "d"]
    assert c.step("w.phone", "c").rework_to == "b"
    assert [s.id for s in web.steps] == ["c"]
    assert web.steps[0].depends_on == [] and web.steps[0].rework_to is None
    assert web.arrival.rate_per_hour == 10 and web.inflows == [] and web.layout == {}
    c.resolve()
    Engine(c, RunConfig(seed=1, horizon_minutes=1440)).run()  # the expanded form is engine-ready


def test_expand_single_inflow_keeps_workflow_id():
    c = _canvas_company()
    c.workflow("w").inflows.pop()
    expand_inflows(c)
    assert [w.id for w in c.workflows] == ["w"] and c.workflows[0].name == "W"


def test_expand_entry_step_keeps_in_subgraph_dependency():
    c = _canvas_company()
    c.workflow("w").inflows[1].entry = ["a", "b"]
    expand_inflows(c)
    assert c.step("w.web", "b").depends_on == ["a"]


def test_expand_leaves_arrival_form_alone():
    c = tiny_company(rate_per_hour=2)
    before = copy.deepcopy(c)
    expand_inflows(c)
    assert c == before


def test_arrival_multiplier_scales_inflows():
    base = _canvas_company()
    c = Scenario("s", "S", base, [ArrivalMultiplier(2, "w")]).materialize()
    assert [w.arrival.rate_per_hour for w in c.workflows] == [6, 20]
    c = Scenario("s", "S", base, [ArrivalMultiplier(2)]).materialize()
    assert [w.arrival.rate_per_hour for w in c.workflows] == [6, 20]
    assert base.workflow("w").inflows[0].rate_per_hour == 3  # base untouched


def test_materialize_draft_tolerates_incomplete_company():
    base = _canvas_company()
    base.workflow("w").inflows[1].entry = []
    base.workflow("w").steps[0].department_id = ""
    with pytest.raises(ModelError):
        Scenario("s", "S", base, []).materialize()
    Scenario("s", "S", base, []).materialize(draft=True)
