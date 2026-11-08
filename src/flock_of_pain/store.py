"""SQLite persistence: tenants with API keys, users and sessions, company bundles and run results. Stdlib only.

A bundle is {"company": {...}, "scenarios": [...]} in the API's JSON form, keyed by (tenant, company id).
Run results are stored without events. Path from FLOCK_DB (default ./flock.db).
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone

TENANT_ID, TENANT_ID_MAX = r"[\w.-]+", 64  # shared by the API and the CLI
MAX_COMPANIES = int(os.environ.get("FLOCK_MAX_COMPANIES", "50"))  # per tenant; parsed at import so a typo fails at startup
MAX_SAVED_RUNS = int(os.environ.get("FLOCK_MAX_RUNS", "200"))  # per tenant; older runs are deleted
MIN_PASSWORD, MAX_PASSWORD, MAX_EMAIL = 10, 200, 254  # the password cap keeps scrypt from being a CPU sink through the 2 MB body
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 5  # an OWASP tier; 16 MB per hash. Stored with each hash, so these can change
SESSION_DAYS = 7
LOGIN_LIMIT, LOGIN_WINDOW_MINUTES = 10, 15


class LimitError(Exception):
    """A per-tenant storage cap was reached, or a change would leave the tenant without an admin user."""


class CredentialError(ValueError):
    """A bad email or password; `path` is the request field."""

    def __init__(self, path: str, message: str):
        super().__init__(message)
        self.path = path


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
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS users_tenant ON users (tenant_id);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);
CREATE TABLE IF NOT EXISTS login_failures (email TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures (email);
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


_ready: set[str] = set()  # db paths already migrated and in WAL mode in this process
_ready_lock = threading.Lock()  # switching to WAL fails at once (no busy wait) while another connection reads


def _connect() -> sqlite3.Connection:
    path = os.environ.get("FLOCK_DB", "flock.db")
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    if path not in _ready:
        with _ready_lock:
            if path not in _ready:
                if _needs_v1(con):
                    _migrate(con)
                con.executescript(SCHEMA)
                con.execute("PRAGMA journal_mode=WAL")
                _ready.add(path)
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

def create_tenant(tid: str, name: str, email: str | None = None, password: str | None = None) -> str:
    """Create a tenant, with its first admin user when `email` is given, and return its API key, shown once; only the
    hash is stored. One transaction: a taken email leaves no tenant behind (IntegrityError names the column)."""
    key = f"fop_{secrets.token_urlsafe(32)}"
    user = None if email is None else _user_row(tid, email, password, "admin")
    with closing(_connect()) as con, con:
        con.execute("INSERT INTO tenants VALUES (?, ?, ?, ?)", (tid, name, _hash(key), _now()))
        if user:
            con.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?)", user)
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


def take_generate(tenant: str, limit: int, global_limit: int) -> bool:
    """Count one /generate call against today's (UTC) quota; False when the tenant already used `limit` today
    or all tenants together (the '*' row) used `global_limit`. Nothing is counted on False."""
    if limit <= 0 or global_limit <= 0:  # the upsert below would let the first call through
        return False
    day = _now()[:10]
    with closing(_connect()) as con, con:
        for tid, cap in ((tenant, limit), ("*", global_limit)):
            n = con.execute("INSERT INTO usage VALUES (?, ?, 1) ON CONFLICT(tenant_id, day) DO UPDATE SET generates = generates + 1 "
                            "WHERE generates < ?", (tid, day, cap)).rowcount
            if n == 0:
                con.rollback()
                return False
    return True


def list_tenants() -> list[dict]:
    with closing(_connect()) as con:
        return [dict(r) for r in con.execute("SELECT id, name, created_at FROM tenants ORDER BY id")]


# --- users and sessions ----------------------------------------------------

def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=128 * r * (n + p + 2))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    _, n, r, p, salt, digest = stored.split("$")
    return secrets.compare_digest(_scrypt(password, bytes.fromhex(salt), int(n), int(r), int(p)), bytes.fromhex(digest))


def _dummy_hash() -> str:
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${'00' * 16}${'00' * 64}"


def check_email(email: str) -> str:
    """The lowercased email; '/' is out because the address is a URL path segment in /users/{email}."""
    if len(email) > MAX_EMAIL or not re.fullmatch(r"[^@\s/]+@[^@\s/]+\.[^@\s/]+", email):
        raise CredentialError("email", "expected an address like name@example.com")
    return email.lower()


def check_password(password: str) -> None:
    if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        raise CredentialError("password", f"must have {MIN_PASSWORD} to {MAX_PASSWORD} characters")


def _user_row(tenant: str, email: str, password: str, role: str) -> tuple:
    email = check_email(email)
    check_password(password)
    return email, tenant, role, hash_password(password), _now()


def create_user(tenant: str, email: str, password: str, role: str) -> dict:
    """Raises sqlite3.IntegrityError when the email exists in any tenant."""
    row = _user_row(tenant, email, password, role)
    with closing(_connect()) as con, con:
        con.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?)", row)
    return {"email": row[0], "role": role, "created_at": row[4]}


def list_users(tenant: str) -> list[dict]:
    with closing(_connect()) as con:
        return [dict(r) for r in con.execute("SELECT email, role, created_at FROM users WHERE tenant_id = ? ORDER BY email", (tenant,))]


def _lock_user(con: sqlite3.Connection, tenant: str, email: str, leaves_admin: bool) -> sqlite3.Row | None:
    """The user's row under a write lock, so parallel demotions cannot both pass the last-admin check."""
    con.execute("BEGIN IMMEDIATE")
    row = con.execute("SELECT email, role, created_at FROM users WHERE tenant_id = ? AND email = ?", (tenant, email)).fetchone()
    if row is not None and leaves_admin and row["role"] == "admin" and con.execute(
            "SELECT count(*) FROM users WHERE tenant_id = ? AND role = 'admin'", (tenant,)).fetchone()[0] == 1:
        raise LimitError(f"{email} is the tenant's last admin user")
    return row


def update_user(tenant: str, email: str, role: str | None = None, password: str | None = None) -> dict | None:
    """Change a user of this tenant and delete their sessions; None when there is no such user."""
    if password is not None:
        check_password(password)
    hashed = None if password is None else hash_password(password)  # before the lock: scrypt is slow
    with closing(_connect()) as con, con:
        row = _lock_user(con, tenant, email, role not in (None, "admin"))
        if row is None:
            return None
        con.execute("UPDATE users SET role = coalesce(?, role), password_hash = coalesce(?, password_hash) WHERE email = ?",
                    (role, hashed, email))
        con.execute("DELETE FROM sessions WHERE email = ?", (email,))
    return {**dict(row), "role": role or row["role"]}


def delete_user(tenant: str, email: str) -> bool:
    with closing(_connect()) as con, con:
        if _lock_user(con, tenant, email, True) is None:
            return False
        con.execute("DELETE FROM users WHERE email = ?", (email,))
        con.execute("DELETE FROM sessions WHERE email = ?", (email,))
    return True


def take_login_attempt(email: str) -> bool:
    """Count one attempt against the email's limit before any scrypt, atomically so parallel guesses cannot pass it;
    a successful login() clears the count. False when the limit is reached, even if the password would be right."""
    # shortcut: anyone who knows an email can lock its login for 15 minutes, and spraying many emails is not limited, add a per-IP limit at the proxy when either is abused
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=LOGIN_WINDOW_MINUTES)).isoformat(timespec="seconds")
    with closing(_connect()) as con, con:
        con.execute("DELETE FROM login_failures WHERE at <= ?", (cutoff,))
        return con.execute("INSERT INTO login_failures SELECT ?, ? WHERE (SELECT count(*) FROM login_failures WHERE email = ?) < ?",
                           (email, _now(), email, LOGIN_LIMIT)).rowcount > 0


def login(email: str, password: str) -> dict | None:
    """A new session, or None. An unknown email costs one scrypt too, so timing does not tell which emails exist."""
    with closing(_connect()) as con:
        user = con.execute("SELECT tenant_id, role, password_hash FROM users WHERE email = ?", (email,)).fetchone()
    right = _verify_password(password, user["password_hash"] if user else _dummy_hash())
    if user is None or not right:
        return None
    token = f"fos_{secrets.token_urlsafe(32)}"
    expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds")
    with closing(_connect()) as con, con:
        con.execute("DELETE FROM sessions WHERE expires_at <= ?", (_now(),))
        con.execute("DELETE FROM login_failures WHERE email = ?", (email,))
        # the hash in the WHERE: a removal or password change during the slow scrypt above leaves no session
        if con.execute("INSERT INTO sessions SELECT ?, email, ? FROM users WHERE email = ? AND password_hash = ?",
                       (_hash(token), expires_at, email, user["password_hash"])).rowcount == 0:
            return None
    return {"token": token, "tenant": user["tenant_id"], "email": email, "role": user["role"], "expires_at": expires_at}


def session_user(token: str) -> dict | None:
    """The live {email, tenant_id, role} of a session token; an expired session is deleted. Independent of the tenant key."""
    with closing(_connect()) as con, con:
        row = con.execute("SELECT u.email, u.tenant_id, u.role, s.expires_at FROM sessions s JOIN users u ON u.email = s.email "
                          "WHERE s.token_hash = ?", (_hash(token),)).fetchone()
        if row is None:
            return None
        if row["expires_at"] <= _now():
            con.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))
            return None
    return dict(row)


def delete_session(token: str) -> None:
    with closing(_connect()) as con, con:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))


# --- companies -------------------------------------------------------------

def save_company(tenant: str, bundle: dict) -> dict:
    cid, name, at = bundle["company"]["id"], bundle["company"]["name"], _now()
    with closing(_connect()) as con, con:
        exists = con.execute("SELECT 1 FROM companies WHERE tenant_id = ? AND id = ?", (tenant, cid)).fetchone()
        if not exists and con.execute("SELECT count(*) FROM companies WHERE tenant_id = ?", (tenant,)).fetchone()[0] >= MAX_COMPANIES:
            raise LimitError(f"limit of {MAX_COMPANIES} companies reached; delete one first")
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
        con.execute("DELETE FROM runs WHERE tenant_id = ? AND company_id = ?", (tenant, cid))
        return con.execute("DELETE FROM companies WHERE tenant_id = ? AND id = ?", (tenant, cid)).rowcount > 0


# --- runs ------------------------------------------------------------------

def save_run(tenant: str, company_id: str | None, name: str, request: dict, result: dict) -> int:
    with closing(_connect()) as con, con:
        cur = con.execute("INSERT INTO runs (tenant_id, company_id, name, request, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                          (tenant, company_id, name, json.dumps(request), json.dumps(result), _now()))
        con.execute("DELETE FROM runs WHERE tenant_id = ? AND id NOT IN "
                    "(SELECT id FROM runs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?)", (tenant, tenant, MAX_SAVED_RUNS))
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


def delete_run(tenant: str, rid: int) -> bool:
    with closing(_connect()) as con, con:
        return con.execute("DELETE FROM runs WHERE tenant_id = ? AND id = ?", (tenant, rid)).rowcount > 0


def backup(dest: str) -> None:
    """Online copy of the FLOCK_DB database to `dest` (safe while the API is running)."""
    with closing(_connect()) as src, closing(sqlite3.connect(dest)) as dst:
        src.backup(dst)
