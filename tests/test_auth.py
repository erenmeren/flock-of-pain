import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from flock_of_pain import store
from flock_of_pain.api import app

client = TestClient(app)
PW = "correct horse battery"
REAL_N = store.SCRYPT_N


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOCK_DB", str(tmp_path / "t.db"))
    monkeypatch.setattr(store, "SCRYPT_N", 16)  # keeps the many logins here fast


@pytest.fixture
def key():
    return store.create_tenant("t1", "Tenant 1")


def k(key):
    return {"X-API-Key": key}


def b(token):
    return {"Authorization": f"Bearer {token}"}


def sql(stmt, *args):
    with sqlite3.connect(store.os.environ["FLOCK_DB"]) as con:
        return con.execute(stmt, args).fetchall()


def login(email="a@x.io", password=PW):
    return client.post("/auth/login", json={"email": email, "password": password})


def user(key, email, role="viewer", password=PW):
    r = client.post("/users", json={"email": email, "password": password, "role": role}, headers=k(key))
    assert r.status_code == 200, r.text
    return b(login(email, password).json()["token"])


def scrypt_calls(monkeypatch):
    calls = []
    real = hashlib.scrypt
    monkeypatch.setattr(store.hashlib, "scrypt", lambda *a, **kw: calls.append(1) or real(*a, **kw))
    return calls


# --- login and sessions ---------------------------------------------------

def test_login_me_logout(key):
    user(key, "a@x.io", "editor")
    r = login("A@X.io")  # email is case-insensitive
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"token", "tenant", "email", "role", "expires_at"}
    assert (body["tenant"], body["email"], body["role"]) == ("t1", "a@x.io", "editor")
    assert client.get("/auth/me", headers=b(body["token"])).json() == {"tenant": "t1", "email": "a@x.io", "role": "editor"}
    assert client.get("/companies", headers=b(body["token"])).status_code == 200
    assert client.post("/auth/logout", headers=b(body["token"])).status_code == 200
    assert client.get("/auth/me", headers=b(body["token"])).status_code == 401


def test_me_with_api_key(key):
    assert client.get("/auth/me", headers=k(key)).json() == {"tenant": "t1", "email": None, "role": "admin"}
    assert client.post("/auth/logout", headers=k(key)).status_code == 200  # no session to delete
    assert client.get("/auth/me", headers=k(key)).status_code == 200


def test_both_headers_valid_key_wins_and_bad_key_falls_back_to_session(key):
    h = user(key, "v@x.io")
    assert client.get("/auth/me", headers={**k(key), **h}).json()["role"] == "admin"
    assert client.get("/auth/me", headers={"X-API-Key": "stale", **h}).json()["role"] == "viewer"


@pytest.mark.parametrize("headers", [{}, {"X-API-Key": "nope"}, {"Authorization": "Bearer nope"}, {"Authorization": "Basic nope"}])
def test_bad_credentials_401(headers):
    assert client.get("/auth/me", headers=headers).status_code == 401
    assert client.post("/auth/logout", headers=headers).status_code == 401
    assert client.get("/companies", headers=headers).status_code == 401


def test_unknown_email_and_wrong_password_same_401_and_one_scrypt(key, monkeypatch):
    user(key, "a@x.io")
    calls = scrypt_calls(monkeypatch)
    wrong, unknown = login("a@x.io", "wrong password"), login("nobody@x.io", "wrong password")
    assert len(calls) == 2  # one each: an unknown email runs scrypt too
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.content == unknown.content and wrong.headers["www-authenticate"] == unknown.headers["www-authenticate"]


def test_dummy_hash_uses_current_cost():
    # same work as a real user's hash, and nothing verifies against it
    assert store._dummy_hash().split("$")[1:4] == store.hash_password(PW).split("$")[1:4]
    assert store.login("nobody@x.io", "") is None


def test_stored_secrets_are_hashed_salted_and_carry_parameters(key):
    user(key, "a@x.io"), user(key, "b@x.io")
    token = login("a@x.io").json()["token"]
    (ha,), (hb,) = sql("SELECT password_hash FROM users ORDER BY email")
    pa, pb = ha.split("$"), hb.split("$")
    assert pa[:4] == ["scrypt", "16", str(store.SCRYPT_R), str(store.SCRYPT_P)]
    assert pa[4] != pb[4] and pa[5] != pb[5]  # per-user salt, same password
    assert PW not in ha
    hashes = {r[0] for r in sql("SELECT token_hash FROM sessions")}
    assert token not in hashes and hashlib.sha256(token.encode()).hexdigest() in hashes


def test_default_scrypt_cost_is_owasp_tier(monkeypatch):
    monkeypatch.setattr(store, "SCRYPT_N", REAL_N)
    assert store.hash_password(PW).split("$")[:4] == ["scrypt", "16384", "8", "5"]


def test_scrypt_parameters_can_change_later(key, monkeypatch):
    user(key, "a@x.io")
    monkeypatch.setattr(store, "SCRYPT_N", 2 ** 16)  # over hashlib's default maxmem
    monkeypatch.setattr(store, "SCRYPT_P", 1)
    assert login().status_code == 200
    user(key, "b@x.io")
    assert sql("SELECT password_hash FROM users WHERE email = 'b@x.io'")[0][0].startswith("scrypt$65536$8$1$")
    assert login("b@x.io").status_code == 200


def test_expired_session_rejected_and_purged(key):
    h = user(key, "a@x.io")
    old = "2020-01-01T00:00:00+00:00"
    sql("UPDATE sessions SET expires_at = ?", old)
    assert client.get("/auth/me", headers=h).status_code == 401
    assert sql("SELECT count(*) FROM sessions") == [(0,)]


def test_abandoned_expired_sessions_purged_at_login(key):
    user(key, "a@x.io")
    sql("UPDATE sessions SET expires_at = '2020-01-01T00:00:00+00:00'")
    assert login().status_code == 200
    assert sql("SELECT count(*) FROM sessions") == [(1,)]


def test_session_lasts_seven_days(key):
    from datetime import datetime, timezone
    user(key, "a@x.io")
    left = datetime.fromisoformat(login().json()["expires_at"]) - datetime.now(timezone.utc)
    assert 6.99 < left.total_seconds() / 86400 <= 7


# --- failed-login limit -----------------------------------------------------

def test_login_limit_blocks_right_password_and_unknown_email(key, monkeypatch):
    user(key, "a@x.io")
    for _ in range(10):
        assert login("A@x.io", "wrong password").status_code == 401  # counted under the lowercased email
    calls = scrypt_calls(monkeypatch)
    assert login("a@x.io", "wrong password").status_code == 429
    assert login("a@x.io", PW).status_code == 429
    assert not calls  # a locked email costs no scrypt
    assert login("b@x.io", PW).status_code == 401  # others are unaffected
    for _ in range(10):
        login("ghost@x.io", "wrong password")
    assert login("ghost@x.io", "wrong password").status_code == 429  # same answer, so 429 does not reveal an account


def test_login_limit_resets_on_success(key):
    user(key, "a@x.io")
    for _ in range(9):
        assert login("a@x.io", "wrong password").status_code == 401
    assert login().status_code == 200
    for _ in range(10):
        assert login("a@x.io", "wrong password").status_code == 401
    assert login().status_code == 429


def test_login_limit_window_passes(key):
    user(key, "a@x.io")
    for _ in range(10):
        login("a@x.io", "wrong password")
    assert login().status_code == 429
    sql("UPDATE login_failures SET at = '2020-01-01T00:00:00+00:00'")
    sql("UPDATE login_ip_failures SET at = '2020-01-01T00:00:00+00:00'")
    assert login().status_code == 200
    assert sql("SELECT count(*) FROM login_failures") == [(0,)]
    assert sql("SELECT count(*) FROM login_ip_failures") == [(0,)]


def test_parallel_guesses_cannot_pass_the_limit():
    with ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda _: store.take_login_attempt("a@x.io", "1.2.3.4"), range(30)))
    assert codes.count(True) == 10


def test_ip_limit_blocks_spraying_many_emails_before_scrypt(key, monkeypatch):
    monkeypatch.setattr(store, "LOGIN_IP_LIMIT", 3)
    user(key, "a@x.io")  # its successful login leaves no failure behind
    for i in range(3):
        assert login(f"g{i}@x.io", "wrong password").status_code == 401
    calls = scrypt_calls(monkeypatch)
    r = login()
    assert r.status_code == 429 and r.json()["path"] is None  # even the right password, from this IP
    assert not calls
    other = TestClient(app, client=("10.0.0.2", 1))
    assert other.post("/auth/login", json={"email": "a@x.io", "password": PW}).status_code == 200
    sql("UPDATE login_ip_failures SET at = '2020-01-01T00:00:00+00:00'")
    assert login().status_code == 200


def test_ip_limit_default_and_successes_do_not_count(key):
    assert store.LOGIN_IP_LIMIT == 50
    user(key, "a@x.io")
    for _ in range(60):
        assert login().status_code == 200
    assert sql("SELECT count(*) FROM login_ip_failures") == [(0,)]


# --- own password change ----------------------------------------------------

def change(h, current=PW, new="a brand new password"):
    return client.post("/auth/password", json={"current": current, "new": new}, headers=h)


def test_own_password_change_keeps_only_the_current_session(key):
    h = user(key, "a@x.io")
    other = b(login().json()["token"])
    r = change(h)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert client.get("/auth/me", headers=h).status_code == 200
    assert client.get("/auth/me", headers=other).status_code == 401
    assert login().status_code == 401
    assert login("a@x.io", "a brand new password").status_code == 200


def test_own_password_change_wrong_current_counts_as_failed_login(key):
    h = user(key, "a@x.io")
    for _ in range(10):
        r = change(h, current="wrong password")
        assert r.status_code == 401 and r.json()["path"] == "current"
    assert change(h).status_code == 429
    assert login().status_code == 429
    assert client.get("/auth/me", headers=h).status_code == 200  # a wrong guess does not end the session
    assert sql("SELECT count(*) FROM users WHERE email = 'a@x.io'") == [(1,)]


def test_own_password_change_bad_new_422_and_nothing_changes(key, monkeypatch):
    h = user(key, "a@x.io")
    calls = scrypt_calls(monkeypatch)
    r = change(h, new="short")
    assert r.status_code == 422 and r.json()["path"] == "new"
    assert not calls and sql("SELECT count(*) FROM login_failures") == [(0,)]
    assert login().status_code == 200


def test_own_password_change_with_api_key_422(key):
    r = change(k(key))
    assert r.status_code == 422 and r.json() == {"path": None, "message": "an API key has no password"}
    assert client.post("/auth/password", json={"current": PW, "new": "a brand new password"}).status_code == 401


# --- password and email validation ------------------------------------------

def test_long_password_rejected_without_scrypt(key, monkeypatch):
    user(key, "a@x.io")
    calls = scrypt_calls(monkeypatch)
    big = "x" * 201
    r = login("a@x.io", big)
    assert r.status_code == 422 and r.json()["path"] == "password" and big not in r.text
    assert client.post("/users", json={"email": "c@x.io", "password": big, "role": "viewer"}, headers=k(key)).status_code == 422
    assert client.patch("/users/a@x.io", json={"password": big}, headers=k(key)).status_code == 422
    assert not calls


def test_password_minimum_and_maximum(key):
    body = {"email": "c@x.io", "role": "viewer"}
    r = client.post("/users", json={**body, "password": "x" * 9}, headers=k(key))
    assert r.status_code == 422 and r.json()["path"] == "password"
    assert client.post("/users", json={**body, "password": "x" * 10}, headers=k(key)).status_code == 200
    assert client.post("/users", json={**body, "email": "d@x.io", "password": "x" * 200}, headers=k(key)).status_code == 200


@pytest.mark.parametrize("email", ["nope", "a@b", "a b@x.io", "a@@x.io", "a/b@x.io", "@x.io", f"{'a' * 250}@x.io", "a@x.io\n"])
def test_bad_email_422(key, email):
    r = client.post("/users", json={"email": email, "password": PW, "role": "viewer"}, headers=k(key))
    assert r.status_code == 422 and r.json()["path"] == "email"


def test_email_lowercased(key):
    r = client.post("/users", json={"email": "Mixed@X.IO", "password": PW, "role": "viewer"}, headers=k(key))
    assert r.json()["email"] == "mixed@x.io"
    assert client.get("/users", headers=k(key)).json()[0]["email"] == "mixed@x.io"
    assert client.delete("/users/MIXED@x.io", headers=k(key)).status_code == 200


def test_odd_unicode_is_not_a_500(key):
    raw = '{"email": "a@x.io", "password": "\\ud800 lone surrogate"}'
    assert client.post("/auth/login", content=raw, headers={"Content-Type": "application/json"}).status_code == 422
    raw = '{"email": "\\ud800@x.io", "password": "lone surrogate"}'
    assert client.post("/auth/login", content=raw, headers={"Content-Type": "application/json"}).status_code == 422
    assert login("é@x.io", "pässwörd ünïcode").status_code == 401


def test_invalid_role_422(key):
    assert client.post("/users", json={"email": "c@x.io", "password": PW, "role": "root"}, headers=k(key)).status_code == 422
    assert client.patch("/users/c@x.io", json={"role": "root"}, headers=k(key)).status_code == 422


# --- roles ------------------------------------------------------------------

def bundle():
    return client.get("/example").json()


def writes():
    ex = bundle()
    return [("put", f"/companies/{ex['company']['id']}", {"company": ex["company"], "scenarios": ex["scenarios"]}),
            ("delete", "/companies/nope", None), ("delete", "/runs/1", None), ("post", "/generate", {"prompt": "x"}),
            ("post", "/simulate", {"company": ex["company"], "scenarios": ex["scenarios"][:1],
                                   "config": {"seed": 1, "days": 1}, "save": True})]


def call(method, path, body, headers):
    return client.request(method, path, json=body, headers=headers) if body else client.request(method, path, headers=headers)


def test_viewer_cannot_write_and_nothing_is_stored(key, monkeypatch):
    from flock_of_pain import agent
    monkeypatch.setattr(agent, "generate", lambda _: pytest.fail("viewer reached /generate"))
    h = user(key, "v@x.io", "viewer")
    for method, path, body in writes():
        r = call(method, path, body, h)
        assert r.status_code == 403, (path, r.text)
        assert set(r.json()) == {"path", "message"}
    assert client.get("/runs", headers=k(key)).json() == [] and client.get("/companies", headers=k(key)).json() == []
    assert sql("SELECT count(*) FROM usage") == [(0,)]  # the 403 spends no /generate quota


def test_viewer_403_comes_before_body_validation(key):
    assert client.put("/companies/x", json={}, headers=user(key, "v@x.io")).status_code == 403


def test_viewer_save_refused_before_simulating(key, monkeypatch):
    from flock_of_pain import api
    h = user(key, "v@x.io")
    monkeypatch.setattr(api, "run_experiment", lambda *a, **kw: pytest.fail("viewer save ran the simulation"))
    assert call(*writes()[-1], h).status_code == 403


def test_viewer_reads_and_runs_without_save(key):
    h = user(key, "v@x.io")
    ex = bundle()
    assert client.put(f"/companies/{ex['company']['id']}", json={"company": ex["company"], "scenarios": ex["scenarios"]},
                      headers=k(key)).status_code == 200
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:1],
                                       "config": {"seed": 1, "days": 1}}, headers=h)
    assert r.status_code == 200 and "run_id" not in r.json()
    rid = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:1],
                                         "config": {"seed": 1, "days": 1}, "save": True}, headers=k(key)).json()["run_id"]
    assert client.get("/companies", headers=h).status_code == 200
    assert client.get(f"/companies/{ex['company']['id']}", headers=h).status_code == 200
    assert client.get("/runs", headers=h).status_code == 200 and client.get(f"/runs/{rid}", headers=h).status_code == 200
    assert client.post("/calibrate/durations", json={"minutes": [1, 2, 3]}, headers=h).status_code == 200
    assert client.post("/calibrate/arrivals", json={"timestamps": ["2026-10-05T09:10:00", "2026-10-06T09:10:00"]},
                       headers=h).status_code == 200


def test_editor_writes_but_does_not_manage_users(key):
    h = user(key, "e@x.io", "editor")
    ex = bundle()
    assert client.put(f"/companies/{ex['company']['id']}", json={"company": ex["company"], "scenarios": ex["scenarios"]},
                      headers=h).status_code == 200
    r = client.post("/simulate", json={"company": ex["company"], "scenarios": ex["scenarios"][:1],
                                       "config": {"seed": 1, "days": 1}, "save": True}, headers=h)
    assert r.status_code == 200 and client.delete(f"/runs/{r.json()['run_id']}", headers=h).status_code == 200
    assert client.delete(f"/companies/{ex['company']['id']}", headers=h).status_code == 200
    assert client.get("/users", headers=h).status_code == 403
    assert client.post("/users", json={"email": "c@x.io", "password": PW, "role": "admin"}, headers=h).status_code == 403
    assert client.patch("/users/e@x.io", json={"role": "admin"}, headers=h).status_code == 403
    assert client.delete("/users/e@x.io", headers=h).status_code == 403


def test_viewer_cannot_manage_users(key):
    assert client.get("/users", headers=user(key, "v@x.io")).status_code == 403


@pytest.mark.parametrize("method,path", [("get", "/users"), ("post", "/users"), ("patch", "/users/a@x.io"), ("delete", "/users/a@x.io")])
def test_users_endpoints_need_auth(method, path):
    assert client.request(method, path).status_code == 401


# --- user management --------------------------------------------------------

def test_users_list_shows_no_secrets(key):
    user(key, "a@x.io", "admin")
    rows = client.get("/users", headers=k(key)).json()
    assert len(rows) == 1 and set(rows[0]) == {"email", "role", "created_at"}
    r = client.post("/users", json={"email": "b@x.io", "password": PW, "role": "viewer"}, headers=k(key))
    assert set(r.json()) == {"email", "role", "created_at"}
    r = client.patch("/users/b@x.io", json={"role": "editor"}, headers=k(key))
    assert set(r.json()) == {"email", "role", "created_at"} and r.json()["role"] == "editor"


def test_tenant_isolation_returns_404(key):
    other = store.create_tenant("t2", "Tenant 2")
    h1, h2 = user(key, "a@x.io", "admin"), user(other, "b@x.io", "admin")
    user(key, "keep@x.io", "admin")
    assert [u["email"] for u in client.get("/users", headers=h1).json()] == ["a@x.io", "keep@x.io"]
    assert [u["email"] for u in client.get("/users", headers=h2).json()] == ["b@x.io"]
    for h in (h2, k(other)):
        assert client.patch("/users/a@x.io", json={"role": "viewer"}, headers=h).status_code == 404
        assert client.patch("/users/a@x.io", json={"password": "new password here"}, headers=h).status_code == 404
        assert client.delete("/users/a@x.io", headers=h).status_code == 404
    assert client.get("/auth/me", headers=h1).json()["role"] == "admin"  # untouched, session alive


def test_email_taken_across_tenants_409_only_for_admin(key):
    user(key, "a@x.io")
    other = store.create_tenant("t2", "Tenant 2")
    body = {"email": "A@x.io", "password": PW, "role": "viewer"}
    r = client.post("/users", json=body, headers=k(other))
    assert r.status_code == 409 and r.json()["path"] == "email"
    assert client.post("/users", json=body, headers=k(key)).status_code == 409
    assert client.post("/users", json=body).status_code == 401
    assert client.post("/users", json=body, headers=user(other, "v@x.io")).status_code == 403


def test_change_role_deletes_sessions(key):
    user(key, "keep@x.io", "admin")
    h = user(key, "a@x.io", "admin")
    assert client.patch("/users/a@x.io", json={"role": "viewer"}, headers=k(key)).json()["role"] == "viewer"
    assert client.get("/auth/me", headers=h).status_code == 401
    assert login().json()["role"] == "viewer"


def test_change_password_deletes_sessions(key):
    h = user(key, "a@x.io", "viewer")
    assert client.patch("/users/a@x.io", json={"password": "a brand new password"}, headers=k(key)).status_code == 200
    assert client.get("/auth/me", headers=h).status_code == 401
    assert login().status_code == 401
    assert login("a@x.io", "a brand new password").status_code == 200


def test_empty_patch_422(key):
    user(key, "a@x.io")
    assert client.patch("/users/a@x.io", json={}, headers=k(key)).status_code == 422


def test_delete_user_deletes_sessions(key):
    h = user(key, "a@x.io")
    assert client.delete("/users/a@x.io", headers=k(key)).json() == {"deleted": "a@x.io"}
    assert client.get("/auth/me", headers=h).status_code == 401
    assert sql("SELECT count(*) FROM sessions") == [(0,)]
    assert client.delete("/users/a@x.io", headers=k(key)).status_code == 404


def test_last_admin_protected_even_for_api_key(key):
    h = user(key, "a@x.io", "admin")
    for r in (client.delete("/users/a@x.io", headers=k(key)),
              client.delete("/users/a@x.io", headers=h),
              client.patch("/users/a@x.io", json={"role": "editor"}, headers=k(key)),
              client.patch("/users/a@x.io", json={"role": "viewer"}, headers=h)):
        assert r.status_code == 409 and set(r.json()) == {"path", "message"}
    assert client.get("/auth/me", headers=h).json()["role"] == "admin"  # the refused change kept the session
    assert client.patch("/users/a@x.io", json={"role": "admin"}, headers=k(key)).status_code == 200  # not a demotion
    assert client.patch("/users/a@x.io", json={"password": "another long password"}, headers=k(key)).status_code == 200


def test_last_admin_counts_per_tenant_and_second_admin_frees_the_first(key):
    user(key, "a@x.io", "admin")
    other = store.create_tenant("t2", "Tenant 2")
    user(other, "b@x.io", "admin")
    assert client.delete("/users/a@x.io", headers=k(key)).status_code == 409  # t2's admin does not count
    user(key, "c@x.io", "admin")
    assert client.delete("/users/a@x.io", headers=k(key)).status_code == 200
    assert client.delete("/users/c@x.io", headers=k(key)).status_code == 409


def test_non_admin_can_be_removed_without_admins(key):
    user(key, "v@x.io")
    assert client.delete("/users/v@x.io", headers=k(key)).status_code == 200


def test_parallel_demotions_keep_one_admin():
    store.create_tenant("t1", "t")
    emails = [f"a{i}@x.io" for i in range(8)]
    for e in emails:
        store.create_user("t1", e, PW, "admin")

    def demote(e):
        try:
            return store.update_user("t1", e, role="viewer")
        except store.LimitError:
            return None

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(demote, emails))
    assert sql("SELECT count(*) FROM users WHERE role = 'admin'") == [(1,)]


def test_rotate_keeps_user_sessions(key):
    h = user(key, "a@x.io", "editor")
    assert store.new_key("t1") != key
    assert client.get("/auth/me", headers=h).json()["email"] == "a@x.io"
    assert client.get("/companies", headers=k(key)).status_code == 401


# --- signup -----------------------------------------------------------------

def test_signup_with_admin_user(monkeypatch):
    monkeypatch.setenv("FLOCK_SIGNUP_CODE", "open-sesame")
    r = client.post("/signup", json={"id": "new", "invite": "open-sesame", "email": "Boss@x.io", "password": PW})
    assert r.status_code == 200 and set(r.json()) == {"id", "key"}
    assert login("boss@x.io").json()["role"] == "admin"
    assert login("boss@x.io").json()["tenant"] == "new"


def test_signup_email_taken_409_needs_invite_and_leaves_no_tenant(key, monkeypatch):
    monkeypatch.setenv("FLOCK_SIGNUP_CODE", "open-sesame")
    user(key, "a@x.io")
    body = {"id": "new", "email": "a@x.io", "password": PW}
    assert client.post("/signup", json={**body, "invite": "wrong"}).status_code == 401
    r = client.post("/signup", json={**body, "invite": "open-sesame"})
    assert r.status_code == 409 and r.json()["path"] == "email"
    assert [t["id"] for t in store.list_tenants()] == ["t1"]


def test_signup_id_taken_409_path_id(key, monkeypatch):
    monkeypatch.setenv("FLOCK_SIGNUP_CODE", "open-sesame")
    r = client.post("/signup", json={"id": "t1", "email": "n@x.io", "password": PW, "invite": "open-sesame"})
    assert r.status_code == 409 and r.json()["path"] == "id"
    assert sql("SELECT count(*) FROM users") == [(0,)]


@pytest.mark.parametrize("patch,path", [({"email": "a@x.io"}, "password"), ({"password": PW}, "email"),
                                        ({"email": "nope", "password": PW}, "email"),
                                        ({"email": "a@x.io", "password": "short"}, "password"),
                                        ({"email": "a@x.io", "password": "x" * 201}, "password")])
def test_signup_bad_credentials_422_leaves_no_tenant(monkeypatch, patch, path):
    monkeypatch.setenv("FLOCK_SIGNUP_CODE", "open-sesame")
    r = client.post("/signup", json={"id": "new", "invite": "open-sesame", **patch})
    assert r.status_code == 422 and r.json()["path"] == path
    assert store.list_tenants() == []


def test_signup_wrong_invite_runs_no_scrypt(monkeypatch):
    monkeypatch.setenv("FLOCK_SIGNUP_CODE", "open-sesame")
    calls = scrypt_calls(monkeypatch)
    assert client.post("/signup", json={"id": "new", "invite": "no", "email": "a@x.io", "password": PW}).status_code == 401
    assert not calls


# --- schema and CORS --------------------------------------------------------

def test_new_tables_added_to_an_existing_database(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);"
                      "INSERT INTO tenants VALUES ('old', 'Old', 'h', 'now');")
    con.close()
    monkeypatch.setenv("FLOCK_DB", str(path))
    assert [t["id"] for t in store.list_tenants()] == ["old"]
    store.create_user("old", "a@x.io", PW, "admin")
    assert store.login("a@x.io", PW)["tenant"] == "old"


def test_cors_allows_authorization(key):
    h = user(key, "a@x.io")
    origin = {"Origin": "http://localhost:3000"}
    r = client.options("/auth/me", headers={**origin, "Access-Control-Request-Method": "GET",
                                            "Access-Control-Request-Headers": "authorization"})
    assert r.status_code == 200 and "authorization" in r.headers["access-control-allow-headers"].lower()
    r = client.get("/auth/me", headers={**origin, **h})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == origin["Origin"]
    r = client.options("/users/a@x.io", headers={**origin, "Access-Control-Request-Method": "PATCH"})
    assert r.status_code == 200 and "PATCH" in r.headers["access-control-allow-methods"]
