import dataclasses
import json
import os
import types

from flock_of_pain.analytics import Metrics
from flock_of_pain.dist import Dist, lognormal_mean
from flock_of_pain.model import (ArrivalSpec, BusinessSystem, Company, Department, ModelError, Resource, Step,
                                 Workflow)
from flock_of_pain.engine import RunConfig
from flock_of_pain.scenario import (Absence, AddEmployee, ArrivalMultiplier, RemoveResource, Scenario, SetPoolHeadcount,
                                    SystemOutage)
from flock_of_pain.schedule import Schedule
from flock_of_pain.scheduling import POLICIES

_REQUIRED = object()
_KINDS = {"const", "uniform", "triangular", "lognormal", "exponential"}
_STEP_DEFAULTS = {"depends_on": [], "system_id": None, "priority": 0, "sla_minutes": None, "failure_prob": 0.0,
                  "rework_to": None, "max_retries": 0}


class SchemaError(ModelError):
    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path, self.message = path, message


def _join(path: str, key) -> str:
    return f"{path}.{key}" if path else str(key)


def _obj(d, path: str) -> dict:
    if not isinstance(d, dict):
        raise SchemaError(path, "expected object")
    return dict(d)


def _get(d: dict, key: str, path: str, typ, default=_REQUIRED):
    """Pop `key` from the working copy `d`, type-checked; ints satisfy float, bools satisfy only bool."""
    p = _join(path, key)
    if key not in d:
        if default is _REQUIRED:
            raise SchemaError(p, "missing required key")
        return default
    v = d.pop(key)
    if v is None and default is None:
        return None
    types = (int, float) if typ is float else typ
    if not isinstance(v, types) or (isinstance(v, bool) and typ is not bool):
        raise SchemaError(p, f"expected {getattr(typ, '__name__', typ)}")
    return v


def _done(d: dict, path: str) -> None:
    for k in d:
        raise SchemaError(_join(path, k), "unknown key")


def _items(d: dict, key: str, path: str, build) -> list:
    return [build(_obj(x, f"{_join(path, key)}[{i}]"), f"{_join(path, key)}[{i}]")
            for i, x in enumerate(_get(d, key, path, list))]


def _strs(d: dict, key: str, path: str, default=_REQUIRED) -> list[str]:
    v = _get(d, key, path, list, default)
    for i, x in enumerate(v):
        if not isinstance(x, str):
            raise SchemaError(f"{_join(path, key)}[{i}]", "expected str")
    return v


def _pair(v, path: str) -> tuple[float, float]:
    if (not isinstance(v, list) or len(v) != 2
            or any(not isinstance(x, (int, float)) or isinstance(x, bool) for x in v)):
        raise SchemaError(path, "expected [start, end]")
    return v[0], v[1]


def dist_from_dict(d: dict, path: str) -> Dist:
    d = _obj(d, path)
    kind = _get(d, "kind", path, str)
    if kind == "lognormal_mean":
        mean, sigma = _get(d, "mean", path, float), _get(d, "sigma", path, float, 0.4)
        for k, v in (("mean", mean), ("sigma", sigma)):
            if v <= 0:
                raise SchemaError(_join(path, k), "must be > 0")
        out = lognormal_mean(mean, sigma)
    elif kind in _KINDS:
        out = Dist(kind, _get(d, "a", path, float), _get(d, "b", path, float, 0.0), _get(d, "c", path, float, 0.0))
    else:
        raise SchemaError(_join(path, "kind"), f"unknown kind {kind!r}")
    _done(d, path)
    return out


def dist_to_dict(x: Dist) -> dict:
    return {"kind": x.kind, "a": x.a, "b": x.b, "c": x.c}


def schedule_from_dict(d: dict | None, path: str) -> Schedule | None:
    if d is None:
        return None
    d = _obj(d, path)
    hp = _join(path, "weekday_hours")
    hours = {}
    for k, v in _get(d, "weekday_hours", path, dict).items():
        if k not in {str(i) for i in range(7)}:
            raise SchemaError(_join(hp, k), "weekday key must be '0'..'6'")
        hours[int(k)] = _pair(v, _join(hp, k))
    ap = _join(path, "absences")
    absences = [_pair(a, f"{ap}[{i}]") for i, a in enumerate(_get(d, "absences", path, list, []))]
    _done(d, path)
    return Schedule(hours, absences)


def schedule_to_dict(s: Schedule | None) -> dict | None:
    if s is None:
        return None
    out = {"weekday_hours": {str(k): list(v) for k, v in sorted(s.weekday_hours.items())}}
    if s.absences:
        out["absences"] = [list(a) for a in s.absences]
    return out


def resource_from_dict(d: dict, department_id: str, path: str) -> Resource:
    d = _obj(d, path)
    r = Resource(
        id=_get(d, "id", path, str), department_id=department_id, name=_get(d, "name", path, str, ""),
        skills=set(_strs(d, "skills", path)), cost_per_hour=_get(d, "cost_per_hour", path, float, 0.0),
        speed_factor=_get(d, "speed_factor", path, float, 1.0),
        schedule=schedule_from_dict(_get(d, "schedule", path, dict, None), _join(path, "schedule")),
        pool_id=_get(d, "pool_id", path, str, None), headcount=_get(d, "headcount", path, int, None))
    _done(d, path)
    return r


def resource_to_dict(r: Resource, pool: Resource | None = None) -> dict:
    out = {"id": r.id}
    if r.name:
        out["name"] = r.name
    out["skills"] = sorted(r.skills)
    out["cost_per_hour"] = r.cost_per_hour
    if r.speed_factor != 1.0:
        out["speed_factor"] = r.speed_factor
    out["schedule"] = None if pool is not None and r.schedule is pool.schedule else schedule_to_dict(r.schedule)
    if r.pool_id is not None:
        out["pool_id"] = r.pool_id
    if r.headcount is not None:
        out["headcount"] = r.headcount
    return out


def _step_from_dict(d: dict, path: str) -> Step:
    s = Step(id=_get(d, "id", path, str), name=_get(d, "name", path, str),
             department_id=_get(d, "department_id", path, str), required_skill=_get(d, "required_skill", path, str),
             duration=dist_from_dict(_get(d, "duration", path, dict), _join(path, "duration")),
             depends_on=list(_strs(d, "depends_on", path, [])), system_id=_get(d, "system_id", path, str, None),
             priority=_get(d, "priority", path, int, 0), sla_minutes=_get(d, "sla_minutes", path, float, None),
             failure_prob=_get(d, "failure_prob", path, float, 0.0), rework_to=_get(d, "rework_to", path, str, None),
             max_retries=_get(d, "max_retries", path, int, 0))
    _done(d, path)
    return s


def _step_to_dict(s: Step) -> dict:
    out = {"id": s.id, "name": s.name, "department_id": s.department_id, "required_skill": s.required_skill,
           "duration": dist_to_dict(s.duration)}
    out.update({k: getattr(s, k) for k, v in _STEP_DEFAULTS.items() if getattr(s, k) != v})
    return out


def _workflow_from_dict(d: dict, path: str) -> Workflow:
    ap = _join(path, "arrival")
    a = _obj(_get(d, "arrival", path, dict), ap)
    arrival = ArrivalSpec(_get(a, "rate_per_hour", ap, float), schedule_from_dict(_get(a, "window", ap, dict), _join(ap, "window")))
    _done(a, ap)
    w = Workflow(_get(d, "id", path, str), _get(d, "name", path, str), _items(d, "steps", path, _step_from_dict), arrival)
    _done(d, path)
    return w


def _department_from_dict(d: dict, path: str) -> Department:
    did = _get(d, "id", path, str)
    dept = Department(did, _get(d, "name", path, str),
                      _items(d, "resources", path, lambda x, p: resource_from_dict(x, did, p)))
    _done(d, path)
    return dept


def _system_from_dict(d: dict, path: str) -> BusinessSystem:
    s = BusinessSystem(_get(d, "id", path, str), _get(d, "name", path, str))
    _done(d, path)
    return s


def company_from_dict(d: dict) -> Company:
    d = _obj(d, "")
    op = "outages"
    outages = []
    for i, o in enumerate(_get(d, "outages", "", list, [])):
        if (not isinstance(o, list) or len(o) != 3 or not isinstance(o[0], str)
                or any(not isinstance(x, (int, float)) or isinstance(x, bool) for x in o[1:])):
            raise SchemaError(f"{op}[{i}]", "expected [system_id, start, end]")
        outages.append((o[0], o[1], o[2]))
    c = Company(_get(d, "id", "", str), _get(d, "name", "", str), _items(d, "departments", "", _department_from_dict),
                _items(d, "systems", "", _system_from_dict), _items(d, "workflows", "", _workflow_from_dict), outages)
    _done(d, "")
    c.resolve()
    return c


def company_to_dict(c: Company) -> dict:
    pools = {r.id: r for r in c.resources() if r.is_pool}
    return {
        "id": c.id, "name": c.name,
        "systems": [{"id": s.id, "name": s.name} for s in c.systems],
        "departments": [{"id": d.id, "name": d.name,
                         "resources": [resource_to_dict(r, pools.get(r.pool_id)) for r in d.resources]}
                        for d in c.departments],
        "workflows": [{"id": w.id, "name": w.name,
                       "arrival": {"rate_per_hour": w.arrival.rate_per_hour, "window": schedule_to_dict(w.arrival.window)},
                       "steps": [_step_to_dict(s) for s in w.steps]} for w in c.workflows],
        "outages": [list(o) for o in c.outages],
    }


def load_company(path: str | os.PathLike) -> Company:
    with open(path, encoding="utf-8") as f:
        return company_from_dict(json.load(f))


OVERLAY_TYPES: dict[str, type] = {"arrival_multiplier": ArrivalMultiplier, "system_outage": SystemOutage,
                                  "add_employee": AddEmployee, "remove_resource": RemoveResource,
                                  "set_pool_headcount": SetPoolHeadcount, "absence": Absence}
_OVERLAY_NAMES = {v: k for k, v in OVERLAY_TYPES.items()}


def _overlay_from_dict(d: dict, path: str):
    kind = _get(d, "type", path, str)
    cls = OVERLAY_TYPES.get(kind)
    if cls is None:
        raise SchemaError(_join(path, "type"), f"unknown type {kind!r}")
    kw = {}
    for f in dataclasses.fields(cls):
        if f.name == "employee":
            continue
        typ = str if isinstance(f.type, types.UnionType) else f.type
        kw[f.name] = _get(d, f.name, path, typ, _REQUIRED if f.default is dataclasses.MISSING else f.default)
    if cls is AddEmployee:
        kw["employee"] = resource_from_dict(_get(d, "employee", path, dict), kw["department_id"], _join(path, "employee"))
    _done(d, path)
    return cls(**kw)


def scenario_from_dict(d: dict, base: Company) -> Scenario:
    d = _obj(d, "")
    s = Scenario(_get(d, "id", "", str), _get(d, "name", "", str), base, _items(d, "overlays", "", _overlay_from_dict))
    _done(d, "")
    return s


def scenario_to_dict(s: Scenario) -> dict:
    overlays = []
    for o in s.overlays:
        item = {"type": _OVERLAY_NAMES[type(o)]}
        for f in dataclasses.fields(o):
            v = getattr(o, f.name)
            item[f.name] = resource_to_dict(v) if f.name == "employee" else v
        overlays.append(item)
    return {"id": s.id, "name": s.name, "overlays": overlays}


def run_config_from_dict(d: dict) -> RunConfig:
    d = _obj(d, "")
    seed, days = _get(d, "seed", "", int), _get(d, "days", "", float)
    reps, policy = _get(d, "replications", "", int, 1), _get(d, "policy", "", str, "priority")
    _done(d, "")
    if policy not in POLICIES:
        raise SchemaError("policy", f"unknown policy {policy!r}")
    return RunConfig(seed, days * 1440, reps, policy)


def metrics_to_dict(m: Metrics) -> dict:
    out = dataclasses.asdict(m)
    for r in out["ledger"]:
        r["reason"] = None if r["reason"] is None else str(r["reason"])
    return out
