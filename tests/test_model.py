import pytest
import copy

from flock_of_pain.dist import const
from flock_of_pain.model import (
    ArrivalSpec,
    BusinessSystem,
    Company,
    Department,
    ModelError,
    Resource,
    Step,
    Workflow,
)
from flock_of_pain.schedule import business_hours


def make_company(resources=None, steps=None, systems=None) -> Company:
    sched = business_hours(9, 17)
    resources = resources if resources is not None else [
        Resource("r1", "d1", {"x"}, schedule=sched)
    ]
    steps = steps if steps is not None else [Step("s1", "S1", "d1", "x", const(5))]
    return Company(
        "c",
        "C",
        [Department("d1", "D1", resources)],
        systems if systems is not None else [BusinessSystem("sys1", "Sys")],
        [Workflow("w", "W", steps, ArrivalSpec(1.0, sched))],
    )


def pool_company(headcount, carved):
    sched = business_hours(9, 17)
    pool = Resource("pool", "d1", {"x"}, headcount=headcount, schedule=sched)
    emps = [Resource(f"e{i}", "d1", {"x"}, pool_id="pool") for i in range(carved)]
    return make_company([pool, *emps])


def test_pool_carve_out_and_idempotent():
    c = pool_company(12, 3)
    c.resolve()
    c.resolve()
    assert c.resource("pool").capacity == 9


def test_pool_overcarved():
    with pytest.raises(ModelError, match="pool"):
        pool_company(2, 3).resolve()


def test_employee_inherits_pool_schedule():
    c = pool_company(5, 1)
    c.resolve()
    assert c.resource("e0").schedule is c.resource("pool").schedule


def test_unknown_pool_id():
    c = make_company([Resource("e", "d1", {"x"}, pool_id="nope", schedule=business_hours(9, 17))])
    with pytest.raises(ModelError, match="nope"):
        c.resolve()


def test_missing_schedule():
    with pytest.raises(ModelError, match="r1"):
        make_company([Resource("r1", "d1", {"x"})]).resolve()


def test_duplicate_resource_id():
    s = business_hours(9, 17)
    c = make_company([Resource("r", "d1", {"x"}, schedule=s), Resource("r", "d1", {"x"}, schedule=s)])
    with pytest.raises(ModelError, match="duplicate"):
        c.resolve()


def test_cyclic_depends_on():
    steps = [
        Step("a", "A", "d1", "x", const(1), depends_on=["b"]),
        Step("b", "B", "d1", "x", const(1), depends_on=["a"]),
    ]
    with pytest.raises(ModelError, match="cycl"):
        make_company(steps=steps).resolve()


def test_self_dependency_is_cycle():
    steps = [Step("a", "A", "d1", "x", const(1), depends_on=["a"])]
    with pytest.raises(ModelError, match="cycl"):
        make_company(steps=steps).resolve()


def test_unknown_dependency():
    steps = [Step("a", "A", "d1", "x", const(1), depends_on=["zz"])]
    with pytest.raises(ModelError, match="zz"):
        make_company(steps=steps).resolve()


def test_rework_to_non_dependency():
    steps = [
        Step("a", "A", "d1", "x", const(1)),
        Step("b", "B", "d1", "x", const(1), rework_to="a"),
    ]
    with pytest.raises(ModelError, match="rework"):
        make_company(steps=steps).resolve()


def test_rework_to_self_and_dependency_ok():
    steps = [
        Step("a", "A", "d1", "x", const(1), rework_to="a"),
        Step("b", "B", "d1", "x", const(1), depends_on=["a"], rework_to="a"),
    ]
    make_company(steps=steps).resolve()


def test_unknown_system_id():
    steps = [Step("a", "A", "d1", "x", const(1), system_id="nosys")]
    with pytest.raises(ModelError, match="nosys"):
        make_company(steps=steps).resolve()


def test_unknown_department_id():
    steps = [Step("a", "A", "dz", "x", const(1))]
    with pytest.raises(ModelError, match="dz"):
        make_company(steps=steps).resolve()


def test_failure_prob_range():
    steps = [Step("a", "A", "d1", "x", const(1), failure_prob=1.5)]
    with pytest.raises(ModelError, match="failure_prob"):
        make_company(steps=steps).resolve()


def test_employee_capacity_must_be_one():
    c = make_company([Resource("r", "d1", {"x"}, capacity=2, schedule=business_hours(9, 17))])
    with pytest.raises(ModelError, match="capacity"):
        c.resolve()


def test_defaults_and_lookups():
    c = make_company()
    c.resolve()
    assert c.step("w", "s1").priority == 0
    assert [r.id for r in c.resources()] == ["r1"]
    assert c.department("d1").name == "D1"
    assert c.workflow("w").id == "w"


@pytest.mark.parametrize("p", [0.0, 1.0])
def test_failure_prob_boundaries_ok(p):
    make_company(steps=[Step("a", "A", "d1", "x", const(1), failure_prob=p)]).resolve()


def test_failure_prob_negative():
    steps = [Step("a", "A", "d1", "x", const(1), failure_prob=-0.1)]
    with pytest.raises(ModelError, match="failure_prob"):
        make_company(steps=steps).resolve()


def test_three_node_cycle():
    steps = [
        Step("a", "A", "d1", "x", const(1), depends_on=["c"]),
        Step("b", "B", "d1", "x", const(1), depends_on=["a"]),
        Step("c", "C", "d1", "x", const(1), depends_on=["b"]),
    ]
    with pytest.raises(ModelError, match="cycl"):
        make_company(steps=steps).resolve()


def test_pool_id_points_at_non_pool():
    s = business_hours(9, 17)
    c = make_company([Resource("a", "d1", {"x"}, schedule=s), Resource("b", "d1", {"x"}, pool_id="a", schedule=s)])
    with pytest.raises(ModelError, match="pool_id"):
        c.resolve()


def test_missing_lookups_raise_model_error():
    c = make_company()
    for call in (
        lambda: c.resource("zz"),
        lambda: c.department("zz"),
        lambda: c.workflow("zz"),
        lambda: c.step("w", "zz"),
    ):
        with pytest.raises(ModelError, match="zz"):
            call()
    c.resolve()
    with pytest.raises(ModelError, match="zz"):
        c.resource("zz")


@pytest.mark.parametrize("collection", ["departments", "systems", "workflows", "steps"])
def test_duplicate_ids(collection):
    c = make_company(steps=[Step("s1", "S1", "d1", "x", const(5)), Step("s2", "S2", "d1", "x", const(5))])
    owner = c.workflows[0] if collection == "steps" else c
    items = getattr(owner, collection)
    items.append(copy.copy(items[0]))
    if collection == "departments":
        items[-1] = Department(items[0].id, "D2", [])
    with pytest.raises(ModelError, match="duplicate"):
        c.resolve()
