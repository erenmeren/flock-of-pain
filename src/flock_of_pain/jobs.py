"""Background jobs: one daemon thread each, in memory of this one process, so they are lost on restart."""
import logging
import os
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from flock_of_pain.io import SchemaError
from flock_of_pain.model import ModelError

MAX_JOBS = int(os.environ.get("FLOCK_MAX_JOBS", "2"))  # active per tenant
TTL_SECONDS = 3600  # a finished job is kept this long
MAX_FINISHED = 10  # per tenant, newest kept: results with events can be large
ACTIVE = ("queued", "running")
log = logging.getLogger(__name__)

_clock = time.monotonic
_lock = threading.Lock()
_jobs: dict[str, "_Job"] = {}


class Cancelled(Exception):
    pass


@dataclass
class _Job:
    id: str
    tenant: str
    kind: str
    total: int
    status: str = "queued"
    done: int = 0
    result: dict | None = None
    error: dict | None = None
    cancel: bool = False
    finished_at: float | None = None


def _view(job: _Job) -> dict:
    out = {"id": job.id, "kind": job.kind, "status": job.status, "done": job.done, "total": job.total}
    if job.result is not None:
        out["result"] = job.result
    if job.error is not None:
        out["error"] = job.error
    return out


def _evict() -> None:
    now = _clock()
    for j in [j for j in _jobs.values() if j.finished_at is not None and now - j.finished_at >= TTL_SECONDS]:
        del _jobs[j.id]
    finished: dict[str, list[_Job]] = {}
    for j in _jobs.values():
        if j.finished_at is not None:
            finished.setdefault(j.tenant, []).append(j)
    for jobs in finished.values():
        for j in sorted(jobs, key=lambda j: j.finished_at)[:-MAX_FINISHED]:
            del _jobs[j.id]


def _progress(job: _Job, n: int = 1) -> None:
    """Counts n finished replications; n=0 only checks. Raises Cancelled once the job is cancelled."""
    with _lock:
        if job.cancel:
            raise Cancelled
        job.done = min(job.total, job.done + n)


def _run(job: _Job, fn: Callable) -> None:
    with _lock:
        if job.status != "queued":  # cancelled before this thread got to run
            return
        job.status = "running"
    status, result, error = "done", None, None
    try:
        result = fn(lambda n=1: _progress(job, n))
    except Cancelled:
        status = "cancelled"
    except ModelError as e:
        path, message = (e.path, e.message) if isinstance(e, SchemaError) else (None, str(e))
        status, error = "failed", {"path": path, "message": message}
    except Exception:
        log.exception("job %s failed", job.id)
        status, error = "failed", {"path": None, "message": "the job failed unexpectedly"}
    with _lock:
        if job.cancel:  # a cancel that came after the last check still wins
            status, result, error = "cancelled", None, None
        elif status == "done":
            job.done = job.total  # an optimizer's total is an upper bound
        job.status, job.result, job.error, job.finished_at = status, result, error, _clock()
        _evict()


def submit(tenant: str, kind: str, total: int, fn: Callable) -> str | None:
    """Starts fn(progress) on its own thread and returns the job id, or None at the tenant's cap of active jobs."""
    with _lock:
        _evict()
        if sum(j.tenant == tenant and j.status in ACTIVE for j in _jobs.values()) >= MAX_JOBS:
            return None
        job = _Job(uuid.uuid4().hex, tenant, kind, total)
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job, fn), daemon=True).start()
    return job.id


def get(tenant: str, job_id: str) -> dict | None:
    with _lock:
        _evict()
        job = _jobs.get(job_id)
        return _view(job) if job is not None and job.tenant == tenant else None


def cancel(tenant: str, job_id: str) -> dict | None:
    """Flags an active job. One already running stays `running` until its current replications end."""
    with _lock:
        _evict()
        job = _jobs.get(job_id)
        if job is None or job.tenant != tenant:
            return None
        if job.status in ACTIVE:
            job.cancel = True
            if job.status == "queued":
                job.status, job.finished_at = "cancelled", _clock()
        return _view(job)
