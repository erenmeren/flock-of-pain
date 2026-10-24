"""Stateless HTTP API. The only module that imports fastapi/pydantic (extra `api`)."""
import json

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flock_of_pain import agent
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


class GenerateRequest(BaseModel):
    prompt: str


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


@app.post("/simulate")
def simulate(req: SimulateRequest):
    company = _section("company", company_from_dict, req.company)
    scenarios = [_section(f"scenarios[{i}]", scenario_from_dict, s, company) for i, s in enumerate(req.scenarios)]
    if len({s.id for s in scenarios}) != len(scenarios):
        raise SchemaError("scenarios", "duplicate scenario id")
    for i, s in enumerate(scenarios):
        try:
            s.materialize()
        except ModelError as e:
            raise SchemaError(f"scenarios[{i}]", str(e)) from e
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

    return {
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


@app.post("/generate")
def generate(req: GenerateRequest):
    return agent.generate(req.prompt)
