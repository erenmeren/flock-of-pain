"""SQLite persistence for company bundles and run results. Stdlib only, one file, no tenants.

A bundle is {"company": {...}, "scenarios": [...]} in the API's JSON form, keyed by company id.
Run results are stored without events. Path from FLOCK_DB (default ./flock.db).
"""
import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, bundle TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT, name TEXT NOT NULL,
    request TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
"""


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(os.environ.get("FLOCK_DB", "flock.db"))
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def save_company(bundle: dict) -> dict:
    cid, name, at = bundle["company"]["id"], bundle["company"]["name"], _now()
    with closing(_connect()) as con, con:
        con.execute("INSERT INTO companies VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "name = excluded.name, bundle = excluded.bundle, updated_at = excluded.updated_at",
                    (cid, name, json.dumps(bundle), at))
    return {"id": cid, "name": name, "updated_at": at}


def list_companies() -> list[dict]:
    with closing(_connect()) as con:
        rows = con.execute("SELECT id, name, updated_at FROM companies ORDER BY updated_at DESC, id").fetchall()
    return [dict(r) for r in rows]


def get_company(cid: str) -> dict | None:
    with closing(_connect()) as con:
        row = con.execute("SELECT bundle FROM companies WHERE id = ?", (cid,)).fetchone()
    return None if row is None else json.loads(row["bundle"])


def delete_company(cid: str) -> bool:
    with closing(_connect()) as con, con:
        return con.execute("DELETE FROM companies WHERE id = ?", (cid,)).rowcount > 0


def save_run(company_id: str | None, name: str, request: dict, result: dict) -> int:
    with closing(_connect()) as con, con:
        cur = con.execute("INSERT INTO runs (company_id, name, request, result, created_at) VALUES (?, ?, ?, ?, ?)",
                          (company_id, name, json.dumps(request), json.dumps(result), _now()))
        return cur.lastrowid


def list_runs(company_id: str | None = None, limit: int = 50) -> list[dict]:
    where, args = ("WHERE company_id = ?", [company_id]) if company_id is not None else ("", [])
    with closing(_connect()) as con:
        rows = con.execute(f"SELECT id, company_id, name, created_at FROM runs {where} ORDER BY id DESC LIMIT ?",
                           [*args, limit]).fetchall()
    return [dict(r) for r in rows]


def get_run(rid: int) -> dict | None:
    with closing(_connect()) as con:
        row = con.execute("SELECT * FROM runs WHERE id = ?", (rid,)).fetchone()
    if row is None:
        return None
    return {**dict(row), "request": json.loads(row["request"]), "result": json.loads(row["result"])}
