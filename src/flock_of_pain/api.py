"""Stateless HTTP API. The only module that imports fastapi/pydantic (extra `api`)."""
import json

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flock_of_pain.examples import reynolds
from flock_of_pain.experiment import ASSUMPTION, KPI_KEYS, off_shift_minutes, run_experiment, top_ledger
from flock_of_pain.io import (SchemaError, company_from_dict, company_to_dict, metrics_to_dict, run_config_from_dict,
                              scenario_from_dict, scenario_to_dict)
from flock_of_pain.model import ModelError

app = FastAPI(title="Flock of Pain")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000"], allow_methods=["*"], allow_headers=["*"])


class SimulateRequest(BaseModel):
    company: dict
    scenarios: list[dict]
    config: dict
    include_events: bool = False


@app.exception_handler(ModelError)
async def _model_error(_: Request, e: ModelError):
    path, message = (e.path, e.message) if isinstance(e, SchemaError) else (None, str(e))
    return JSONResponse({"path": path, "message": message}, status_code=422)


@app.get("/example")
def example():
    base = reynolds.build()
    return {"company": company_to_dict(base), "scenarios": [scenario_to_dict(s) for s in reynolds.scenarios(base)]}


@app.post("/simulate")
def simulate(req: SimulateRequest):
    company = company_from_dict(req.company)
    scenarios = [scenario_from_dict(s, company) for s in req.scenarios]
    config = run_config_from_dict(req.config)
    results = [(s, run_experiment(s.name, s, config)) for s in scenarios]
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
