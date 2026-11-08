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
    assert main(["tenant", "create", "acme"]) == 1 and "exists" in capsys.readouterr().err
    assert main(["tenant", "create", "bad id"]) == 1 and "tenant id" in capsys.readouterr().err
    assert main(["tenant", "create", "x" * 65]) == 1 and "tenant id" in capsys.readouterr().err
    assert main(["tenant", "list"]) == 0 and capsys.readouterr().out.startswith("acme | Acme Inc | ")


def test_user_commands(tmp_path, capsys, monkeypatch):
    from flock_of_pain import store
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    monkeypatch.setattr(store, "SCRYPT_N", 16)
    secret = "correct horse battery"
    assert main(["tenant", "create", "acme"]) == 0
    capsys.readouterr()
    monkeypatch.setenv("FLOCK_USER_PASSWORD", secret)
    assert main(["user", "create", "acme", "Boss@X.io", "--role", "admin"]) == 0
    assert store.login("boss@x.io", secret)["role"] == "admin"
    monkeypatch.delenv("FLOCK_USER_PASSWORD")
    monkeypatch.setattr("getpass.getpass", lambda *a, **kw: secret + " 2")
    assert main(["user", "create", "acme", "v@x.io"]) == 0
    assert store.login("v@x.io", secret + " 2")["role"] == "viewer"
    out = capsys.readouterr()
    assert secret not in out.out + out.err
    assert main(["user", "list", "acme"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert [ln.split(" | ")[:2] for ln in lines] == [["boss@x.io", "admin"], ["v@x.io", "viewer"]]
    assert main(["user", "create", "acme", "v@x.io"]) == 1 and "exists" in capsys.readouterr().err
    assert main(["user", "create", "ghost", "n@x.io"]) == 1 and "no tenant" in capsys.readouterr().err
    assert main(["user", "list", "ghost"]) == 1 and "no tenant" in capsys.readouterr().err
    assert main(["user", "create", "acme", "nope"]) == 1 and "email" in capsys.readouterr().err
    monkeypatch.setattr("getpass.getpass", lambda *a, **kw: "short")
    assert main(["user", "create", "acme", "n@x.io"]) == 1 and "password" in capsys.readouterr().err


def test_backup_command(tmp_path, monkeypatch):
    import sqlite3
    from flock_of_pain import store
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    store.create_tenant("acme", "Acme")
    assert main(["backup", str(tmp_path / "b.db")]) == 0
    assert sqlite3.connect(tmp_path / "b.db").execute("SELECT id FROM tenants").fetchall() == [("acme",)]


def test_calibrate_commands(tmp_path, capsys):
    p = tmp_path / "a.csv"
    p.write_text("id,created\n1,2026-10-05T09:10:00\n2,2026-10-05T09:40:00\n3,2026-10-06T10:05:00\n")
    assert main(["calibrate", "arrivals", str(p), "--column", "1"]) == 0
    assert json.loads(capsys.readouterr().out)["observed_days"] == 2
    p.write_text("minutes\n10\n20\n30\n")
    assert main(["calibrate", "durations", str(p)]) == 0
    assert json.loads(capsys.readouterr().out)["n"] == 3
    p.write_text("minutes\n10\nx\n")
    assert main(["calibrate", "durations", str(p)]) == 1 and "row 3" in capsys.readouterr().err
