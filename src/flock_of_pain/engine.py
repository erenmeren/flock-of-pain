import heapq
import random
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial

from flock_of_pain.events import Event, EventKind, Reason, Task, TaskState, transition
from flock_of_pain.model import Company, ModelError, Resource, Step, Workflow
from flock_of_pain.schedule import MINUTES_PER_WEEK
from flock_of_pain.scheduling import POLICIES

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
    done_tasks: dict[str, Task] = field(default_factory=dict)  # step id -> completed task (for rework)
    cancelled: bool = False


class Engine:
    def __init__(self, company: Company, config: RunConfig):
        if not company._index and company.resources():
            raise ModelError("company not resolved; call Company.resolve()")
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
        self.system_down = {s.id: 0 for s in company.systems}
        self.in_progress: dict[str, set[str]] = defaultdict(set)  # system id -> ids of tasks running or blocked on it
        self.tasks_by_id: dict[str, Task] = {}  # tasks in in_progress only
        self._created = 0
        self._queue_keys: dict[str, tuple] = {}  # task id -> policy order_key, fixed while queued

        for r in resources:
            t = 0.0
            while t < self.horizon:
                if (on := r.schedule.next_on(t)) is None:
                    if not r.schedule.weekday_hours:
                        break
                    # next_on looks only 2 weeks ahead: skip past a long absence (or a week) and retry
                    t = max((b for a, b in r.schedule.absences if a <= t < b), default=t + MINUTES_PER_WEEK)
                    continue
                if on >= self.horizon:
                    break
                self.schedule(on, partial(self._shift, r, True))
                t = r.schedule.next_off(on)
                if t < self.horizon:
                    self.schedule(t, partial(self._shift, r, False))
        for system_id, start, end in company.outages:
            if system_id not in self.system_down:
                raise ModelError(f"outage: unknown system_id {system_id}")
            if end <= start:
                raise ModelError(f"outage on {system_id}: end {end} must be after start {start}")
            self.schedule(start, partial(self._outage_start, system_id))
            self.schedule(end, partial(self._outage_end, system_id))
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
        while not self._paused and self._heap and self._heap[0][0] <= t:
            self.now, _, fn = heapq.heappop(self._heap)
            fn()
        if not self._paused:
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
        for skill in sorted(r.skills):
            self._retag_queue(r.department_id, skill)

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

    def _outage_start(self, system_id: str) -> None:
        self.system_down[system_id] += 1
        if self.system_down[system_id] > 1:
            return
        self.events.append(Event(self.now, K.SYSTEM_OUTAGE_STARTED, system_id=system_id))
        freed = set()
        queued = [t for q in self.queues.values() for t in q if self._step(t).system_id == system_id]
        running = [self.tasks_by_id[i] for i in self.in_progress[system_id]]
        for task in sorted(running + queued, key=lambda t: t.seq):  # creation order
            if task.state == S.IN_PROGRESS:
                task.remaining = task.ends_at - self.now
                self.busy_minutes[task.resource_id] += self.now - task.started_at
                self.free_slots[task.resource_id] += 1
                transition(task, S.BLOCKED, self.now, self.events, reason=Reason.SYSTEM_DOWN, system_id=system_id)
                task.run_token += 1
                freed.add(task.resource_id)
            else:
                # no state change: log that the queued task now waits on the system
                self.events.append(Event(
                    self.now, K.TASK_QUEUED, task.id, task.instance_id, task.workflow_id, task.step_id,
                    task.department_id, system_id=system_id, reason=Reason.SYSTEM_DOWN, payload={"retag": True},
                ))
                task.last_reason = Reason.SYSTEM_DOWN
        for r in self.company.resources():
            if r.id in freed:
                self._dispatch_resource(r)

    def _outage_end(self, system_id: str) -> None:
        self.system_down[system_id] -= 1
        if self.system_down[system_id] > 0:
            return
        self.events.append(Event(self.now, K.SYSTEM_OUTAGE_ENDED, system_id=system_id))
        ids, self.in_progress[system_id] = self.in_progress[system_id], set()
        for task in sorted((self.tasks_by_id.pop(i) for i in ids), key=lambda t: t.seq):
            self._try_dispatch_task(task)
        # queued tasks on this system: every free resource re-scans its queues
        for r in self.company.resources():
            self._dispatch_resource(r)
        for key, q in list(self.queues.items()):
            if any(self._step(t).system_id == system_id for t in q):
                self._retag_queue(*key)

    def _finish(self, task: Task, token: int) -> None:
        if task.run_token != token or task.state != S.IN_PROGRESS:
            return
        r = self.company.resource(task.resource_id)
        step = self._step(task)
        if step.system_id is not None:
            self.in_progress[step.system_id].discard(task.id)
            del self.tasks_by_id[task.id]
        self.busy_minutes[r.id] += self.now - task.started_at
        self.free_slots[r.id] += 1
        inst = self.instances[task.instance_id]
        if self.rng.random() < step.failure_prob:  # drawn even at 0 so logs stay comparable
            transition(task, S.FAILED, self.now, self.events)
            self._dispatch_resource(r)  # older queued work goes before the retry
            if not inst.cancelled and inst.retries < step.max_retries:
                inst.retries += 1
                if step.rework_to is None or step.rework_to == step.id:
                    self._try_dispatch_task(task)
                else:
                    # failed step is re-created by the dependency rule once rework_to completes again
                    inst.completed.discard(step.id)
                    inst.active.pop(step.id, None)
                    redo = inst.done_tasks[step.rework_to]
                    if redo.state == S.COMPLETED:  # else already re-queued by another failed step
                        inst.completed.discard(step.rework_to)
                        inst.active[step.rework_to] = redo.id
                        self._try_dispatch_task(redo, rework=True)
            else:
                transition(task, S.CANCELLED, self.now, self.events)
                inst.active.pop(step.id, None)
                inst.cancelled = True
            return
        transition(task, S.COMPLETED, self.now, self.events)
        if step.sla_minutes is not None and self.now - task.queued_at > step.sla_minutes:
            self.events.append(Event(
                self.now, K.SLA_BREACHED, task.id, task.instance_id, task.workflow_id, step.id,
                task.department_id, r.id,
            ))
        inst.completed.add(step.id)
        inst.active.pop(step.id, None)
        inst.done_tasks[step.id] = task
        # freed slot serves already-queued work before this instance's successors
        self._dispatch_resource(r)
        if inst.cancelled:
            return
        for s in inst.workflow.steps:
            if s.id not in inst.completed and s.id not in inst.active and set(s.depends_on) <= inst.completed:
                self._create_task(inst, s)
        if len(inst.completed) == len(inst.workflow.steps):
            self.events.append(Event(
                self.now, K.WORKFLOW_COMPLETED, instance_id=inst.id, workflow_id=inst.workflow.id,
            ))
            del self.instances[inst.id]

    # --- dispatch ---

    def _step(self, task: Task) -> Step:
        return self.steps[task.workflow_id, task.step_id]

    def _create_task(self, inst: Instance, step: Step) -> Task:
        task = Task(
            f"{inst.id}:{step.id}:{inst.retries}", inst.id, inst.workflow.id, step.id,
            step.department_id, created_at=self.now, seq=self._created,
        )
        self._created += 1
        inst.active[step.id] = task.id
        self.events.append(Event(
            self.now, K.TASK_CREATED, task.id, inst.id, inst.workflow.id, step.id, step.department_id,
        ))
        self._try_dispatch_task(task)
        return task

    def _skilled(self, task: Task) -> list[Resource]:
        skill = self._step(task).required_skill
        return [r for r in self.company.department(task.department_id).resources if skill in r.skills and r.capacity > 0]

    def _down(self, task: Task) -> str | None:
        system_id = self._step(task).system_id
        return system_id if system_id is not None and self.system_down[system_id] > 0 else None

    def _eligible(self, task: Task) -> list[Resource]:
        if self._down(task):
            return []
        return [r for r in self._skilled(task) if self.on_shift[r.id] and self.free_slots[r.id] > 0]

    def _wait_reason(self, task: Task) -> Reason:
        """Why a task with no eligible resource waits."""
        if self._down(task):
            return Reason.SYSTEM_DOWN
        skilled = self._skilled(task)
        if not skilled:
            return Reason.NO_ELIGIBLE_RESOURCE
        if not any(self.on_shift[r.id] for r in skilled):
            return Reason.OFF_SHIFT
        return Reason.ALL_RESOURCES_BUSY

    def _try_dispatch_task(self, task: Task, rework: bool = False) -> Reason | None:
        """Queue the task (logging why it waits, or None) and start it if a resource is free."""
        eligible = self._eligible(task)
        reason = None if eligible else self._wait_reason(task)
        system_id = self._down(task)
        transition(task, S.QUEUED, self.now, self.events, reason=reason, system_id=system_id, rework=rework)
        task.last_reason = reason
        if eligible:
            self._start(task, self.policy.choose_resource(task, eligible, self.busy_minutes))
        else:
            self.queues.setdefault((task.department_id, self._step(task).required_skill), []).append(task)
            self._queue_keys[task.id] = self.policy.order_key(task, self._step(task))
        return reason

    def _retag_queue(self, department_id: str, skill: str) -> None:
        """Log a retag TASK_QUEUED for each queued task whose wait reason changed."""
        reasons: dict[str | None, Reason] = {}  # within one queue the reason depends only on the step's system
        for task in self.queues.get((department_id, skill), []):
            system_id = self.steps[task.workflow_id, task.step_id].system_id
            if (reason := reasons.get(system_id)) is None:
                reason = reasons[system_id] = self._wait_reason(task)
            if reason != task.last_reason:
                self.events.append(Event(
                    self.now, K.TASK_QUEUED, task.id, task.instance_id, task.workflow_id, task.step_id,
                    task.department_id, system_id=self._down(task), reason=reason, payload={"retag": True},
                ))
                task.last_reason = reason

    def _dispatch_resource(self, r: Resource) -> None:
        # on_shift check: a task finishing as overrun after shift end must not pull new work
        while self.on_shift[r.id] and self.free_slots[r.id] > 0:
            best = best_q = best_i = None
            keys = self._queue_keys
            any_down = any(self.system_down.values())
            for s in sorted(r.skills):
                q = self.queues.get((r.department_id, s), ())
                for i, t in enumerate(q):
                    if any_down and self._down(t):
                        continue
                    k = keys[t.id]
                    if best is None or k < best:  # strict: first minimum wins, as min() did
                        best, best_q, best_i = k, q, i
            if best is None:
                return
            task = best_q.pop(best_i)
            del self._queue_keys[task.id]
            self._start(task, r)

    def _start(self, task: Task, r: Resource) -> None:
        transition(task, S.ASSIGNED, self.now, self.events, resource_id=r.id)
        step = self._step(task)
        d = task.remaining if task.remaining is not None else step.duration.sample(self.rng) / r.speed_factor
        task.remaining = None
        overrun = max(0.0, self.now + d - r.schedule.next_off(self.now))
        transition(task, S.IN_PROGRESS, self.now, self.events, payload={"duration": d, "overrun": overrun})
        self.free_slots[r.id] -= 1
        if step.system_id is not None:
            self.in_progress[step.system_id].add(task.id)
            self.tasks_by_id[task.id] = task
        task.run_token += 1
        task.ends_at = self.now + d
        self.schedule(task.ends_at, partial(self._finish, task, task.run_token))
