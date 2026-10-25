"""Stateless HTTP API. The only module that imports fastapi/pydantic (extra `api`)."""
import json

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from flock_of_pain import agent, store
from flock_of_pain.examples import reynolds
from flock_of_pain.experiment import ASSUMPTION, KPI_KEYS, off_shift_minutes, run_experiment, top_ledger
from flock_of_pain.io import (SchemaError, company_from_dict, company_to_dict, metrics_to_dict, run_config_from_dict,
                              scenario_from_dict, scenario_to_dict)
from flock_of_pain.model import ModelError

MAX_RUN_DAYS, MAX_EVENT_RUN_DAYS, MAX_RUNS = 2000, 30, 400  # ~330 s and ~38 GB at 365 x 50 x 4 without a cap

app = FastAPI(title="Flock of Pain")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["*"], allow_headers=["*"])


class SimulateRequest(BaseModel):
    company: dict
    scenarios: list[dict]
    config: dict
    include_events: bool = False
    save: bool = False  # store the result (without events) as a run
    company_id: str | None = None  # saved company this run belongs to, if any
    name: str | None = None  # run label; default the company name


class Bundle(BaseModel):
    company: dict
    scenarios: list[dict]


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)


@app.exception_handler(ModelError)
async def _model_error(_: Request, e: ModelError):
    path, message = (e.path, e.message) if isinstance(e, SchemaError) else (None, str(e))
    return JSONResponse({"path": path, "message": message}, status_code=422)


@app.exception_handler(agent.AgentError)
async def _agent_error(_: Request, e: agent.AgentError):
    return JSONResponse({"path": None, "message": str(e)}, status_code=502)


@app.get("/example")
def example():
    base = reynolds.build()
    return {"company": company_to_dict(base), "scenarios": [scenario_to_dict(s) for s in reynolds.scenarios(base)]}


def _section(prefix: str, fn, *args):
    try:
        return fn(*args)
    except SchemaError as e:
        raise SchemaError(f"{prefix}.{e.path}" if e.path else prefix, e.message) from e


def _load(company_d: dict, scenarios_d: list[dict]):
    company = _section("company", company_from_dict, company_d)
    scenarios = [_section(f"scenarios[{i}]", scenario_from_dict, s, company) for i, s in enumerate(scenarios_d)]
    if len({s.id for s in scenarios}) != len(scenarios):
        raise SchemaError("scenarios", "duplicate scenario id")
    for i, s in enumerate(scenarios):
        try:
            s.materialize()
        except ModelError as e:
            raise SchemaError(f"scenarios[{i}]", str(e)) from e
    return company, scenarios


def _not_found():
    return JSONResponse({"path": None, "message": "not found"}, status_code=404)


@app.post("/simulate")
def simulate(req: SimulateRequest):
    company, scenarios = _load(req.company, req.scenarios)
    config = _section("config", run_config_from_dict, req.config)
    budget = config.horizon_minutes / 1440 * config.replications * max(1, len(scenarios))  # run-days
    limit = MAX_EVENT_RUN_DAYS if req.include_events else MAX_RUN_DAYS
    if config.replications * max(1, len(scenarios)) > MAX_RUNS:  # per-run setup cost is not covered by run-days
        raise SchemaError("config", f"replications x scenarios exceeds the limit of {MAX_RUNS} runs")
    if budget > limit:
        raise SchemaError("config", f"days x replications x scenarios = {budget:g} run-days exceeds the limit of "
                                    f"{limit}{' with include_events' if req.include_events else ''}")
    results = [(s, run_experiment(s.name, s, config, keep_events=req.include_events)) for s in scenarios]
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
            "summary": {k: {"mean": v.mean, "p10": v.p10, "p50": v.p50, "p90": v.p90} for k, v in r.summary.items()},
            "ledger": [{"department_id": x.department_id, "reason": None if x.reason is None else str(x.reason),
                        "blocker_id": x.blocker_id, "minutes": x.minutes, "count": x.count} for x in top_ledger(r)],
            "off_shift_minutes": off_shift_minutes(r),
            "runs": [run_out(run) for run in r.runs],
        } for s, r in results],
    }
    if req.save:
        stored = {**out, "scenarios": [{**s, "runs": [{"seed": r["seed"], "metrics": r["metrics"]} for r in s["runs"]]}
                                       for s in out["scenarios"]]}
        request = {"company": company_to_dict(company), "scenarios": [scenario_to_dict(s) for s in scenarios],
                   "config": req.config}
        out["run_id"] = store.save_run(req.company_id, req.name or company.name, request, stored)
    return out


@app.get("/companies")
def companies():
    return store.list_companies()


@app.put("/companies/{cid}")
def put_company(cid: str, body: Bundle):
    company, scenarios = _load(body.company, body.scenarios)
    if company.id != cid:
        raise SchemaError("company.id", f"must equal the URL id {cid!r}")
    return store.save_company({"company": company_to_dict(company), "scenarios": [scenario_to_dict(s) for s in scenarios]})


@app.get("/companies/{cid}")
def get_company(cid: str):
    return store.get_company(cid) or _not_found()


@app.delete("/companies/{cid}")
def delete_company(cid: str):
    return {"deleted": cid} if store.delete_company(cid) else _not_found()


@app.get("/runs")
def runs(company_id: str | None = None, limit: int = 50):
    return store.list_runs(company_id, max(1, min(limit, 500)))


@app.get("/runs/{rid}")
def get_run(rid: int):
    return store.get_run(rid) or _not_found()


@app.post("/generate")
def generate(req: GenerateRequest):
    return agent.generate(req.prompt)
