import pytest

from flock_of_pain import store


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))


def bundle(cid="acme", name="Acme"):
    return {"company": {"id": cid, "name": name, "departments": []}, "scenarios": [{"id": "base", "name": "b", "overlays": []}]}


def test_company_roundtrip_upsert_delete():
    assert store.list_companies() == []
    meta = store.save_company(bundle())
    assert meta["id"] == "acme" and meta["name"] == "Acme" and meta["updated_at"]
    assert store.get_company("acme") == bundle()
    store.save_company(bundle(name="Acme 2"))
    assert [c["name"] for c in store.list_companies()] == ["Acme 2"]
    assert store.delete_company("acme") is True
    assert store.delete_company("acme") is False
    assert store.get_company("acme") is None


def test_runs_listed_newest_first_and_filtered():
    a = store.save_run("acme", "first", {"config": {}}, {"kpi_keys": []})
    b = store.save_run(None, "second", {}, {})
    assert b == a + 1
    assert [r["id"] for r in store.list_runs()] == [b, a]
    assert [r["id"] for r in store.list_runs(company_id="acme")] == [a]
    assert store.list_runs(limit=1)[0]["id"] == b
    run = store.get_run(a)
    assert run["name"] == "first" and run["request"] == {"config": {}} and run["result"] == {"kpi_keys": []}
    assert store.get_run(999) is None
