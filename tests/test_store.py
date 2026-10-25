import sqlite3

import pytest

from flock_of_pain import store


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))


def bundle(cid="acme", name="Acme"):
    return {"company": {"id": cid, "name": name, "departments": []}, "scenarios": [{"id": "base", "name": "b", "overlays": []}]}


def test_tenant_keys():
    key = store.create_tenant("t1", "Tenant 1")
    assert key.startswith("fop_") and store.tenant_for_key(key) == "t1"
    assert store.tenant_for_key("fop_nope") is None
    key2 = store.new_key("t1")
    assert key2 != key and store.tenant_for_key(key) is None and store.tenant_for_key(key2) == "t1"
    assert store.new_key("ghost") is None
    assert [t["id"] for t in store.list_tenants()] == ["t1"]
    with pytest.raises(sqlite3.IntegrityError):
        store.create_tenant("t1", "again")


def test_company_roundtrip_upsert_delete_per_tenant():
    assert store.list_companies("t1") == []
    meta = store.save_company("t1", bundle())
    assert meta["id"] == "acme" and meta["name"] == "Acme" and meta["updated_at"]
    assert store.get_company("t1", "acme") == bundle()
    assert store.get_company("t2", "acme") is None  # other tenant, same id
    store.save_company("t2", bundle(name="Acme of t2"))
    store.save_company("t1", bundle(name="Acme 2"))
    assert [c["name"] for c in store.list_companies("t1")] == ["Acme 2"]
    assert [c["name"] for c in store.list_companies("t2")] == ["Acme of t2"]
    assert store.delete_company("t2", "acme") is False or store.get_company("t1", "acme") is not None
    assert store.delete_company("t1", "acme") is True
    assert store.delete_company("t1", "acme") is False


def test_runs_scoped_newest_first_and_filtered():
    a = store.save_run("t1", "acme", "first", {"config": {}}, {"kpi_keys": []})
    b = store.save_run("t1", None, "second", {}, {})
    c = store.save_run("t2", None, "other tenant", {}, {})
    assert b == a + 1
    assert [r["id"] for r in store.list_runs("t1")] == [b, a]
    assert [r["id"] for r in store.list_runs("t1", company_id="acme")] == [a]
    assert store.list_runs("t1", limit=1)[0]["id"] == b
    assert [r["id"] for r in store.list_runs("t2")] == [c]
    run = store.get_run("t1", a)
    assert run["name"] == "first" and run["request"] == {"config": {}} and run["result"] == {"kpi_keys": []} and "tenant_id" not in run
    assert store.get_run("t2", a) is None
    assert store.get_run("t1", 999) is None


def test_migrates_pre_tenant_database(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, bundle TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, name TEXT NOT NULL,
            request TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO companies VALUES ('acme', 'Acme', '{"company": {"id": "acme"}}', '2026-01-01T00:00:00+00:00');
        INSERT INTO runs (company_id, name, request, result, created_at) VALUES ('acme', 'r', '{}', '{}', '2026-01-01T00:00:00+00:00');
    """)
    con.commit(); con.close()
    monkeypatch.setenv("FLOCK_DB", str(path))
    assert store.get_company("default", "acme") == {"company": {"id": "acme"}}
    assert [r["name"] for r in store.list_runs("default")] == ["r"]
    assert [t["id"] for t in store.list_tenants()] == ["default"]
    assert store.tenant_for_key("unset") is None  # no key until rotated
    assert store.new_key("default").startswith("fop_")
    store.save_company("default", bundle())  # schema works after migration
