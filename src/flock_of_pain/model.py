from dataclasses import dataclass, field

from flock_of_pain.dist import Dist
from flock_of_pain.schedule import Schedule


class ModelError(ValueError):
    pass


@dataclass
class Resource:
    id: str
    department_id: str
    skills: set[str]
    capacity: int = 1
    cost_per_hour: float = 0.0
    speed_factor: float = 1.0
    name: str = ""
    schedule: Schedule | None = None
    pool_id: str | None = None
    headcount: int | None = None

    @property
    def is_pool(self) -> bool:
        return self.headcount is not None


@dataclass
class Department:
    id: str
    name: str
    resources: list[Resource] = field(default_factory=list)


@dataclass
class BusinessSystem:
    id: str
    name: str


@dataclass
class ArrivalSpec:
    rate_per_hour: float
    window: Schedule


@dataclass
class Step:
    id: str
    name: str
    department_id: str
    required_skill: str
    duration: Dist
    depends_on: list[str] = field(default_factory=list)
    system_id: str | None = None
    priority: int = 0
    sla_minutes: float | None = None
    failure_prob: float = 0.0
    rework_to: str | None = None
    max_retries: int = 0


@dataclass
class Workflow:
    id: str
    name: str
    steps: list[Step]
    arrival: ArrivalSpec


@dataclass
class Company:
    id: str
    name: str
    departments: list[Department]
    systems: list[BusinessSystem]
    workflows: list[Workflow]
    outages: list[tuple[str, float, float]] = field(default_factory=list)
    _index: dict[str, Resource] = field(default_factory=dict, init=False, repr=False, compare=False)

    def resources(self) -> list[Resource]:
        return [r for d in self.departments for r in d.resources]

    def resource(self, id: str) -> Resource:
        r = self._index.get(id) or next((r for r in self.resources() if r.id == id), None)
        if r is None:
            raise ModelError(f"unknown resource {id}")
        return r

    def department(self, id: str) -> Department:
        d = next((d for d in self.departments if d.id == id), None)
        if d is None:
            raise ModelError(f"unknown department {id}")
        return d

    def workflow(self, id: str) -> Workflow:
        w = next((w for w in self.workflows if w.id == id), None)
        if w is None:
            raise ModelError(f"unknown workflow {id}")
        return w

    def step(self, workflow_id: str, step_id: str) -> Step:
        s = next((s for s in self.workflow(workflow_id).steps if s.id == step_id), None)
        if s is None:
            raise ModelError(f"unknown step {step_id} in workflow {workflow_id}")
        return s

    def resolve(self) -> None:
        resources = self.resources()
        by_id: dict[str, Resource] = {}
        for r in resources:
            if r.id in by_id:
                raise ModelError(f"duplicate resource id: {r.id}")
            by_id[r.id] = r
        self._index = by_id

        carved: dict[str, int] = {}
        for r in resources:
            if r.pool_id is None:
                continue
            pool = by_id.get(r.pool_id)
            if pool is None or not pool.is_pool:
                raise ModelError(f"resource {r.id}: unknown pool_id {r.pool_id}")
            carved[pool.id] = carved.get(pool.id, 0) + 1
            if r.schedule is None:
                r.schedule = pool.schedule

        for r in resources:
            if r.is_pool:
                r.capacity = r.headcount - carved.get(r.id, 0)
                if r.capacity < 0:
                    raise ModelError(f"pool {r.id}: negative capacity {r.capacity}")
            elif r.capacity != 1:
                raise ModelError(f"resource {r.id}: capacity must be 1, got {r.capacity}")
            if r.schedule is None:
                raise ModelError(f"resource {r.id}: no schedule")

        dept_ids = {d.id for d in self.departments}
        system_ids = {s.id for s in self.systems}
        for w in self.workflows:
            ids = {s.id for s in w.steps}
            for s in w.steps:
                if s.department_id not in dept_ids:
                    raise ModelError(f"step {s.id}: unknown department_id {s.department_id}")
                if s.system_id is not None and s.system_id not in system_ids:
                    raise ModelError(f"step {s.id}: unknown system_id {s.system_id}")
                if not 0 <= s.failure_prob <= 1:
                    raise ModelError(f"step {s.id}: failure_prob {s.failure_prob} outside [0, 1]")
                for d in s.depends_on:
                    if d not in ids:
                        raise ModelError(f"step {s.id}: unknown dependency {d}")
                if s.rework_to is not None and s.rework_to != s.id and s.rework_to not in s.depends_on:
                    raise ModelError(f"step {s.id}: rework_to {s.rework_to} is not self or a dependency")
            self._check_acyclic(w)

    @staticmethod
    def _check_acyclic(w: Workflow) -> None:
        deps = {s.id: s.depends_on for s in w.steps}
        done: set[str] = set()
        for root in deps:
            stack = [(root, iter(deps[root]))]
            active = {root}
            while stack:
                node, it = stack[-1]
                for nxt in it:
                    if nxt in active:
                        raise ModelError(f"workflow {w.id}: dependency cycle at step {nxt}")
                    if nxt not in done:
                        active.add(nxt)
                        stack.append((nxt, iter(deps[nxt])))
                        break
                else:
                    stack.pop()
                    active.discard(node)
                    done.add(node)
