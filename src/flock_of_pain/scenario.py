import copy
from dataclasses import dataclass, field
from typing import Union

from flock_of_pain.model import ArrivalSpec, Company, ModelError, Resource, Workflow


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
                if w.arrival is not None:
                    w.arrival.rate_per_hour *= self.factor
                for i in w.inflows:
                    i.rate_per_hour *= self.factor


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


def expand_inflows(c: Company) -> None:
    # engine reads wf.arrival only: one engine workflow per inflow, holding the steps reachable from its entry
    out: list[Workflow] = []
    for w in c.workflows:
        if not w.inflows:
            out.append(w)
            continue
        succ: dict[str, list[str]] = {}
        for s in w.steps:
            for d in s.depends_on:
                succ.setdefault(d, []).append(s.id)
        for i in w.inflows:
            keep, queue = set(i.entry), list(i.entry)
            while queue:
                for n in succ.get(queue.pop(), []):
                    if n not in keep:
                        keep.add(n)
                        queue.append(n)
            steps = [copy.deepcopy(s) for s in w.steps if s.id in keep]
            for s in steps:
                s.depends_on = [d for d in s.depends_on if d in keep]
                if s.rework_to not in keep:
                    s.rework_to = None
            single = len(w.inflows) == 1
            out.append(Workflow(w.id if single else f"{w.id}.{i.id}",
                                w.name if single else f"{w.name} · {i.name}",
                                steps, ArrivalSpec(i.rate_per_hour, i.window)))
    c.workflows = out


@dataclass
class Scenario:
    id: str
    name: str
    base: Company
    overlays: list[Overlay] = field(default_factory=list)

    def materialize(self, draft: bool = False) -> Company:
        c = copy.deepcopy(self.base)
        c.resolve(draft)  # carved employees inherit pool schedules before overlays touch them
        for o in self.overlays:
            o.apply(c)
        expand_inflows(c)
        c.resolve(draft)  # rebuild the resource index and validate the final state
        return c
