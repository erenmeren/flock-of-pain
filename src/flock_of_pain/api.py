"""Stateless HTTP API. The only module that imports fastapi/pydantic (extra `api`)."""
import json
import os
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from fastapi import Depends, FastAPI, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from flock_of_pain import agent, calibrate, jobs, optimize, store
from flock_of_pain.agent import load_bundle, section
from flock_of_pain.examples import reynolds
from flock_of_pain.experiment import ASSUMPTION, KPI_KEYS, compare_to_base, off_shift_minutes, run_experiment, top_ledger
from flock_of_pain.io import (SchemaError, company_to_dict, metrics_to_dict, run_config_from_dict, run_config_to_dict,
                              scenario_to_dict)
from flock_of_pain.model import ModelError
from flock_of_pain.recommend import recommend

MAX_EVENT_RUN_DAYS, MAX_RUNS = 30, 400  # ~38 GB of events at 365 x 50 x 4 without a cap
MAX_RUN_DAYS = int(os.environ.get("FLOCK_MAX_RUN_DAYS", "2000"))  # days x replications x scenarios per /simulate; ~5 s on 8 cores
TENANT_ID = store.TENANT_ID
MAX_BODY_BYTES = 2 * 1024 * 1024
# parsed at import, so a typo fails at startup instead of a 500 per request
GENERATE_DAILY_LIMIT = int(os.environ.get("FLOCK_GENERATE_DAILY_LIMIT", "20"))  # per tenant
GENERATE_GLOBAL_DAILY_LIMIT = int(os.environ.get("FLOCK_GENERATE_GLOBAL_DAILY_LIMIT", "200"))  # all tenants together
MAX_CALIBRATE = 100000  # entries per /calibrate list
MAX_TENANTS = int(os.environ.get("FLOCK_MAX_TENANTS", "100"))  # /signup refuses past this

app = FastAPI(title="Flock of Pain")


@app.middleware("http")  # registered before CORS, so CORS wraps it and a 413 still carries CORS headers
async def _limit_body(request: Request, call_next):
    size = request.headers.get("content-length", "")
    if size.isdigit() and int(size) > MAX_BODY_BYTES:
        return JSONResponse({"path": None, "message": f"request body over {MAX_BODY_BYTES} bytes"}, status_code=413)
    return await call_next(request)


app.add_middleware(CORSMiddleware, allow_methods=["*"], allow_headers=["*"],
                   allow_origins=[o.strip() for o in os.environ.get("FLOCK_CORS_ORIGINS",
                                                                    "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()])

_api_key = APIKeyHeader(name="X-API-Key", auto_error=False)
_bearer = HTTPBearer(auto_error=False)


class AuthError(Exception):
    pass


class ForbiddenError(Exception):
    pass


class QuotaError(Exception):
    pass


@dataclass(frozen=True)
class Principal:
    tenant: str
    role: str
    email: str | None = None  # None for an API key


def current_principal(key: str | None = Security(_api_key), bearer: HTTPAuthorizationCredentials | None = Security(_bearer)) -> Principal:
    """Every endpoint except /example, /signup and /auth/login runs as a tenant, through a key from `flock_of_pain tenant
    create` (acts as admin) or a session token from /auth/login. A valid key wins when both are sent."""
    tenant = store.tenant_for_key(key) if key else None
    if tenant is not None:
        return Principal(tenant, "admin")
    user = store.session_user(bearer.credentials) if bearer else None
    if user is None:
        raise AuthError("missing or unknown X-API-Key or bearer token")
    return Principal(user["tenant_id"], user["role"], user["email"])


Caller = Depends(current_principal)


def current_tenant(caller: Principal = Caller) -> str:
    return caller.tenant


def require_write(caller: Principal) -> None:
    if caller.role == "viewer":
        raise ForbiddenError("a viewer cannot change anything")


def writer_tenant(caller: Principal = Caller) -> str:
    require_write(caller)
    return caller.tenant


def admin_tenant(caller: Principal = Caller) -> str:
    if caller.role != "admin":
        raise ForbiddenError("only an admin can do this")
    return caller.tenant


Tenant, Writer, Admin = Depends(current_tenant), Depends(writer_tenant), Depends(admin_tenant)  # each gives the tenant id


class SimulateRequest(BaseModel):
    company: dict
    scenarios: list[dict]
    config: dict
    include_events: bool = False
    save: bool = False  # store the result (without events) as a run
    company_id: str | None = None  # saved company this run belongs to, if any
    name: str | None = None  # run label; default the company name


class OptimizeRequest(BaseModel):
    company: dict
    scenarios: list[dict]
    config: dict
    target: dict  # {kpi, op, value}
    base_scenario_id: str | None = None  # default the first scenario
    candidates: list[str] | None = None  # department ids; default all that have a resource
    max_hires: int = 10


class Bundle(BaseModel):
    company: dict
    scenarios: list[dict]


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)


class ArrivalsRequest(BaseModel):
    timestamps: list[str]


class DurationsRequest(BaseModel):
    minutes: list[float]


class SignupRequest(BaseModel):
    id: str = Field(pattern=rf"^{TENANT_ID}$", max_length=store.TENANT_ID_MAX)
    name: str | None = Field(default=None, max_length=200)
    invite: str = Field(max_length=200)
    email: str | None = None  # with password: also creates this admin user
    password: str | None = None


class LoginRequest(BaseModel):
    email: str = Field(max_length=store.MAX_EMAIL)
    password: str


Role = Literal["admin", "editor", "viewer"]


class NewUser(BaseModel):
    email: str
    password: str
    role: Role


class UserPatch(BaseModel):
    role: Role | None = None
    password: str | None = None


@app.exception_handler(ModelError)
async def _model_error(_: Request, e: ModelError):
    path, message = (e.path, e.message) if isinstance(e, SchemaError) else (None, str(e))
    return JSONResponse({"path": path, "message": message}, status_code=422)


@app.exception_handler(AuthError)
async def _auth_error(_: Request, e: AuthError):
    return JSONResponse({"path": None, "message": str(e)}, status_code=401, headers={"WWW-Authenticate": "ApiKey"})


@app.exception_handler(ForbiddenError)
async def _forbidden_error(_: Request, e: ForbiddenError):
    return JSONResponse({"path": None, "message": str(e)}, status_code=403)


@app.exception_handler(store.CredentialError)
async def _credential_error(_: Request, e: store.CredentialError):
    return JSONResponse({"path": e.path, "message": str(e)}, status_code=422)


@app.exception_handler(UnicodeEncodeError)  # JSON can carry a lone surrogate, which neither scrypt nor SQLite can encode
async def _unicode_error(_: Request, e: UnicodeEncodeError):
    return JSONResponse({"path": None, "message": "text is not valid Unicode"}, status_code=422)


@app.exception_handler(QuotaError)
async def _quota_error(_: Request, e: QuotaError):
    return JSONResponse({"path": None, "message": str(e)}, status_code=429)


@app.exception_handler(store.LimitError)
async def _limit_error(_: Request, e: store.LimitError):
    return JSONResponse({"path": None, "message": str(e)}, status_code=409)


@app.exception_handler(agent.AgentError)
async def _agent_error(_: Request, e: agent.AgentError):
    return JSONResponse({"path": None, "message": str(e)}, status_code=502)


@app.get("/example")
def example():
    base = reynolds.build()
    return {"company": company_to_dict(base), "scenarios": [scenario_to_dict(s) for s in reynolds.scenarios(base)]}


def _not_found():
    return JSONResponse({"path": None, "message": "not found"}, status_code=404)


def _prepare_simulation(req: SimulateRequest, caller: Principal) -> tuple:
    """Everything a /simulate body can be refused for, before anything runs."""
    if req.save:
        require_write(caller)
    company, scenarios = load_bundle(req.company, req.scenarios)
    config = section("config", run_config_from_dict, req.config)
    budget = config.horizon_minutes / 1440 * config.replications * max(1, len(scenarios))  # run-days
    limit = MAX_EVENT_RUN_DAYS if req.include_events else MAX_RUN_DAYS
    if config.replications * max(1, len(scenarios)) > MAX_RUNS:  # per-run setup cost is not covered by run-days
        raise SchemaError("config", f"replications x scenarios exceeds the limit of {MAX_RUNS} runs")
    if budget > limit:
        raise SchemaError("config", f"days x replications x scenarios = {budget:g} run-days exceeds the limit of "
                                    f"{limit}{' with include_events' if req.include_events else ''}")
    return company, scenarios, config


def _run_simulation(req: SimulateRequest, tenant: str, company, scenarios, config, progress=None) -> dict:
    """The /simulate response. progress() is called per replication and may raise to stop; progress(0) only checks."""
    results = [(s, run_experiment(s.name, s, config, keep_events=req.include_events, on_run=progress)) for s in scenarios]
    utils = sorted({k for _, r in results for k in r.summary if k.startswith("util_")})

    def run_out(run):
        out = {"seed": run.seed, "metrics": metrics_to_dict(run.metrics)}
        if req.include_events:
            out["events"] = [json.loads(e.to_json()) for e in run.events]
        return out

    out = {
        "disclaimer": ASSUMPTION, "kpi_keys": [*KPI_KEYS, *utils],
        "scenarios": [{
            "id": s.id, "name": s.name,
            "summary": {k: {"mean": v.mean, "p10": v.p10, "p50": v.p50, "p90": v.p90, "ci_low": v.ci_low, "ci_high": v.ci_high}
                        for k, v in r.summary.items()},
            "ledger": [{"department_id": x.department_id, "reason": None if x.reason is None else str(x.reason),
                        "blocker_id": x.blocker_id, "minutes": x.minutes, "count": x.count} for x in top_ledger(r)],
            "off_shift_minutes": off_shift_minutes(r),
            "recommendations": recommend(r.summary, top_ledger(r, n=None), off_shift_minutes(r), s.materialize()),
            **({"comparison": compare_to_base(results[0][1], r)} if i else {}),
            "runs": [run_out(run) for run in r.runs],
        } for i, (s, r) in enumerate(results)],
    }
    if req.save:
        if progress:
            progress(0)  # a job cancelled by now saves nothing; a cancel landing during the save still keeps the run in history
        stored = {**out, "scenarios": [{**s, "runs": [{"seed": r["seed"], "metrics": r["metrics"]} for r in s["runs"]]}
                                       for s in out["scenarios"]]}
        request = {"company": company_to_dict(company), "scenarios": [scenario_to_dict(s) for s in scenarios],
                   "config": run_config_to_dict(config)}  # resolved, not as sent
        out["run_id"] = store.save_run(tenant, req.company_id, req.name or company.name, request, stored)
    return out


@app.post("/simulate")
def simulate(req: SimulateRequest, caller: Principal = Caller):
    return _run_simulation(req, caller.tenant, *_prepare_simulation(req, caller))


def _start_job(tenant: str, kind: str, total: int, fn) -> JSONResponse:
    job_id = jobs.submit(tenant, kind, total, fn)
    if job_id is None:
        raise QuotaError(f"at most {jobs.MAX_JOBS} active jobs per tenant; wait for one to finish or cancel it")
    return JSONResponse({"id": job_id}, status_code=202)


@app.post("/jobs", status_code=202)
def create_job(req: SimulateRequest, caller: Principal = Caller):
    prepared = _prepare_simulation(req, caller)
    return _start_job(caller.tenant, "simulate", prepared[2].replications * len(prepared[1]),
                      lambda progress: _run_simulation(req, caller.tenant, *prepared, progress))


@app.get("/jobs/{job_id}")
def get_job(job_id: str, tenant: str = Tenant):
    return jobs.get(tenant, job_id) or _not_found()


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str, tenant: str = Tenant):
    return jobs.cancel(tenant, job_id) or _not_found()


@app.post("/optimize", status_code=202)
def optimize_staffing(req: OptimizeRequest, tenant: str = Tenant):
    company, scenarios = load_bundle(req.company, req.scenarios)
    config = section("config", run_config_from_dict, req.config)
    plan = optimize.plan(company, scenarios, config, req.target, req.candidates, req.max_hires, req.base_scenario_id,
                         MAX_RUN_DAYS, MAX_RUNS)
    return _start_job(tenant, "optimize", plan.total, lambda progress: optimize.run(plan, progress))


@app.get("/companies")
def companies(tenant: str = Tenant):
    return store.list_companies(tenant)


@app.put("/companies/{cid}")
def put_company(cid: str, body: Bundle, tenant: str = Writer):
    company, scenarios = load_bundle(body.company, body.scenarios, draft=True)
    if company.id != cid:
        raise SchemaError("company.id", f"must equal the URL id {cid!r}")
    if not re.fullmatch(TENANT_ID, cid):
        raise SchemaError("company.id", "use letters, digits, '_', '.' or '-' (it is the URL id)")
    return store.save_company(tenant, {"company": company_to_dict(company), "scenarios": [scenario_to_dict(s) for s in scenarios]})


@app.get("/companies/{cid}")
def get_company(cid: str, tenant: str = Tenant):
    return store.get_company(tenant, cid) or _not_found()


@app.delete("/companies/{cid}")
def delete_company(cid: str, tenant: str = Writer):
    return {"deleted": cid} if store.delete_company(tenant, cid) else _not_found()


@app.get("/runs")
def runs(company_id: str | None = None, limit: int = 50, tenant: str = Tenant):
    return store.list_runs(tenant, company_id, max(1, min(limit, 500)))


@app.get("/runs/{rid}")
def get_run(rid: int, tenant: str = Tenant):
    return store.get_run(tenant, rid) or _not_found()


@app.delete("/runs/{rid}")
def delete_run(rid: int, tenant: str = Writer):
    return {"deleted": rid} if store.delete_run(tenant, rid) else _not_found()


@app.post("/generate")
def generate(req: GenerateRequest, tenant: str = Writer):
    if not store.take_generate(tenant, GENERATE_DAILY_LIMIT, GENERATE_GLOBAL_DAILY_LIMIT):  # counted before the call: a failed call still spends one
        raise QuotaError(f"daily /generate limit of {GENERATE_DAILY_LIMIT} per tenant or {GENERATE_GLOBAL_DAILY_LIMIT} "
                         "for all tenants reached; try again tomorrow (UTC)")
    return agent.generate(req.prompt)


def _fit(key: str, xs: list, fit):
    if len(xs) > MAX_CALIBRATE:
        raise SchemaError(key, f"more than {MAX_CALIBRATE} entries")
    try:
        return fit(xs)
    except ValueError as e:
        raise SchemaError(key, str(e)) from None


@app.post("/calibrate/arrivals")
def calibrate_arrivals(req: ArrivalsRequest, tenant: str = Tenant):
    ts = []
    for i, s in enumerate(req.timestamps[:MAX_CALIBRATE + 1]):
        try:
            ts.append(datetime.fromisoformat(s).replace(tzinfo=None))  # the wall clock as written counts
        except ValueError:
            raise SchemaError(f"timestamps[{i}]", "expected an ISO 8601 date-time") from None
    return _fit("timestamps", ts, calibrate.fit_arrivals)


@app.post("/calibrate/durations")
def calibrate_durations(req: DurationsRequest, tenant: str = Tenant):
    return _fit("minutes", req.minutes, calibrate.fit_duration)


@app.post("/signup")
def signup(req: SignupRequest):
    """Self-serve tenant creation behind the FLOCK_SIGNUP_CODE invite; the key is returned once."""
    code = os.environ.get("FLOCK_SIGNUP_CODE")
    if not code:
        return _not_found()
    if not secrets.compare_digest(req.invite.encode(), code.encode()):  # str form raises TypeError on non-ASCII
        raise AuthError("wrong invite code")
    if (req.email is None) != (req.password is None):
        raise store.CredentialError("password" if req.password is None else "email", "email and password go together")
    if len(store.list_tenants()) >= MAX_TENANTS:
        return JSONResponse({"path": None, "message": f"tenant limit of {MAX_TENANTS} reached; signup is closed"}, status_code=403)
    try:
        key = store.create_tenant(req.id, req.name or req.id, req.email, req.password)
    except sqlite3.IntegrityError as e:
        if "users.email" in str(e):
            return _email_taken()
        return JSONResponse({"path": "id", "message": f"tenant {req.id!r} exists"}, status_code=409)
    return {"id": req.id, "key": key}


def _email_taken():
    return JSONResponse({"path": "email", "message": "this email is already registered"}, status_code=409)


@app.post("/auth/login")
def login(req: LoginRequest):
    if len(req.password) > store.MAX_PASSWORD:
        raise store.CredentialError("password", f"over {store.MAX_PASSWORD} characters")
    email = req.email.lower()
    if not store.take_login_attempt(email):
        raise QuotaError(f"too many failed logins; try again within {store.LOGIN_WINDOW_MINUTES} minutes")
    session = store.login(email, req.password)
    if session is None:
        raise AuthError("wrong email or password")
    return session


@app.post("/auth/logout")
def logout(caller: Principal = Caller, bearer: HTTPAuthorizationCredentials | None = Security(_bearer)):
    if bearer:
        store.delete_session(bearer.credentials)
    return {"ok": True}


@app.get("/auth/me")
def me(caller: Principal = Caller):
    return {"tenant": caller.tenant, "email": caller.email, "role": caller.role}


@app.get("/users")
def users(tenant: str = Admin):
    return store.list_users(tenant)


@app.post("/users")
def create_user(req: NewUser, tenant: str = Admin):
    try:
        return store.create_user(tenant, req.email, req.password, req.role)
    except sqlite3.IntegrityError:
        return _email_taken()


@app.patch("/users/{email}")
def update_user(email: str, req: UserPatch, tenant: str = Admin):
    if req.role is None and req.password is None:
        raise SchemaError("role", "nothing to change: give role or password")
    return store.update_user(tenant, email.lower(), req.role, req.password) or _not_found()


@app.delete("/users/{email}")
def delete_user(email: str, tenant: str = Admin):
    email = email.lower()
    return {"deleted": email} if store.delete_user(tenant, email) else _not_found()
