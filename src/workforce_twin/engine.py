import heapq
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial

from workforce_twin.events import Event, EventKind, Reason, Task, TaskState, transition
from workforce_twin.model import Company, Resource, Step, Workflow
from workforce_twin.scheduling import POLICIES

K = EventKind
S = TaskState


@dataclass
class RunConfig:
    seed: int
    horizon_minutes: float
    replications: int = 1
    policy: str = "priority"


@dataclass
class Instance:
    id: str
    workflow: Workflow
    completed: set[str] = field(default_factory=set)
    active: dict[str, str] = field(default_factory=dict)  # step id -> task id
    retries: int = 0


class Engine:
    def __init__(self, company: Company, config: RunConfig):
        self.company = company
        self.config = config
        self.horizon = config.horizon_minutes
        self.policy = POLICIES[config.policy]()
        self.rng = random.Random(config.seed)
        self.now = 0.0
        self.events: list[Event] = []
        self._heap: list[tuple[float, int, Callable[[], None]]] = []
        self._seq = 0
        self._paused = False
        self.steps = {(w.id, s.id): s for w in company.workflows for s in w.steps}
        self.instances: dict[str, Instance] = {}
        self._arrivals = {w.id: 0 for w in company.workflows}
        self.queues: dict[tuple[str, str], list[Task]] = {}
        resources = company.resources()
        self.free_slots = {r.id: r.capacity for r in resources}
        self.busy_minutes = {r.id: 0.0 for r in resources}
        self.on_shift = {r.id: False for r in resources}

        for r in resources:
            t = 0.0
            while (on := r.schedule.next_on(t)) is not None and on < self.horizon:
                self.schedule(on, partial(self._shift, r, True))
                t = r.schedule.next_off(on)
                if t < self.horizon:
                    self.schedule(t, partial(self._shift, r, False))
        for w in company.workflows:
            self._next_arrival(w, 0.0)

    # --- event loop ---

    def schedule(self, t: float, fn: Callable[[], None]) -> None:
        self._seq += 1
        heapq.heappush(self._heap, (t, self._seq, fn))

    def step(self) -> bool:
        if not self._heap or self._heap[0][0] > self.horizon:
            return False
        self.now, _, fn = heapq.heappop(self._heap)
        fn()
        return True

    def run_until(self, t: float) -> None:
        while self._heap and self._heap[0][0] <= t:
            self.now, _, fn = heapq.heappop(self._heap)
            fn()
            if self._paused:
                return
        self.now = max(self.now, t)

    def run(self) -> None:
        self.run_until(self.horizon)

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    # --- callbacks ---

    def _shift(self, r: Resource, on: bool) -> None:
        self.on_shift[r.id] = on
        kind = K.RESOURCE_AVAILABLE if on else K.RESOURCE_UNAVAILABLE
        self.events.append(Event(self.now, kind, department_id=r.department_id, resource_id=r.id))
        if on:
            self._dispatch_resource(r)

    def _next_arrival(self, wf: Workflow, t: float) -> None:
        rate = wf.arrival.rate_per_hour / 60
        if rate <= 0:
            return
        t2 = t + self.rng.expovariate(rate)
        while t2 < self.horizon and not wf.arrival.window.is_on(t2):
            if (t2 := wf.arrival.window.next_on(t2)) is None:
                return
            t2 += self.rng.expovariate(rate)
        if t2 < self.horizon:
            self.schedule(t2, partial(self._arrive, wf))

    def _arrive(self, wf: Workflow) -> None:
        self._arrivals[wf.id] += 1
        inst = Instance(f"{wf.id}-{self._arrivals[wf.id]:06d}", wf)
        self.instances[inst.id] = inst
        self.events.append(Event(self.now, K.WORKFLOW_STARTED, instance_id=inst.id, workflow_id=wf.id))
        for s in wf.steps:
            if not s.depends_on:
                self._create_task(inst, s)
        self._next_arrival(wf, self.now)

    def _finish(self, task: Task, token: int) -> None:
        if task.run_token != token or task.state != S.IN_PROGRESS:
            return
        r = self.company.resource(task.resource_id)
        self.busy_minutes[r.id] += self.now - task.started_at
        self.free_slots[r.id] += 1
        step = self._step(task)
        transition(task, S.COMPLETED, self.now, self.events)
        if step.sla_minutes is not None and self.now - task.queued_at > step.sla_minutes:
            self.events.append(Event(
                self.now, K.SLA_BREACHED, task.id, task.instance_id, task.workflow_id, step.id,
                task.department_id, r.id,
            ))
        inst = self.instances[task.instance_id]
        inst.completed.add(step.id)
        inst.active.pop(step.id, None)
        for s in inst.workflow.steps:
            if s.id not in inst.completed and s.id not in inst.active and set(s.depends_on) <= inst.completed:
                self._create_task(inst, s)
        if len(inst.completed) == len(inst.workflow.steps):
            self.events.append(Event(
                self.now, K.WORKFLOW_COMPLETED, instance_id=inst.id, workflow_id=inst.workflow.id,
            ))
            del self.instances[inst.id]
        self._dispatch_resource(r)

    # --- dispatch ---

    def _step(self, task: Task) -> Step:
        return self.steps[task.workflow_id, task.step_id]

    def _create_task(self, inst: Instance, step: Step) -> Task:
        task = Task(
            f"{inst.id}:{step.id}:{inst.retries}", inst.id, inst.workflow.id, step.id,
            step.department_id, created_at=self.now,
        )
        inst.active[step.id] = task.id
        self.events.append(Event(
            self.now, K.TASK_CREATED, task.id, inst.id, inst.workflow.id, step.id, step.department_id,
        ))
        self._try_dispatch_task(task)
        return task

    def _skilled(self, task: Task) -> list[Resource]:
        skill = self._step(task).required_skill
        return [r for r in self.company.department(task.department_id).resources if skill in r.skills]

    def _eligible(self, task: Task) -> list[Resource]:
        return [r for r in self._skilled(task) if self.on_shift[r.id] and self.free_slots[r.id] > 0]

    def _try_dispatch_task(self, task: Task) -> Reason | None:
        """Queue the task (logging why it waits, or None) and start it if a resource is free."""
        eligible = self._eligible(task)
        reason = None
        if not eligible:
            skilled = self._skilled(task)
            if not skilled:
                reason = Reason.NO_ELIGIBLE_RESOURCE
            elif not any(self.on_shift[r.id] for r in skilled):
                reason = Reason.OFF_SHIFT
            else:
                reason = Reason.ALL_RESOURCES_BUSY
        transition(task, S.QUEUED, self.now, self.events, reason=reason)
        if eligible:
            self._start(task, self.policy.choose_resource(task, eligible, self.busy_minutes))
        else:
            self.queues.setdefault((task.department_id, self._step(task).required_skill), []).append(task)
        return reason

    def _dispatch_resource(self, r: Resource) -> None:
        # on_shift check: a task finishing as overrun after shift end must not pull new work
        while self.on_shift[r.id] and self.free_slots[r.id] > 0:
            waiting = [t for s in sorted(r.skills) for t in self.queues.get((r.department_id, s), [])]
            if not waiting:
                return
            task = min(waiting, key=lambda t: self.policy.order_key(t, self._step(t)))
            self.queues[task.department_id, self._step(task).required_skill].remove(task)
            self._start(task, r)

    def _start(self, task: Task, r: Resource) -> None:
        transition(task, S.ASSIGNED, self.now, self.events, resource_id=r.id)
        step = self._step(task)
        d = task.remaining if task.remaining is not None else step.duration.sample(self.rng) / r.speed_factor
        task.remaining = None
        overrun = max(0.0, self.now + d - r.schedule.next_off(self.now))
        transition(task, S.IN_PROGRESS, self.now, self.events, payload={"duration": d, "overrun": overrun})
        self.free_slots[r.id] -= 1
        task.run_token += 1
        task.ends_at = self.now + d
        self.schedule(task.ends_at, partial(self._finish, task, task.run_token))
