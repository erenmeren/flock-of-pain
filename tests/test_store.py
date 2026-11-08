import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

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
    assert store.get_company("t1", "acme") == {**bundle(), "updated_at": meta["updated_at"]}
    assert store.get_company("t2", "acme") is None  # other tenant, same id
    store.save_company("t2", bundle(name="Acme of t2"))
    store.save_company("t1", bundle(name="Acme 2"))
    assert [c["name"] for c in store.list_companies("t1")] == ["Acme 2"]
    assert [c["name"] for c in store.list_companies("t2")] == ["Acme of t2"]
    assert store.delete_company("t2", "acme") is True
    assert store.get_company("t1", "acme") is not None
    assert store.delete_company("t1", "acme") is True
    assert store.delete_company("t1", "acme") is False


def test_updated_at_has_microseconds_and_sorts_after_old_second_rows():
    with closing(store._connect()) as con, con:
        con.execute("INSERT INTO companies VALUES ('t1', 'old', 'Old', '{}', '2999-01-01T00:00:00+00:00')")
        con.execute("INSERT INTO companies VALUES ('t1', 'older', 'Older', '{}', '2000-01-01T00:00:00+00:00')")
    a = store.save_company("t1", bundle("a"))["updated_at"]
    b = store.save_company("t1", bundle("b"))["updated_at"]
    assert re.fullmatch(r"\S+T\d\d:\d\d:\d\d\.\d{6}\+00:00", a) and a < b
    assert [c["id"] for c in store.list_companies("t1")] == ["old", "b", "a", "older"]
    assert "2000-01-01T00:00:00+00:00" < a  # an old row with whole seconds still compares by time


def test_base_updated_at_conflict_changes_nothing():
    at = store.save_company("t1", bundle())["updated_at"]
    with pytest.raises(store.ConflictError) as e:
        store.save_company("t1", bundle(name="stale"), base_updated_at="2020-01-01T00:00:00+00:00")
    assert e.value.updated_at == at and store.get_company("t1", "acme")["company"]["name"] == "Acme"
    again = store.save_company("t1", bundle(name="fresh"), base_updated_at=at)["updated_at"]
    assert again != at and store.get_company("t1", "acme")["company"]["name"] == "fresh"
    assert store.save_company("t1", bundle("new"), base_updated_at="anything")["id"] == "new"  # nothing stored to conflict with


def test_parallel_writers_with_the_same_base_one_wins():
    at = store.save_company("t1", bundle())["updated_at"]

    def write(i):
        try:
            store.save_company("t1", bundle(name=f"w{i}"), base_updated_at=at)
            return True
        except store.ConflictError:
            return False
    with ThreadPoolExecutor(8) as pool:
        assert list(pool.map(write, range(8))).count(True) == 1


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
    assert store.get_company("default", "acme") == {"company": {"id": "acme"}, "updated_at": "2026-01-01T00:00:00+00:00"}
    assert [r["name"] for r in store.list_runs("default")] == ["r"]
    assert [t["id"] for t in store.list_tenants()] == ["default"]
    assert store.tenant_for_key("unset") is None  # no key until rotated
    assert store.new_key("default").startswith("fop_")
    store.save_company("default", bundle())  # schema works after migration


def test_failed_migration_keeps_old_tables_and_retries(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, bundle TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, name TEXT NOT NULL,
            request TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO companies VALUES ('acme', 'Acme', '{}', '2026-01-01T00:00:00+00:00');
        CREATE TABLE runs_v1 (x);  -- makes the second ALTER fail midway
    """)
    con.commit(); con.close()
    monkeypatch.setenv("FLOCK_DB", str(path))
    with pytest.raises(sqlite3.OperationalError):
        store.list_tenants()
    con = sqlite3.connect(path)
    names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert names == {"companies", "runs", "runs_v1", "sqlite_sequence"}  # rolled back, nothing renamed
    assert con.execute("SELECT count(*) FROM companies").fetchone()[0] == 1
    con.execute("DROP TABLE runs_v1"); con.commit(); con.close()
    assert store.get_company("default", "acme") == {"updated_at": "2026-01-01T00:00:00+00:00"}  # the next open migrates


def test_concurrent_opens_migrate_once(tmp_path, monkeypatch):
    import threading
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, bundle TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, name TEXT NOT NULL,
            request TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO companies VALUES ('acme', 'Acme', '{}', '2026-01-01T00:00:00+00:00');
    """)
    con.commit(); con.close()
    monkeypatch.setenv("FLOCK_DB", str(path))
    errors, start = [], threading.Barrier(8)

    def go():
        try:
            start.wait()
            store.list_companies("default")
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert errors == []
    assert [c["id"] for c in store.list_companies("default")] == ["acme"]


def test_generate_quota_zero_and_global():
    assert store.take_generate("t1", 0, 10) is False  # 0 means off, not one call
    assert store.take_generate("t1", 5, 0) is False
    assert [store.take_generate(t, 5, 2) for t in ("t1", "t2", "t3")] == [True, True, False]
    assert store.take_generate("t1", 1, 10) is False  # t1 used one; the failed t3 call spent nothing
    assert store.take_generate("t3", 1, 3) is True  # t3's rolled-back call did not count against t3


def test_company_cap_new_ids_only(monkeypatch):
    monkeypatch.setattr(store, "MAX_COMPANIES", 1)
    store.save_company("t1", bundle())
    store.save_company("t1", bundle(name="renamed"))  # update allowed
    with pytest.raises(store.LimitError):
        store.save_company("t1", bundle(cid="b"))
    store.save_company("t2", bundle(cid="b"))  # per tenant


def test_runs_pruned_beyond_cap(monkeypatch):
    monkeypatch.setattr(store, "MAX_SAVED_RUNS", 2)
    ids = [store.save_run("t1", None, str(i), {}, {}) for i in range(3)]
    other = store.save_run("t2", None, "x", {}, {})
    assert [r["id"] for r in store.list_runs("t1")] == ids[:0:-1]
    assert [r["id"] for r in store.list_runs("t2")] == [other]


def test_delete_company_deletes_its_runs_and_delete_run():
    store.save_company("t1", bundle())
    a = store.save_run("t1", "acme", "a", {}, {})
    b = store.save_run("t1", None, "b", {}, {})
    c = store.save_run("t2", "acme", "c", {}, {})
    assert store.delete_company("t1", "acme") is True
    assert [r["id"] for r in store.list_runs("t1")] == [b] and store.get_run("t2", c) is not None
    assert store.get_run("t1", a) is None
    assert store.delete_run("t2", b) is False and store.delete_run("t1", b) is True and store.delete_run("t1", b) is False


def test_backup(tmp_path):
    store.create_tenant("t1", "T")
    dest = tmp_path / "copy.db"
    store.backup(str(dest))
    con = sqlite3.connect(dest)
    assert con.execute("SELECT id FROM tenants").fetchall() == [("t1",)]
    con.close()
