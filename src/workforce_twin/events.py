import json
from dataclasses import asdict, dataclass, field
from enum import StrEnum


class EventKind(StrEnum):
    TASK_CREATED = "TASK_CREATED"
    TASK_QUEUED = "TASK_QUEUED"
    RESOURCE_ASSIGNED = "RESOURCE_ASSIGNED"
    TASK_STARTED = "TASK_STARTED"
    TASK_COMPLETED = "TASK_COMPLETED"
    TASK_FAILED = "TASK_FAILED"
    TASK_BLOCKED = "TASK_BLOCKED"
    TASK_UNBLOCKED = "TASK_UNBLOCKED"
    TASK_CANCELLED = "TASK_CANCELLED"
    RESOURCE_UNAVAILABLE = "RESOURCE_UNAVAILABLE"
    RESOURCE_AVAILABLE = "RESOURCE_AVAILABLE"
    SYSTEM_OUTAGE_STARTED = "SYSTEM_OUTAGE_STARTED"
    SYSTEM_OUTAGE_ENDED = "SYSTEM_OUTAGE_ENDED"
    SLA_BREACHED = "SLA_BREACHED"
    WORKFLOW_STARTED = "WORKFLOW_STARTED"
    WORKFLOW_COMPLETED = "WORKFLOW_COMPLETED"


class Reason(StrEnum):
    NO_ELIGIBLE_RESOURCE = "NO_ELIGIBLE_RESOURCE"
    ALL_RESOURCES_BUSY = "ALL_RESOURCES_BUSY"
    OFF_SHIFT = "OFF_SHIFT"
    SYSTEM_DOWN = "SYSTEM_DOWN"


class TaskState(StrEnum):
    CREATED = "CREATED"
    QUEUED = "QUEUED"
    ASSIGNED = "ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    BLOCKED = "BLOCKED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


@dataclass
class Event:
    t: float
    kind: EventKind
    task_id: str | None = None
    instance_id: str | None = None
    workflow_id: str | None = None
    step_id: str | None = None
    department_id: str | None = None
    resource_id: str | None = None
    system_id: str | None = None
    reason: Reason | None = None
    payload: dict = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))


@dataclass
class Task:
    id: str
    instance_id: str
    workflow_id: str
    step_id: str
    department_id: str
    state: TaskState = TaskState.CREATED
    created_at: float = 0.0
    queued_at: float | None = None
    started_at: float | None = None
    resource_id: str | None = None
    remaining: float | None = None
    ends_at: float | None = None
    run_token: int = 0
    retries: int = 0
    last_reason: Reason | None = None  # reason on the latest TASK_QUEUED / retag


S = TaskState
LEGAL: dict[TaskState, frozenset[TaskState]] = {
    S.CREATED: frozenset({S.QUEUED}),
    S.QUEUED: frozenset({S.ASSIGNED, S.CANCELLED}),
    S.ASSIGNED: frozenset({S.IN_PROGRESS}),
    S.IN_PROGRESS: frozenset({S.COMPLETED, S.FAILED, S.BLOCKED}),
    S.BLOCKED: frozenset({S.QUEUED}),
    S.FAILED: frozenset({S.QUEUED, S.CANCELLED}),
    S.COMPLETED: frozenset({S.QUEUED}),  # only with rework=True
    S.CANCELLED: frozenset(),
}

STATE_EVENT: dict[TaskState, EventKind] = {
    S.CREATED: EventKind.TASK_CREATED,
    S.QUEUED: EventKind.TASK_QUEUED,
    S.ASSIGNED: EventKind.RESOURCE_ASSIGNED,
    S.IN_PROGRESS: EventKind.TASK_STARTED,
    S.BLOCKED: EventKind.TASK_BLOCKED,
    S.COMPLETED: EventKind.TASK_COMPLETED,
    S.FAILED: EventKind.TASK_FAILED,
    S.CANCELLED: EventKind.TASK_CANCELLED,
}


def transition(
    task: Task,
    new: TaskState,
    t: float,
    log: list[Event],
    *,
    reason: Reason | None = None,
    resource_id: str | None = None,
    system_id: str | None = None,
    rework: bool = False,
    payload: dict | None = None,
) -> Event:
    old = task.state
    if new not in LEGAL[old] or (old == S.COMPLETED and not rework):
        raise ValueError(f"illegal transition {old} -> {new} for task {task.id}")
    if new == S.ASSIGNED:
        task.resource_id = resource_id
    if new == S.QUEUED and old != S.BLOCKED:
        task.queued_at = t
    if new == S.IN_PROGRESS:
        task.started_at = t
    task.state = new
    kind = EventKind.TASK_UNBLOCKED if old == S.BLOCKED and new == S.QUEUED else STATE_EVENT[new]
    event = Event(
        t, kind, task.id, task.instance_id, task.workflow_id, task.step_id, task.department_id,
        resource_id or task.resource_id, system_id, reason, payload or {},
    )
    log.append(event)
    return event
