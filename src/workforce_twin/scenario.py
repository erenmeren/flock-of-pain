import copy
from dataclasses import dataclass, field
from typing import Union

from workforce_twin.model import Company, ModelError, Resource


def _find(c: Company, id: str) -> Resource:
    # scan, not c.resource(): the index is stale after Add/RemoveResource
    r = next((r for r in c.resources() if r.id == id), None)
    if r is None:
        raise ModelError(f"unknown resource {id}")
    return r


@dataclass
class ArrivalMultiplier:
    factor: float
    workflow_id: str | None = None

    def apply(self, c: Company) -> None:
        if self.workflow_id is not None:
            c.workflow(self.workflow_id)  # raises ModelError if unknown
        for w in c.workflows:
            if self.workflow_id is None or w.id == self.workflow_id:
                w.arrival.rate_per_hour *= self.factor


@dataclass
class SystemOutage:
    system_id: str
    start: float
    end: float

    def apply(self, c: Company) -> None:
        if all(s.id != self.system_id for s in c.systems):
            raise ModelError(f"unknown system {self.system_id}")
        c.outages.append((self.system_id, self.start, self.end))


@dataclass
class AddEmployee:
    department_id: str
    employee: Resource

    def apply(self, c: Company) -> None:
        if self.employee.pool_id is not None:
            raise ModelError(f"AddEmployee {self.employee.id}: pool_id must be None (adds headcount, never carves)")
        c.department(self.department_id).resources.append(copy.deepcopy(self.employee))


@dataclass
class RemoveResource:
    resource_id: str

    def apply(self, c: Company) -> None:
        for d in c.departments:
            for r in d.resources:
                if r.id == self.resource_id:
                    d.resources.remove(r)
                    return
        raise ModelError(f"unknown resource {self.resource_id}")


@dataclass
class SetPoolHeadcount:
    pool_id: str
    headcount: int

    def apply(self, c: Company) -> None:
        pool = _find(c, self.pool_id)
        if not pool.is_pool:
            raise ModelError(f"{self.pool_id} is not a pool")
        pool.headcount = self.headcount


@dataclass
class Absence:
    resource_id: str
    start: float
    end: float

    def apply(self, c: Company) -> None:
        r = _find(c, self.resource_id)
        # resolve() shares the pool's schedule with carved employees; detach first.
        r.schedule = copy.deepcopy(r.schedule)
        r.schedule.absences.append((self.start, self.end))


Overlay = Union[ArrivalMultiplier, SystemOutage, AddEmployee, RemoveResource, SetPoolHeadcount, Absence]


@dataclass
class Scenario:
    id: str
    name: str
    base: Company
    overlays: list[Overlay] = field(default_factory=list)

    def materialize(self) -> Company:
        c = copy.deepcopy(self.base)
        c.resolve()  # carved employees inherit pool schedules before overlays touch them
        for o in self.overlays:
            o.apply(c)
        c.resolve()  # rebuild the resource index and validate the final state
        return c
