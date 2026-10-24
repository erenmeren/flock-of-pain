import pytest

from workforce_twin.events import Event, EventKind, Task, TaskState, transition


def _task():
    return Task("t1", "i1", "w1", "s1", "d1")


def test_legal_chain():
    task, log = _task(), []
    for s in (TaskState.QUEUED, TaskState.ASSIGNED, TaskState.IN_PROGRESS, TaskState.COMPLETED):
        transition(task, s, 1.0, log, resource_id="r1")
    assert [e.kind for e in log] == [
        EventKind.TASK_QUEUED,
        EventKind.RESOURCE_ASSIGNED,
        EventKind.TASK_STARTED,
        EventKind.TASK_COMPLETED,
    ]
    assert task.resource_id == "r1" and task.started_at == 1.0 and task.queued_at == 1.0
    assert log[0].task_id == "t1" and log[0].department_id == "d1"


def test_illegal_raises():
    task = _task()
    task.state = TaskState.IN_PROGRESS
    with pytest.raises(ValueError, match="IN_PROGRESS.*QUEUED.*t1"):
        transition(task, TaskState.QUEUED, 1.0, [])


def test_rework():
    task = _task()
    task.state = TaskState.COMPLETED
    with pytest.raises(ValueError):
        transition(task, TaskState.QUEUED, 5.0, [])
    transition(task, TaskState.QUEUED, 5.0, [], rework=True)
    assert task.state == TaskState.QUEUED and task.queued_at == 5.0


def test_unblock_keeps_queued_at():
    task, log = _task(), []
    task.state, task.queued_at = TaskState.BLOCKED, 2.0
    e = transition(task, TaskState.QUEUED, 9.0, log)
    assert e.kind == EventKind.TASK_UNBLOCKED and task.queued_at == 2.0


def test_to_json_deterministic():
    a, b = Event(1.0, EventKind.TASK_QUEUED), Event(1.0, EventKind.TASK_QUEUED)
    assert a.to_json() == b.to_json()
    assert '"kind":"TASK_QUEUED"' in a.to_json()
