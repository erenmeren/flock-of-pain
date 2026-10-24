from flock_of_pain.dist import const
from flock_of_pain.events import Task
from flock_of_pain.model import Resource, Step
from flock_of_pain.scheduling import POLICIES, Fifo, LeastLoaded, Priority


def task(id: str, queued_at: float) -> Task:
    return Task(id, "i", "w", "s", "d", queued_at=queued_at)


def step(priority: int = 0) -> Step:
    return Step("s", "S", "d", "skill", const(1.0), priority=priority)


def res(id: str, capacity: int = 1) -> Resource:
    return Resource(id, "d", {"skill"}, capacity=capacity)


def test_priority_before_earlier_arrival():
    early, late = task("a", 1.0), task("b", 5.0)
    p = Priority()
    assert p.order_key(late, step(5)) < p.order_key(early, step(0))
    assert p.order_key(early, step()) < p.order_key(late, step())


def test_fifo_ignores_priority():
    early, late = task("a", 1.0), task("b", 5.0)
    f = Fifo()
    assert f.order_key(early, step(0)) < f.order_key(late, step(5))


def test_first_eligible_for_fifo_and_priority():
    rs = [res("r1"), res("r2")]
    assert Fifo().choose_resource(task("a", 0), rs, {"r1": 99.0}) is rs[0]
    assert Priority().choose_resource(task("a", 0), rs, {"r1": 99.0}) is rs[0]


def test_least_loaded_uses_busy_over_capacity():
    rs = [res("r1"), res("r2", capacity=4)]
    ll = LeastLoaded()
    assert ll.choose_resource(task("a", 0), rs, {"r1": 10.0, "r2": 20.0}) is rs[1]
    assert ll.choose_resource(task("a", 0), rs, {"r1": 10.0, "r2": 60.0}) is rs[0]


def test_least_loaded_tie_first_in_list():
    rs = [res("r1"), res("r2")]
    assert LeastLoaded().choose_resource(task("a", 0), rs, {}) is rs[0]


def test_registry():
    assert POLICIES == {"fifo": Fifo, "priority": Priority, "least_loaded": LeastLoaded}
