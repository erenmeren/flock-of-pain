"""SQLite persistence: tenants with API keys, company bundles and run results. Stdlib only.

A bundle is {"company": {...}, "scenarios": [...]} in the API's JSON form, keyed by (tenant, company id).
Run results are stored without events. Path from FLOCK_DB (default ./flock.db).
"""
import hashlib
import json
import os
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS companies (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, bundle TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id));
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, company_id TEXT, name TEXT NOT NULL,
    request TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_tenant ON runs (tenant_id, id);
CREATE TABLE IF NOT EXISTS usage (
    tenant_id TEXT NOT NULL, day TEXT NOT NULL, generates INTEGER NOT NULL, PRIMARY KEY (tenant_id, day));
"""


MIGRATION_V1 = [  # pre-tenant databases (one user): rows move to the tenant 'default'; its key is set with new_key()
    "ALTER TABLE companies RENAME TO companies_v1",
    "ALTER TABLE runs RENAME TO runs_v1",
    *[stmt.strip() for stmt in SCHEMA.split(";") if stmt.strip()],
    "INSERT INTO companies SELECT 'default', id, name, bundle, updated_at FROM companies_v1",
    "INSERT INTO runs (id, tenant_id, company_id, name, request, result, created_at) "
    "SELECT id, 'default', company_id, name, request, result, created_at FROM runs_v1",
    "INSERT OR IGNORE INTO tenants VALUES ('default', 'default', 'unset', strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now'))",
    "DROP TABLE companies_v1",
    "DROP TABLE runs_v1",
]


def _needs_v1(con: sqlite3.Connection) -> bool:
    cols = {r["name"] for r in con.execute("PRAGMA table_info(companies)")}
    return bool(cols) and "tenant_id" not in cols


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(os.environ.get("FLOCK_DB", "flock.db"))
    con.row_factory = sqlite3.Row
    if _needs_v1(con):
        _migrate(con)
    con.executescript(SCHEMA)
    return con


def _migrate(con: sqlite3.Connection) -> None:
    """One transaction under a write lock, so a failure keeps the old tables and concurrent openers wait, then skip."""
    con.execute("BEGIN IMMEDIATE")
    try:
        if _needs_v1(con):  # re-check under the lock: another connection may have migrated meanwhile
            for stmt in MIGRATION_V1:
                con.execute(stmt)
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


# --- tenants ---------------------------------------------------------------

def create_tenant(tid: str, name: str) -> str:
    """Create a tenant and return its API key, shown once; only the hash is stored."""
    key = f"fop_{secrets.token_urlsafe(32)}"
    with closing(_connect()) as con, con:
        con.execute("INSERT INTO tenants VALUES (?, ?, ?, ?)", (tid, name, _hash(key), _now()))
    return key


def new_key(tid: str) -> str | None:
    """Replace a tenant's API key (rotation); None if the tenant does not exist."""
    key = f"fop_{secrets.token_urlsafe(32)}"
    with closing(_connect()) as con, con:
        n = con.execute("UPDATE tenants SET key_hash = ? WHERE id = ?", (_hash(key), tid)).rowcount
    return key if n else None


def tenant_for_key(key: str) -> str | None:
    with closing(_connect()) as con:
        row = con.execute("SELECT id FROM tenants WHERE key_hash = ?", (_hash(key),)).fetchone()
    return None if row is None else row["id"]


def take_generate(tenant: str, limit: int) -> bool:
    """Count one /generate call against today's (UTC) quota; False when the tenant already used `limit` today."""
    day = _now()[:10]
    with closing(_connect()) as con, con:
        n = con.execute("INSERT INTO usage VALUES (?, ?, 1) ON CONFLICT(tenant_id, day) DO UPDATE SET generates = generates + 1 "
                        "WHERE generates < ?", (tenant, day, limit)).rowcount
    return n > 0


def list_tenants() -> list[dict]:
    with closing(_connect()) as con:
        return [dict(r) for r in con.execute("SELECT id, name, created_at FROM tenants ORDER BY id")]


# --- companies -------------------------------------------------------------

def save_company(tenant: str, bundle: dict) -> dict:
    cid, name, at = bundle["company"]["id"], bundle["company"]["name"], _now()
    with closing(_connect()) as con, con:
        con.execute("INSERT INTO companies VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET "
                    "name = excluded.name, bundle = excluded.bundle, updated_at = excluded.updated_at",
                    (tenant, cid, name, json.dumps(bundle), at))
    return {"id": cid, "name": name, "updated_at": at}


def list_companies(tenant: str) -> list[dict]:
    with closing(_connect()) as con:
        rows = con.execute("SELECT id, name, updated_at FROM companies WHERE tenant_id = ? ORDER BY updated_at DESC, id",
                           (tenant,)).fetchall()
    return [dict(r) for r in rows]


def get_company(tenant: str, cid: str) -> dict | None:
    with closing(_connect()) as con:
        row = con.execute("SELECT bundle FROM companies WHERE tenant_id = ? AND id = ?", (tenant, cid)).fetchone()
    return None if row is None else json.loads(row["bundle"])


def delete_company(tenant: str, cid: str) -> bool:
    with closing(_connect()) as con, con:
        return con.execute("DELETE FROM companies WHERE tenant_id = ? AND id = ?", (tenant, cid)).rowcount > 0


# --- runs ------------------------------------------------------------------

def save_run(tenant: str, company_id: str | None, name: str, request: dict, result: dict) -> int:
    with closing(_connect()) as con, con:
        cur = con.execute("INSERT INTO runs (tenant_id, company_id, name, request, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                          (tenant, company_id, name, json.dumps(request), json.dumps(result), _now()))
        return cur.lastrowid


def list_runs(tenant: str, company_id: str | None = None, limit: int = 50) -> list[dict]:
    where, args = ("AND company_id = ?", [company_id]) if company_id is not None else ("", [])
    with closing(_connect()) as con:
        rows = con.execute(f"SELECT id, company_id, name, created_at FROM runs WHERE tenant_id = ? {where} ORDER BY id DESC LIMIT ?",
                           [tenant, *args, limit]).fetchall()
    return [dict(r) for r in rows]


def get_run(tenant: str, rid: int) -> dict | None:
    with closing(_connect()) as con:
        row = con.execute("SELECT * FROM runs WHERE tenant_id = ? AND id = ?", (tenant, rid)).fetchone()
    if row is None:
        return None
    out = {**dict(row), "request": json.loads(row["request"]), "result": json.loads(row["result"])}
    del out["tenant_id"]
    return out
