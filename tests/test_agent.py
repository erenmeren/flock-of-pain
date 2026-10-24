import json

import pytest

from flock_of_pain import agent
from flock_of_pain.examples import reynolds
from flock_of_pain.io import company_to_dict, scenario_to_dict


def bundle() -> dict:
    base = reynolds.build()
    return {"company": company_to_dict(base), "scenarios": [scenario_to_dict(s) for s in reynolds.scenarios(base)]}


def test_generate_valid_first_try():
    assert agent.generate("x", ask=lambda m: json.dumps(bundle())) == bundle()


def test_generate_strips_fences():
    assert agent.generate("x", ask=lambda m: "```json\n" + json.dumps(bundle()) + "\n```") == bundle()


def test_generate_repairs_once_with_error_path():
    calls = []
    bad = bundle()
    bad["scenarios"][0]["overlays"] = [{"type": "nope"}]

    def ask(m):
        calls.append(list(m))
        return json.dumps(bad if len(calls) == 1 else bundle())

    assert agent.generate("x", ask=ask) == bundle()
    assert len(calls) == 2
    assert calls[1][1]["role"] == "assistant" and calls[1][1]["content"] == json.dumps(bad)
    assert "scenarios[0].overlays[0].type" in calls[1][2]["content"]


def test_generate_gives_up():
    with pytest.raises(agent.AgentError, match="2 attempts: : not JSON"):
        agent.generate("x", ask=lambda m: "nope")


def test_generate_rejects_wrong_shape():
    with pytest.raises(agent.AgentError, match="expected"):
        agent.generate("x", ask=lambda m: json.dumps(bundle()["company"]), repairs=0)


def test_generate_semantic_scenario_error():
    bad = bundle()
    bad["scenarios"][1]["overlays"] = [{"type": "remove_resource", "resource_id": "ghost"}]
    with pytest.raises(agent.AgentError, match=r"scenarios\[1\]: .*ghost"):
        agent.generate("x", ask=lambda m: json.dumps(bad), repairs=0)


def test_system_prompt_carries_example():
    assert '"id": "reynolds"' in agent.SYSTEM and "lognormal_mean" in agent.SYSTEM
