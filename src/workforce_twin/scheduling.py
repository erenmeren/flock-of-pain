from typing import Protocol

from workforce_twin.events import Task
from workforce_twin.model import Resource, Step


class SchedulingPolicy(Protocol):
    def order_key(self, task: Task, step: Step) -> tuple: ...

    def choose_resource(
        self, task: Task, eligible: list[Resource], busy_minutes: dict[str, float]
    ) -> Resource: ...


class Fifo:
    def order_key(self, task: Task, step: Step) -> tuple:
        return (task.queued_at, task.id)

    def choose_resource(self, task, eligible, busy_minutes) -> Resource:
        return eligible[0]


class Priority:
    def order_key(self, task: Task, step: Step) -> tuple:
        return (-step.priority, task.queued_at, task.id)

    def choose_resource(self, task, eligible, busy_minutes) -> Resource:
        return eligible[0]


class LeastLoaded(Priority):
    def choose_resource(self, task, eligible, busy_minutes) -> Resource:
        return min(eligible, key=lambda r: busy_minutes.get(r.id, 0.0) / r.capacity)


POLICIES: dict[str, type[SchedulingPolicy]] = {
    "fifo": Fifo,
    "priority": Priority,
    "least_loaded": LeastLoaded,
}
