import json
from flock_of_pain.cli import main
from flock_of_pain.io import company_to_dict, scenario_to_dict
from flock_of_pain.examples import reynolds

def test_export_example_and_company_flag(tmp_path, capsys):
    p = tmp_path / "c.json"
    assert main(["export-example", str(p)]) == 0
    assert json.loads(p.read_text()) == company_to_dict(reynolds.build())
    assert main(["demo", "--company", str(p), "--days", "1", "--reps", "1"]) == 0
    assert "baseline" in capsys.readouterr().out


def test_generate_and_demo_bundle(tmp_path, capsys, monkeypatch):
    from flock_of_pain import agent
    base = reynolds.build()
    bundle = {"company": company_to_dict(base), "scenarios": [scenario_to_dict(s) for s in reynolds.scenarios(base)][:2]}
    monkeypatch.setattr(agent, "_ask", lambda messages: json.dumps(bundle))
    p = tmp_path / "b.json"
    assert main(["generate", "a bakery", "--out", str(p)]) == 0
    assert json.loads(p.read_text()) == bundle
    assert main(["generate", "a bakery"]) == 0
    assert json.loads(capsys.readouterr().out) == bundle
    assert main(["demo", "--company", str(p), "--days", "1", "--reps", "1"]) == 0
    out = capsys.readouterr().out
    assert "baseline" in out and out.count("Top blocked time") == 2
    monkeypatch.setattr(agent, "_ask", lambda messages: "nope")
    assert main(["generate", "a bakery"]) == 1
    assert "error: invalid definition" in capsys.readouterr().err


def test_tenant_commands(tmp_path, capsys, monkeypatch):
    from flock_of_pain import store
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    assert main(["tenant", "create", "acme", "--name", "Acme Inc"]) == 0
    key = capsys.readouterr().out.strip()
    assert key.startswith("fop_") and store.tenant_for_key(key) == "acme"
    assert main(["tenant", "rotate", "acme"]) == 0
    key2 = capsys.readouterr().out.strip()
    assert key2 != key and store.tenant_for_key(key2) == "acme" and store.tenant_for_key(key) is None
    assert main(["tenant", "rotate", "ghost"]) == 1 and "no tenant" in capsys.readouterr().err
    assert main(["tenant", "list"]) == 0 and capsys.readouterr().out.startswith("acme | Acme Inc | ")
