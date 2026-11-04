import hashlib
import heapq
import math
import random
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial

from flock_of_pain.events import Event, EventKind, Reason, Task, TaskState, transition
from flock_of_pain.model import Company, ModelError, Resource, Step, Workflow
from flock_of_pain.schedule import MINUTES_PER_DAY, MINUTES_PER_WEEK
from flock_of_pain.scheduling import POLICIES

K = EventKind
S = TaskState


@dataclass
class RunConfig:
    seed: int
    horizon_minutes: float
    replications: int = 1
    policy: str = "priority"
    crn: bool = False  # common random numbers: one stream per random purpose, stable across scenarios


@dataclass
class Instance:
    id: str
    workflow: Workflow
    completed: set[str] = field(default_factory=set)
    active: dict[str, str] = field(default_factory=dict)  # step id -> task id
    retries: int = 0
    done_tasks: dict[str, Task] = field(default_factory=dict)  # step id -> completed task (for rework)
    cancelled: bool = False
    due_at: float | None = None
    skipped: set[str] = field(default_factory=set)  # conditional steps not taken (count as done)
    branched: set[str] = field(default_factory=set)  # branching steps whose draw is made


class Engine:
    def __init__(self, company: Company, config: RunConfig):
        if not company._index and company.resources():
            raise ModelError("company not resolved; call Company.resolve()")
        self.company = company
        self.config = config
        self.horizon = config.horizon_minutes
        self.policy = POLICIES[config.policy]()
        self.rng = random.Random(config.seed)
        self._streams: dict[tuple[str, str], random.Random] = {}
        self.now = 0.0
        self.events: list[Event] = []
        self._heap: list[tuple[float, int, Callable[[], None]]] = []
        self._seq = 0
        self._paused = False
        self.steps = {(w.id, s.id): s for w in company.workflows for s in w.steps}
        self.instances: dict[str, Instance] = {}
        self._arrivals = {w.id: 0 for w in company.workflows}
        self.queues: dict[tuple[str, str], dict[str, Task]] = {}  # (dept, skill) -> task id -> task, in enqueue order
        # (dept, skill) -> system id -> heap of (order_key, task id); stale entries are skipped on read
        self._heaps: dict[tuple[str, str], dict[str | None, list[tuple[tuple, str]]]] = {}
        self._skilled_cache: dict[tuple[str, str], list[Resource]] = {}
        resources = company.resources()
        self.free_slots = {r.id: r.capacity for r in resources}
        self.busy_minutes = {r.id: 0.0 for r in resources}
        self.on_shift = {r.id: False for r in resources}
        self.system_down = {s.id: 0 for s in company.systems}
        self.in_progress: dict[str, set[str]] = defaultdict(set)  # system id -> ids of tasks running or blocked on it
        self.tasks_by_id: dict[str, Task] = {}  # tasks in in_progress only
        self._created = 0
        self._queue_keys: dict[str, tuple] = {}  # task id -> policy order_key, fixed while queued
        self._held: set[str] = set()  # queued task ids waiting for their step's release hour (not on a heap)
        self._releases: dict[float, list[Task]] = {}  # release time -> tasks held for it

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

    def _rng(self, kind: str, key: str) -> random.Random:
        if not self.config.crn:
            return self.rng
        if (r := self._streams.get((kind, key))) is None:
            h = hashlib.sha256(f"{self.config.seed}:{kind}:{key}".encode()).digest()[:8]
            r = self._streams[kind, key] = random.Random(int.from_bytes(h, "big"))
        return r

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
        profile, windows = wf.arrival.profile, wf.arrival_windows
        thin = profile is not None or windows
        peak = (profile.peak if profile else 1.0) * math.prod(max(f, 1.0) for _, _, f in windows)
        rate = wf.arrival.rate_per_hour * peak / 60
        if rate <= 0:
            return
        rng = self._rng("arrival", wf.id)
        while True:
            t2 = t + rng.expovariate(rate)
            while t2 < self.horizon and not wf.arrival.window.is_on(t2):
                if (t2 := wf.arrival.window.next_on(t2)) is None:
                    return
                t2 += rng.expovariate(rate)
            if t2 >= self.horizon:
                return
            # non-homogeneous Poisson by thinning; the extra draw happens only for a profile or windowed multiplier
            if not thin or rng.random() * peak < (
                    math.prod(f for a, b, f in windows if a <= t2 < b) * (profile.mult(t2) if profile else 1.0)):
                self.schedule(t2, partial(self._arrive, wf))
                return
            t = t2

    def _arrive(self, wf: Workflow) -> None:
        self._arrivals[wf.id] += 1
        inst = Instance(f"{wf.id}-{self._arrivals[wf.id]:06d}", wf)
        self.instances[inst.id] = inst
        self.events.append(Event(self.now, K.WORKFLOW_STARTED, instance_id=inst.id, workflow_id=wf.id))
        if wf.cutoff_hour is not None:  # due at the next cutoff_hour:00 strictly after now
            due = self.now // MINUTES_PER_DAY * MINUTES_PER_DAY + wf.cutoff_hour * 60
            inst.due_at = due if due > self.now else due + MINUTES_PER_DAY
            self.schedule(inst.due_at, partial(self._deadline, inst))
        for s in wf.steps:
            if not s.depends_on:
                self._create_task(inst, s)
        self._next_arrival(wf, self.now)

    def _deadline(self, inst: Instance) -> None:
        # completed instances are gone from self.instances; cancelled ones are failures, not late
        if self.instances.get(inst.id) is inst and not inst.cancelled:
            self.events.append(Event(self.now, K.DEADLINE_MISSED, instance_id=inst.id, workflow_id=inst.workflow.id))

    def _outage_start(self, system_id: str) -> None:
        self.system_down[system_id] += 1
        if self.system_down[system_id] > 1:
            return
        self.events.append(Event(self.now, K.SYSTEM_OUTAGE_STARTED, system_id=system_id))
        freed = set()
        queued = [t for q in self.queues.values() for t in q.values()
                  if self._step(t).system_id == system_id and t.id not in self._held]
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
        # a BLOCKED task of a cancelled instance resumes and completes but spawns nothing (blocked = paused in-progress)
        for task in sorted((self.tasks_by_id.pop(i) for i in ids), key=lambda t: t.seq):
            self._try_dispatch_task(task)
        # queued tasks on this system: every free resource re-scans its queues
        for r in self.company.resources():
            self._dispatch_resource(r)
        for key, q in list(self.queues.items()):
            if any(self._step(t).system_id == system_id for t in q.values()):
                self._retag_queue(*key)

    def _finish(self, task: Task, token: int) -> None:
        if task.run_token != token or task.state != S.IN_PROGRESS:
            return
        r = None if task.resource_id is None else self.company.resource(task.resource_id)  # None: wait step
        step = self._step(task)
        if step.system_id is not None:
            self.in_progress[step.system_id].discard(task.id)
            del self.tasks_by_id[task.id]
        if r is not None:
            self.busy_minutes[r.id] += self.now - task.started_at
            self.free_slots[r.id] += 1
        inst = self.instances[task.instance_id]
        key = f"{task.workflow_id}/{step.id}"
        if self._rng("failure", key).random() < step.failure_prob:  # drawn even at 0 so logs stay comparable
            transition(task, S.FAILED, self.now, self.events)
            retry = not inst.cancelled and inst.retries < step.max_retries
            if not retry:
                inst.cancelled = True
                self._cancel_queued(inst)  # before dispatch, so the freed slot cannot start a sibling
            if r is not None:
                self._dispatch_resource(r)  # older queued work goes before the retry
            if retry:
                inst.retries += 1
                if step.rework_to is None or step.rework_to == step.id:
                    self._try_dispatch_task(task)
                else:
                    # failed step is re-created by the dependency rule once rework_to completes again
                    inst.completed.discard(step.id)
                    inst.active.pop(step.id, None)
                    redo = inst.done_tasks.get(step.rework_to)
                    if step.rework_to in inst.skipped:  # rework activates a conditional step that was skipped
                        inst.skipped.discard(step.rework_to)
                        self._create_task(inst, self.steps[inst.workflow.id, step.rework_to])
                    elif redo.state == S.COMPLETED:  # else already re-queued by another failed step
                        inst.completed.discard(step.rework_to)
                        inst.active[step.rework_to] = redo.id
                        self._try_dispatch_task(redo, rework=True)
            else:
                transition(task, S.CANCELLED, self.now, self.events)
                inst.active.pop(step.id, None)
                if not inst.active:
                    del self.instances[inst.id]
            return
        transition(task, S.COMPLETED, self.now, self.events)
        if r is not None and step.sla_minutes is not None and self.now - task.queued_at > step.sla_minutes:
            self.events.append(Event(
                self.now, K.SLA_BREACHED, task.id, task.instance_id, task.workflow_id, step.id,
                task.department_id, r.id,
            ))
        inst.completed.add(step.id)
        inst.active.pop(step.id, None)
        inst.done_tasks[step.id] = task
        # freed slot serves already-queued work before this instance's successors
        if r is not None:
            self._dispatch_resource(r)
        if inst.cancelled:
            if not inst.active:
                del self.instances[inst.id]
            return
        if step.branches and step.id not in inst.branched:  # draw once; a reworked branching step keeps its path
            inst.branched.add(step.id)
            u, acc = self._rng("branch", key).random(), 0.0
            for to, p in step.branches:
                if acc <= u < acc + p:
                    inst.skipped.discard(to)
                else:
                    self._skip(inst, to)
                acc += p
        done = inst.completed | inst.skipped if inst.skipped else inst.completed
        for s in inst.workflow.steps:
            if s.id not in done and s.id not in inst.active and set(s.depends_on) <= done:
                self._create_task(inst, s)
        if len(done) == len(inst.workflow.steps):
            self.events.append(Event(
                self.now, K.WORKFLOW_COMPLETED, instance_id=inst.id, workflow_id=inst.workflow.id,
            ))
            del self.instances[inst.id]

    def _skip(self, inst: Instance, step_id: str) -> None:
        inst.skipped.add(step_id)
        for to, _ in self.steps[inst.workflow.id, step_id].branches:
            self._skip(inst, to)

    def _cancel_queued(self, inst: Instance) -> None:
        for step_id, task_id in list(inst.active.items()):
            if task_id not in self._queue_keys:
                continue  # running or blocked: finishes normally and spawns nothing
            step = self.steps[inst.workflow.id, step_id]
            task = self.queues[step.department_id, step.required_skill].pop(task_id)
            del self._queue_keys[task_id]
            self._held.discard(task_id)
            transition(task, S.CANCELLED, self.now, self.events)
            del inst.active[step_id]

    # --- dispatch ---

    def _step(self, task: Task) -> Step:
        return self.steps[task.workflow_id, task.step_id]

    def _create_task(self, inst: Instance, step: Step) -> None:
        task = Task(
            f"{inst.id}:{step.id}:{inst.retries}", inst.id, inst.workflow.id, step.id,
            step.department_id, created_at=self.now, seq=self._created, due_at=inst.due_at,
        )
        self._created += 1
        inst.active[step.id] = task.id
        self.events.append(Event(
            self.now, K.TASK_CREATED, task.id, inst.id, inst.workflow.id, step.id, step.department_id,
        ))
        self._try_dispatch_task(task)

    def _skilled(self, task: Task) -> list[Resource]:
        key = (task.department_id, self._step(task).required_skill)
        if (rs := self._skilled_cache.get(key)) is None:  # resources do not change during a run
            rs = self._skilled_cache[key] = [
                r for r in self.company.department(key[0]).resources if key[1] in r.skills and r.capacity > 0]
        return rs

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

    def _try_dispatch_task(self, task: Task, rework: bool = False) -> None:
        """Queue the task (logging why it waits, or None) and start it if a resource is free."""
        if self._step(task).required_skill is None:  # wait step: starts at once, no queue, no resource
            d = self._step(task).duration.sample(self._rng("duration", f"{task.workflow_id}/{task.step_id}"))
            transition(task, S.IN_PROGRESS, self.now, self.events, rework=rework, payload={"duration": d})
            task.run_token += 1
            task.ends_at = self.now + d
            self.schedule(task.ends_at, partial(self._finish, task, task.run_token))
            return
        step = self._step(task)
        fresh = task.state == S.CREATED  # retries, rework and resumes are neither held nor abandoned
        hold = bool(step.release_hours) and fresh
        patience = step.patience.sample(self._rng("patience", f"{task.workflow_id}/{step.id}")) if step.patience is not None and fresh else None
        eligible = [] if hold else self._eligible(task)
        reason = Reason.BATCH_HOLD if hold else None if eligible else self._wait_reason(task)
        system_id = None if hold else self._down(task)
        transition(task, S.QUEUED, self.now, self.events, reason=reason, system_id=system_id, rework=rework)
        task.last_reason = reason
        if eligible:
            self._start(task, self.policy.choose_resource(task, eligible, self.busy_minutes))
            return
        if patience is not None:
            self.schedule(self.now + patience, partial(self._abandon, task))
        qkey = (task.department_id, step.required_skill)
        self.queues.setdefault(qkey, {})[task.id] = task
        k = self._queue_keys[task.id] = self.policy.order_key(task, step)
        if not hold:
            heapq.heappush(self._heaps.setdefault(qkey, {}).setdefault(step.system_id, []), (k, task.id))
            return
        day = self.now // MINUTES_PER_DAY * MINUTES_PER_DAY
        t = min(day + d + h * 60 for d in (0, MINUTES_PER_DAY) for h in step.release_hours if day + d + h * 60 >= self.now)
        self._held.add(task.id)
        if t not in self._releases:
            self._releases[t] = []
            self.schedule(t, partial(self._release, t))
        self._releases[t].append(task)

    def _abandon(self, task: Task) -> None:
        if task.id not in self._queue_keys or task.started_at is not None:
            return  # started (or cancelled) before its patience ran out
        self.events.append(Event(self.now, K.TASK_ABANDONED, task.id, task.instance_id, task.workflow_id, task.step_id,
                                 task.department_id))
        inst = self.instances[task.instance_id]
        inst.cancelled = True
        self._cancel_queued(inst)
        if not inst.active:
            del self.instances[inst.id]

    def _release(self, t: float) -> None:
        """Put the tasks held for this release time on their heaps, dispatch, then retag what still waits."""
        tasks = [x for x in self._releases.pop(t) if x.id in self._held]  # cancelled ones are gone
        for task in tasks:
            self._held.discard(task.id)
            step = self._step(task)
            heapq.heappush(self._heaps.setdefault((task.department_id, step.required_skill), {})
                           .setdefault(step.system_id, []), (self._queue_keys[task.id], task.id))
        for r in {r.id: r for x in tasks for r in self._skilled(x)}.values():
            self._dispatch_resource(r)
        for key in dict.fromkeys((x.department_id, self._step(x).required_skill) for x in tasks):
            self._retag_queue(*key)

    def _retag_queue(self, department_id: str, skill: str) -> None:
        """Log a retag TASK_QUEUED for each queued task whose wait reason changed."""
        reasons: dict[str | None, Reason] = {}  # within one queue the reason depends only on the step's system
        down: dict[str | None, str | None] = {}
        for task in self.queues.get((department_id, skill), {}).values():
            if task.id in self._held:
                continue
            system_id = self.steps[task.workflow_id, task.step_id].system_id
            if (reason := reasons.get(system_id)) is None:
                reason = reasons[system_id] = self._wait_reason(task)
                down[system_id] = self._down(task)
            if reason != task.last_reason:
                self.events.append(Event(
                    self.now, K.TASK_QUEUED, task.id, task.instance_id, task.workflow_id, task.step_id,
                    task.department_id, system_id=down[system_id], reason=reason, payload={"retag": True},
                ))
                task.last_reason = reason

    def _dispatch_resource(self, r: Resource) -> None:
        # on_shift check: a task finishing as overrun after shift end must not pull new work
        keys = self._queue_keys
        while self.on_shift[r.id] and self.free_slots[r.id] > 0:
            best = best_h = best_q = None
            for s in sorted(r.skills):
                qkey = (r.department_id, s)
                for system_id, h in self._heaps.get(qkey, {}).items():
                    if system_id is not None and self.system_down[system_id] > 0:
                        continue
                    while h and keys.get(h[0][1]) != h[0][0]:
                        heapq.heappop(h)  # stale: started or cancelled since it was pushed
                    # order keys end in the task id, so they are unique and the minimum is unambiguous
                    if h and (best is None or h[0][0] < best):
                        best, best_h, best_q = h[0][0], h, qkey
            if best is None:
                return
            task = self.queues[best_q].pop(heapq.heappop(best_h)[1])
            del keys[task.id]
            self._start(task, r)

    def _start(self, task: Task, r: Resource) -> None:
        transition(task, S.ASSIGNED, self.now, self.events, resource_id=r.id)
        step = self._step(task)
        d = (task.remaining if task.remaining is not None
             else step.duration.sample(self._rng("duration", f"{task.workflow_id}/{step.id}")) / r.speed_factor)
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
