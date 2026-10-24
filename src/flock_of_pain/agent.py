"""Plain-language company description -> company + scenarios JSON via Claude.

Only api.py and this module import an optional dependency (`anthropic`, extra `api`).
The model's output is validated with the same loader the API uses; one repair
round feeds the loader's error back to the model.
"""
import json
import os
from collections.abc import Callable

from flock_of_pain.examples import reynolds
from flock_of_pain.io import SchemaError, company_from_dict, company_to_dict, scenario_from_dict, scenario_to_dict
from flock_of_pain.model import ModelError

MODEL = os.environ.get("FLOCK_MODEL", "claude-opus-5-5")
Ask = Callable[[list[dict]], str]  # messages -> assistant text


class AgentError(Exception):
    """The model produced no valid definition (API failure, refusal, or invalid output after repair)."""


def _example() -> str:
    base = reynolds.build()
    return json.dumps({"company": company_to_dict(base), "scenarios": [scenario_to_dict(s) for s in reynolds.scenarios(base)]})


SYSTEM = f"""You turn a plain-language description of a company into a workforce simulation definition.
Reply with exactly one JSON object and nothing else (no prose, no code fences):
{{"company": <company>, "scenarios": [<scenario>, ...]}}

Format rules (units are the engine's; time zero is Monday 00:00):
- ids are unique snake_case strings. Every department_id, system_id, resource_id, workflow_id and step id you reference must exist.
- resources: a pool has "headcount"; a named employee has "pool_id" (carved out of that pool) or stands alone. Never write "capacity".
- "skills" is a list; a step's "required_skill" must be a skill of a resource in the step's department.
- schedule.weekday_hours keys are "0".."6" (0 = Monday), values [start_hour, end_hour]; an overnight shift ends past 24, e.g. [22, 30]. schedule.absences are [start_minute, end_minute] from time zero; company.outages are [system_id, start_minute, end_minute]; sla_minutes in minutes.
- arrival: {{"rate_per_hour": x, "window": {{"weekday_hours": ...}}}}.
- duration: prefer {{"kind": "lognormal_mean", "mean": minutes, "sigma": 0.4}}; other kinds: const (a), uniform (a, b), triangular (a=low, b=mode, c=high), exponential (a=mean).
- depends_on lists step ids in the same workflow, no cycles; rework_to is null, the step's own id, or one of its depends_on.
- scenario overlays, by "type": arrival_multiplier (factor, workflow_id|null), system_outage (system_id, start, end), add_employee (department_id, employee), remove_resource (resource_id), set_pool_headcount (pool_id, headcount), absence (resource_id, start, end).
- Keep it proportionate to the description: a handful of departments and workflows, 3-4 scenarios that test the question the user is asking. Invent plausible numbers for anything unspecified; the first scenario is the baseline with no overlays.

Worked example:
{_example()}"""


def _ask(messages: list[dict]) -> str:
    import anthropic

    try:
        r = anthropic.Anthropic().messages.create(
            model=MODEL, max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=messages)
    except (anthropic.AnthropicError, TypeError) as e:  # TypeError: SDK 2.x "Could not resolve authentication method"
        raise AgentError(f"{MODEL}: {e}") from e
    if r.stop_reason == "refusal":
        raise AgentError("the model declined the request")
    if r.stop_reason == "max_tokens":
        raise AgentError("the model's output was truncated; describe a smaller company")
    return "".join(b.text for b in r.content if b.type == "text")


def _validate(text: str) -> dict:
    body = text.strip()
    if body.startswith("```"):
        body = body.split("\n", 1)[-1].rsplit("```", 1)[0]
    try:
        d = json.loads(body)
    except ValueError as e:
        raise SchemaError("", f"not JSON: {e}") from e
    if not isinstance(d, dict) or not isinstance(d.get("company"), dict) or not isinstance(d.get("scenarios"), list):
        raise SchemaError("", 'expected {"company": {...}, "scenarios": [...]}')
    try:
        company = company_from_dict(d["company"])
    except SchemaError as e:
        raise SchemaError(f"company.{e.path}", e.message) from e
    # The engine tolerates a step nobody can do (NO_ELIGIBLE_RESOURCE, a legitimate what-if via overlays),
    # but in a generated base company it is a model mistake worth a repair round.
    skills = {dep.id: {sk for r in dep.resources for sk in r.skills} for dep in company.departments}
    for wi, w in enumerate(company.workflows):
        for si, st in enumerate(w.steps):
            if st.required_skill not in skills[st.department_id]:
                raise SchemaError(f"company.workflows[{wi}].steps[{si}].required_skill",
                                  f"no resource in department {st.department_id} has skill {st.required_skill}")
    scenarios = []
    for i, s in enumerate(d["scenarios"]):
        try:
            scenarios.append(scenario_from_dict(s, company))
            scenarios[-1].materialize()
        except SchemaError as e:
            raise SchemaError(f"scenarios[{i}].{e.path}".rstrip("."), e.message) from e
        except ModelError as e:
            raise SchemaError(f"scenarios[{i}]", str(e)) from e
    if len({s.id for s in scenarios}) != len(scenarios):
        raise SchemaError("scenarios", "duplicate scenario id")
    return {"company": company_to_dict(company), "scenarios": [scenario_to_dict(s) for s in scenarios]}


def generate(prompt: str, ask: Ask | None = None, repairs: int = 1) -> dict:
    """Return {"company", "scenarios"} in the API's JSON form, validated. Raises AgentError."""
    ask = ask or _ask
    messages = [{"role": "user", "content": prompt}]
    for attempt in range(repairs + 1):
        text = ask(messages)
        try:
            return _validate(text)
        except ModelError as e:
            err = (f"{e.path}: {e.message}" if e.path else e.message) if isinstance(e, SchemaError) else str(e)
            if attempt == repairs:
                raise AgentError(f"invalid definition after {repairs + 1} attempts: {err}") from e
            messages += [{"role": "assistant", "content": text},
                         {"role": "user", "content": f"Invalid: {err}. Reply with the corrected full JSON object only."}]
    raise AssertionError("unreachable")
