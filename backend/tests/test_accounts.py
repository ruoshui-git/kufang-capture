import hashlib
import io
import json
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event
from urllib.parse import quote
from zipfile import ZipFile

import anyio
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from starlette.responses import FileResponse, JSONResponse, StreamingResponse
from test_contract import HEADERS, collection_mutation, entry_mutation, item_mutation

from kufang_capture import auth
from kufang_capture.db import connect, run_migrations
from kufang_capture.main import create_app
from kufang_capture.settings import Settings

ORIGIN = "http://127.0.0.1"
AT = "2026-11-08T12:00:00.000Z"
PHOTO = "01J00000000000000000000001"
AGENT = "/api/agent/v1/users"
BEARER = {"Authorization": "Bearer account-test-agent"}


def configuration(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        static_dir=tmp_path / "static",
        public_origin=ORIGIN,
        dev_password="test-password",
        min_free_bytes=0,
        agent_token_sha256=hashlib.sha256(b"account-test-agent").hexdigest(),
    )


@pytest.fixture
def api(tmp_path):
    config = configuration(tmp_path)
    with TestClient(create_app(config), base_url=ORIGIN) as owner:
        login = owner.post("/api/auth/login", headers=HEADERS, json={"password": "test-password"})
        assert login.status_code == 204
        yield owner, config


def create(owner, name):
    response = owner.post("/api/people", headers=HEADERS, json={"name": name})
    assert response.status_code == 201
    return response.json()


def issue(owner, user_id):
    response = owner.post(f"/api/people/{user_id}/code", headers=HEADERS)
    assert response.status_code == 200
    return response.json()


def helper(owner, name):
    user_id = create(owner, name)["id"]
    client = TestClient(owner.app, base_url=ORIGIN, headers={"X-Capture-Account": user_id})
    response = join(client, issue(owner, user_id)["code"], device_label=" Pixel ")
    assert response.status_code == 204
    return client, user_id


def join(client, code, **fields):
    return client.post("/api/auth/join", headers=HEADERS, json={"code": code, **fields})


def batch(client, mutations):
    response = client.post("/api/sync/batch", headers=HEADERS, json={"schema": 2, "mutations": mutations})
    assert response.status_code == 200
    return response.json()["results"]


def seed_data(client, cid, name, data, pid=PHOTO):
    digest = hashlib.sha256(data).hexdigest()
    item_id = f"item-{cid}"
    photo = {
        "id": f"m-{pid}",
        "entity": "photo",
        "entity_id": pid,
        "collection_id": cid,
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": pid,
            "item_id": item_id,
            "original_filename": "photo.jpg",
            "mime_type": "image/jpeg",
            "byte_size": len(data),
            "sha256": digest,
            "crc32": zlib.crc32(data),
            "captured_at": AT,
            "capture_source": "native_camera",
            "created_at": AT,
            "updated_at": AT,
        },
    }
    mutations = [
        collection_mutation(f"m-{cid}", cid, name),
        {**item_mutation(item_id, cid), "fields": {**item_mutation(item_id, cid)["fields"], "title": name}},
        entry_mutation(f"m-entry-{cid}", item_id, cid),
        photo,
    ]
    assert [result["status"] for result in batch(client, mutations)] == ["applied"] * 4
    url = f"/api/photos/{pid}"
    headers = {**HEADERS, "Content-Type": "image/jpeg", "X-Content-SHA256": digest}
    assert client.put(url + "/original", headers=headers, content=data).status_code == 201
    assert client.put(url + "/thumbnail", headers=headers, content=b"thumb " + data).status_code == 200


def change_records(client):
    return client.get("/api/sync/changes?schema=2").json()["changes"]


def zip_contents(response):
    assert response.status_code == 200
    with ZipFile(io.BytesIO(response.content)) as archive:
        collections = json.loads(archive.read("capture-export/collections.json"))
        originals = {archive.read(name) for name in archive.namelist() if name.endswith(".jpg")}
    return {row["name"] for row in collections}, originals


def test_account_routes_isolate_owner_and_two_helpers_with_overlapping_ids(api):
    owner, config = api
    alice, alice_id = helper(owner, "Alice")
    bob, bob_id = helper(owner, "Bob")
    accounts = [(owner, "owner", "Owner"), (alice, alice_id, "Alice"), (bob, bob_id, "Bob")]
    for i, (client, user_id, name) in enumerate(accounts, 2):
        seed_data(client, "shared-room", name, name.encode())
        seed_data(client, name, name + " only", (name + " only").encode(), PHOTO[:-1] + str(i))
        assert auth.user_data_dir(config.data_dir, user_id).is_dir()

    for i, (client, _, name) in enumerate(accounts, 2):
        expected_names = {name, name + " only"}
        collections = client.get("/api/collections").json()
        assert {row["name"] for row in collections} == expected_names
        assert {row["record"]["name"] for row in change_records(client) if row["entity"] == "collection"} == (
            expected_names
        )
        assert zip_contents(client.get("/api/exports/all.zip")) == (
            expected_names,
            {record.encode() for record in expected_names},
        )
        assert zip_contents(client.get("/api/exports/collections/shared-room.zip")) == (
            {name},
            {name.encode()},
        )
        for kind, body in (("original", name.encode()), ("thumbnail", b"thumb " + name.encode())):
            path = f"/api/photos/{PHOTO}/{kind}"
            get = client.get(path)
            head = client.head(path)
            assert get.content == body
            assert head.status_code == 200 and not head.content
            assert get.headers["etag"] == head.headers["etag"]
            for response in (get, head):
                assert response.headers["cache-control"] == "private, no-store"
                assert set(response.headers["vary"].split(", ")) == {"Cookie", "X-Capture-Account"}

        for j, (_, other_id, other_name) in enumerate(accounts, 2):
            if i == j:
                continue
            foreign_photo = PHOTO[:-1] + str(j)
            bad_photo = f"/api/photos/{foreign_photo}"
            for kind in ("original", "thumbnail"):
                for method in ("GET", "HEAD", "PUT"):
                    response = client.request(method, f"{bad_photo}/{kind}", headers=HEADERS, content=b"")
                    assert response.status_code == (409 if method == "PUT" and kind == "original" else 404)
                    assert response.headers["cache-control"] == "private, no-store"
            assert client.get(f"/api/exports/collections/{other_name}.zip").status_code == 404
            assert (
                client.delete(
                    f"/api/collections/{other_name}/server-copy",
                    headers={**HEADERS, "X-Confirm-Name": quote(other_name + " only")},
                ).status_code
                == 404
            )
            foreign_batch = collection_mutation("foreign", other_name, "Updated elsewhere")
            foreign_batch["base_revision"] = 1
            assert batch(client, [foreign_batch])[0]["code"] == "missing_parent"
            mismatch = {**HEADERS, "X-Capture-Account": other_id}
            for method, path in (
                ("POST", "/api/sync/batch"),
                ("GET", "/api/sync/changes?schema=2"),
                ("GET", "/api/collections"),
                ("DELETE", "/api/collections/shared-room/server-copy"),
                ("GET", "/api/exports/all.zip"),
                ("GET", "/api/exports/collections/shared-room.zip"),
                ("GET", f"/api/photos/{PHOTO}/original"),
                ("HEAD", f"/api/photos/{PHOTO}/original"),
                ("PUT", f"/api/photos/{PHOTO}/original"),
                ("GET", f"/api/photos/{PHOTO}/thumbnail"),
                ("HEAD", f"/api/photos/{PHOTO}/thumbnail"),
                ("PUT", f"/api/photos/{PHOTO}/thumbnail"),
            ):
                response = client.request(method, path, headers=mismatch)
                assert response.status_code == 409
                if method != "HEAD":
                    assert response.json() == {"detail": "account_mismatch"}

    assert (
        owner.get(
            "/api/collections", headers=[("X-Capture-Account", "owner"), ("X-Capture-Account", alice_id)]
        ).status_code
        == 409
    )
    for client, user_id, name in accounts:
        assert {row["name"] for row in client.get("/api/collections").json()} == {name, name + " only"}
        assert client.get(f"/api/photos/{PHOTO}/original").content == name.encode()
        assert client.get(f"/api/photos/{PHOTO}/thumbnail").content == b"thumb " + name.encode()
        if user_id != "owner":
            with TestClient(owner.app, base_url=ORIGIN, cookies=client.cookies) as unbound:
                assert unbound.get("/api/collections").json() == {"detail": "account_required"}
                assert unbound.get(f"/api/photos/{PHOTO}/original").status_code == 409

    assert (
        alice.delete(
            "/api/collections/shared-room/server-copy",
            headers={**HEADERS, "X-Confirm-Name": "Alice"},
        ).status_code
        == 204
    )
    assert alice.get(f"/api/photos/{PHOTO}/original").status_code == 404
    assert {row["name"] for row in alice.get("/api/collections").json()} == {"Alice only"}
    for client, name in ((owner, "Owner"), (bob, "Bob")):
        assert client.get(f"/api/photos/{PHOTO}/original").content == name.encode()
    stats = {row["id"]: row for row in owner.get("/api/people").json()}
    assert stats[alice_id]["rooms"] == stats[alice_id]["entries"] == stats[alice_id]["photos"] == 1
    assert stats[bob_id]["rooms"] == stats[bob_id]["entries"] == stats[bob_id]["photos"] == 2
    assert stats[alice_id]["last_change_at"] >= stats[bob_id]["last_change_at"]


def test_people_validation_authority_disable_and_agent_access(api):
    owner, config = api
    alice, alice_id = helper(owner, "Alice")
    bob, bob_id = helper(owner, "Bob")
    for method, path in (
        ("GET", "/api/people"),
        ("POST", "/api/people"),
        ("PATCH", f"/api/people/{alice_id}"),
        ("PATCH", f"/api/people/{bob_id}"),
        ("PATCH", "/api/people/owner"),
        ("POST", f"/api/people/{bob_id}/code"),
    ):
        for client in (alice, bob):
            response = client.request(method, path, headers=HEADERS, json={"disabled": True})
            assert response.status_code == 403 and response.json() == {"detail": "owner_required"}
    assert (
        owner.post("/api/people", headers=HEADERS, json={"name": "  aLiCe "}).json()["detail"] == "name_taken"
    )
    for invalid in (" ", "x" * 41, "hello\x00world", 42):
        response = owner.post("/api/people", headers=HEADERS, json={"name": invalid})
        assert response.status_code == 422 and response.json()["detail"] == "invalid_name"
    assert create(owner, "Straße")["name"] == "Straße"
    assert owner.post("/api/people", headers=HEADERS, json={"name": "STRASSE"}).status_code == 409
    assert owner.patch("/api/people/owner", headers=HEADERS, json={"disabled": True}).status_code == 409
    assert owner.post("/api/people/owner/code", headers=HEADERS).status_code == 409
    assert owner.patch("/api/people/unknown", headers=HEADERS, json={"name": "Test"}).status_code == 404
    assert owner.patch(f"/api/people/{bob_id}", headers=HEADERS, json={"disabled": "true"}).status_code == 422
    assert owner.delete(f"/api/people/{bob_id}", headers=HEADERS).status_code == 405
    pending = issue(owner, bob_id)["code"]
    seed_data(bob, "private", "Bob's room", b"Bob")
    response = owner.patch(
        f"/api/people/{bob_id}",
        headers=HEADERS,
        json={
            "name": " Robert ",
            "disabled": True,
        },
    )
    assert response.status_code == 200
    person = response.json()
    assert person["name"] == "Robert" and person["disabled"] is True and person["device_count"] == 0
    assert person["last_seen_at"] and person["rooms"] == person["entries"] == person["photos"] == 1
    assert bob.get("/api/auth/session").json() == {"authenticated": False, "expires_at": None, "user": None}
    for method, path in (
        ("GET", "/api/sync/changes?schema=2"),
        ("POST", "/api/sync/batch"),
        ("GET", "/api/collections"),
        ("DELETE", "/api/collections/private/server-copy"),
        ("GET", "/api/exports/all.zip"),
        ("GET", "/api/exports/collections/private.zip"),
        ("GET", "/api/people"),
        *(
            (method, f"/api/photos/{PHOTO}/{kind}")
            for method in ("GET", "HEAD", "PUT")
            for kind in ("original", "thumbnail")
        ),
    ):
        assert bob.request(method, path, headers=HEADERS).status_code == 401
    assert owner.post(f"/api/people/{bob_id}/code", headers=HEADERS).json()["detail"] == "person_disabled"
    with auth.auth_connect(config.data_dir) as db:
        assert db.execute("SELECT COUNT(*) FROM sessions WHERE user_id=?", (bob_id,)).fetchone()[0] == 0
    assert join(bob, pending).status_code == 401

    users = owner.get(AGENT, headers=BEARER).json()["users"]
    assert {row["id"] for row in users} == {"owner", alice_id, bob_id, create_id(users, "Straße")}
    agent_bob = next(row for row in users if row["id"] == bob_id)
    assert agent_bob["disabled"] and agent_bob["name"] == "Robert" and agent_bob["cursor"] > 0
    path = f"{AGENT}/{bob_id}"
    assert owner.get(path + "/changes", headers=BEARER).json()["changes"][0]["record"]["name"] == "Bob's room"
    assert owner.get(path + "/summary", headers=BEARER).json()["photos"] == 1
    assert owner.get(path + f"/photos/{PHOTO}/original", headers=BEARER).content == b"Bob"
    assert owner.get(f"{AGENT}/{alice_id}/photos/{PHOTO}/original", headers=BEARER).status_code == 404
    assert owner.get(f"{AGENT}/unknown/summary", headers=BEARER).status_code == 404

    assert owner.patch(f"/api/people/{bob_id}", headers=HEADERS, json={"disabled": False}).status_code == 200
    assert bob.get("/api/collections").status_code == 401
    assert join(bob, pending).status_code == 401
    assert join(bob, issue(owner, bob_id)["code"]).status_code == 204
    assert bob.get("/api/auth/session").json()["user"] == {"id": bob_id, "name": "Robert", "is_owner": False}


def create_id(rows, name):
    return next(row["id"] for row in rows if row["name"] == name)


def test_codes_are_single_use_normalized_and_rotated_and_get_does_not_consume(api, monkeypatch):
    owner, config = api
    user_id = create(owner, "Helper")["id"]
    sequence = iter("AAAA0000AAAA000001ABKXYZABCD1234")
    monkeypatch.setattr(auth.secrets, "choice", lambda _: next(sequence))
    first = issue(owner, user_id)
    current = issue(owner, user_id)
    expiry = datetime.fromisoformat(current["expires_at"])
    assert timedelta(minutes=9) < expiry - datetime.now(UTC) <= timedelta(minutes=10)
    config.static_dir.mkdir()
    (config.static_dir / "index.html").write_text("<title>Join</title>")
    assert first["code"] == "AAAA-0000"
    assert current == {**current, "code": "01AB-KXYZ", "url": ORIGIN + "/join#01AB-KXYZ"}
    with TestClient(owner.app, base_url=ORIGIN) as outsider:
        assert join(outsider, first["code"]).json()["detail"] == "invalid_join_code"
        assert outsider.get("/join#01AB-KXYZ").status_code == 200
        assert outsider.post("/api/auth/join", json={"code": current["code"]}).status_code == 403
        assert (
            outsider.post(
                "/api/auth/join",
                headers={**HEADERS, "Origin": "https://other.test"},
                json={"code": current["code"]},
            ).status_code
            == 403
        )
        assert join(outsider, " ol ab – k xyz ", device_label="  iPhone  ").status_code == 204
        assert join(outsider, current["code"]).status_code == 401
    next_code = issue(owner, user_id)["code"]
    with auth.auth_connect(config.data_dir) as db:
        assert db.execute("SELECT device_label,pairing FROM sessions WHERE user_id=?", (user_id,)).fetchone()[
            :
        ] == (
            "iPhone",
            1,
        )
        assert {row[0] for row in db.execute("SELECT code_sha256 FROM join_codes")} == {
            auth.digest(code.replace("-", "")) for code in (first["code"], current["code"], next_code)
        }
        db.execute(
            "UPDATE join_codes SET expires_at=? WHERE code_sha256=?",
            ("2000-01-01T00:00:00.000Z", auth.digest(next_code.replace("-", ""))),
        )
    assert join(owner, next_code).status_code == 401
    assert join(owner, "bad guess").status_code == 401
    assert join(owner, "ZZZZ-ZZZZ").status_code == 401


def test_concurrent_joins_consume_a_code_once(api):
    owner, config = api
    user_id = create(owner, "Helper")["id"]
    code = issue(owner, user_id)["code"]
    barrier = Barrier(2)

    def attempt():
        with TestClient(owner.app, base_url=ORIGIN) as client:
            barrier.wait(timeout=5)
            return join(client, code).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: attempt(), range(2))) == [204, 401]
    with auth.auth_connect(config.data_dir) as db:
        assert db.execute("SELECT COUNT(*) FROM sessions WHERE user_id=?", (user_id,)).fetchone()[0] == 1


def test_join_limits_are_per_ip_and_global_and_do_not_consume_codes(api):
    owner, config = api
    user_id = create(owner, "Helper")["id"]
    code = issue(owner, user_id)["code"]
    with TestClient(owner.app, base_url=ORIGIN) as client:
        for _ in range(10):
            assert join(client, "bad-code").status_code == 401
        blocked = join(client, code)
        assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
        for i in range(90):
            response = client.post(
                "/api/auth/join",
                headers={**HEADERS, "X-Forwarded-For": f"192.0.2.{i + 1}"},
                json={"code": "bad-code"},
            )
            assert response.status_code == 401
        assert (
            client.post(
                "/api/auth/join", headers={**HEADERS, "X-Forwarded-For": "192.0.2.250"}, json={"code": code}
            ).status_code
            == 429
        )
        with auth.auth_connect(config.data_dir) as db:
            assert db.execute("SELECT COUNT(*) FROM login_attempts WHERE kind='join'").fetchone()[0] == 100
            db.execute("UPDATE login_attempts SET at=?", ("2000-01-01T00:00:00.000Z",))
        assert join(client, code).status_code == 204


@pytest.mark.parametrize("streamed", [False, True])
def test_sync_batch_rejects_requests_larger_than_eight_mib(api, streamed):
    owner, _ = api
    prefix = b'{"schema":2,"mutations":[]}'
    limit = 8 * 1024 * 1024
    assert (
        owner.post("/api/sync/batch", headers=HEADERS, content=prefix.ljust(limit, b" ")).status_code == 200
    )
    payload = prefix.ljust(limit + 1, b" ")
    response = owner.post(
        "/api/sync/batch", headers=HEADERS, content=iter([payload]) if streamed else payload
    )
    assert response.status_code == 413
    assert response.json()["detail"] == "request_too_large"


def test_owner_password_limit_is_per_ip_only(api):
    owner, config = api
    blocked_ip = "192.0.2.1"
    at = auth.timestamp(datetime.now(UTC))
    with auth.auth_connect(config.data_dir) as db:
        db.executemany(
            "INSERT INTO login_attempts VALUES('password',?,?)",
            [(blocked_ip, at)] * 5 + [(f"192.0.2.{i}", at) for i in range(2, 97)],
        )
    with TestClient(owner.app, base_url=ORIGIN) as client:
        url = "/api/auth/login"
        credentials = {"password": "test-password"}
        blocked = client.post(url, headers={**HEADERS, "X-Forwarded-For": blocked_ip}, json=credentials)
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "30"
        assert (
            client.post(
                url, headers={**HEADERS, "X-Forwarded-For": "192.0.2.250"}, json=credentials
            ).status_code
            == 204
        )


def test_startup_isolates_unavailable_helper_databases(tmp_path, caplog):
    config = configuration(tmp_path)
    with TestClient(create_app(config), base_url=ORIGIN) as owner:
        assert (
            owner.post("/api/auth/login", headers=HEADERS, json={"password": "test-password"}).status_code
            == 204
        )
        broken, broken_id = helper(owner, "Broken")
        healthy, healthy_id = helper(owner, "Healthy")
        broken_code = issue(owner, broken_id)["code"]
        tokens = [client.cookies["kc_session"] for client in (owner, broken, healthy)]
    (auth.user_data_dir(config.data_dir, broken_id) / "capture.sqlite3").write_bytes(b"corrupt database")
    with TestClient(create_app(config), base_url=ORIGIN) as client:
        assert broken_id in caplog.text
        assert client.get("/api/health").status_code == 200
        for user_id, token in zip(("owner", broken_id, healthy_id), tokens, strict=True):
            client.cookies.set("kc_session", token)
            for path in ("/api/auth/session", "/api/collections"):
                response = client.get(path, headers={"X-Capture-Account": user_id})
                if user_id == broken_id:
                    assert response.status_code == 503
                    assert response.json()["detail"] == "account_unavailable"
                else:
                    assert response.status_code == 200
        assert join(client, broken_code).status_code == 503
        assert client.get("/api/auth/session").json()["user"]["id"] == healthy_id
    with auth.auth_connect(config.data_dir) as db:
        assert (
            db.execute(
                "SELECT consumed_at FROM join_codes WHERE code_sha256=?",
                (auth.digest(auth.normalize_code(broken_code)),),
            ).fetchone()[0]
            is None
        )


def test_startup_keeps_legacy_sessions_and_migrates_every_database(tmp_path):
    config = configuration(tmp_path)
    root = config.data_dir
    run_migrations(root)
    legacy_token = "owner-fresh-legacy-token"
    expired_token = "owner-expired-legacy-token"
    now = datetime.now(UTC)
    with connect(root) as db:
        db.execute("INSERT INTO meta VALUES('owner_data','preserved')")
        for token, expiry in ((legacy_token, now + timedelta(days=20)), (expired_token, now)):
            db.execute(
                "INSERT INTO sessions VALUES(?,?,?)",
                (auth.digest(token), auth.timestamp(now - timedelta(days=10)), auth.timestamp(expiry)),
            )
    owner = {"id": "owner", "name": "Owner", "is_owner": True}
    with TestClient(create_app(config), base_url=ORIGIN, cookies={"kc_session": legacy_token}) as client:
        assert client.get("/api/auth/session").json()["user"] == owner
        assert client.get("/api/collections").status_code == 200
        with auth.auth_connect(root) as db:
            assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
        assert client.get("/api/people").json()[0]["device_count"] == 1
        people = [create(client, name) for name in ("Anna", "Ben")]
        assert (
            client.patch(
                f"/api/people/{people[1]['id']}", headers=HEADERS, json={"disabled": True}
            ).status_code
            == 200
        )
        directories = [auth.user_data_dir(root, person["id"]) for person in people]
        assert client.post("/api/auth/logout", headers=HEADERS).status_code == 204
        with connect(root) as db:
            assert db.execute("SELECT value FROM meta WHERE key='owner_data'").fetchone()[0] == "preserved"
            assert (
                db.execute(
                    "SELECT 1 FROM sessions WHERE token_sha256=?", (auth.digest(legacy_token),)
                ).fetchone()
                is None
            )
    migration = "0005_removal_timestamp.sql"
    for directory in [root, *directories]:
        with connect(directory) as db:
            db.execute("ALTER TABLE changes DROP COLUMN changed_at")
            db.execute("DELETE FROM schema_migrations WHERE version=?", (migration,))
    with TestClient(create_app(config), base_url=ORIGIN, cookies={"kc_session": legacy_token}) as client:
        assert client.get("/api/auth/session").json()["authenticated"] is False
        with auth.auth_connect(root) as db:
            assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
        for directory in [root, *directories]:
            with connect(directory) as db:
                assert db.execute("SELECT 1 FROM schema_migrations WHERE version=?", (migration,)).fetchone()


def test_owner_and_helper_sliding_expiry_differ(api):
    owner, config = api
    client, user_id = helper(owner, "Alice")
    current = datetime.now(UTC)
    for session_client, account, before, after, database in (
        (owner, "owner", 14, 30, connect),
        (client, user_id, 149, 180, auth.auth_connect),
    ):
        old_expiry = auth.timestamp(current + timedelta(days=before))
        token_hash = auth.digest(session_client.cookies["kc_session"])
        with database(config.data_dir) as db:
            assert (
                db.execute(
                    "UPDATE sessions SET expires_at=? WHERE token_sha256=?", (old_expiry, token_hash)
                ).rowcount
                == 1
            )
        response = session_client.get("/api/collections")
        assert response.status_code == 200
        assert "set-cookie" not in response.headers
        with database(config.data_dir) as db:
            assert (
                db.execute("SELECT expires_at FROM sessions WHERE token_sha256=?", (token_hash,)).fetchone()[
                    0
                ]
                == old_expiry
            )
        renewed = session_client.get("/api/auth/session")
        assert renewed.json()["user"]["id"] == account
        expiry = datetime.fromisoformat(renewed.json()["expires_at"])
        assert timedelta(days=after - 1) < expiry - current < timedelta(days=after + 1)
        assert f"Max-Age={after * 86400}" in renewed.headers["set-cookie"]
        assert "set-cookie" not in session_client.get("/api/auth/session").headers
        with database(config.data_dir) as db:
            assert (
                db.execute("SELECT expires_at FROM sessions WHERE token_sha256=?", (token_hash,)).fetchone()[
                    0
                ]
                == renewed.json()["expires_at"]
            )


def test_sessions_created_or_revoked_by_the_rollback_image_take_effect(api):
    owner, config = api
    key = auth.digest(owner.cookies["kc_session"])
    legacy_token = "token-from-rollback-image"
    current = datetime.now(UTC)
    with connect(config.data_dir) as db:
        assert db.execute("DELETE FROM sessions WHERE token_sha256=?", (key,)).rowcount == 1
        db.execute(
            "INSERT INTO sessions VALUES(?,?,?)",
            (
                auth.digest(legacy_token),
                auth.timestamp(current),
                auth.timestamp(current + timedelta(days=30)),
            ),
        )
    assert owner.get("/api/collections").status_code == 401
    with TestClient(owner.app, base_url=ORIGIN, cookies={"kc_session": legacy_token}) as older_browser:
        assert older_browser.get("/api/auth/session").json()["user"]["id"] == "owner"


def test_logout_suppresses_prepared_session_renewal(api, monkeypatch):
    owner, config = api
    token = owner.cookies["kc_session"]
    with connect(config.data_dir) as db:
        db.execute(
            "UPDATE sessions SET expires_at=? WHERE token_sha256=?",
            (auth.timestamp(datetime.now(UTC) + timedelta(days=1)), auth.digest(token)),
        )
    send_response = JSONResponse.__call__

    def logout():
        with TestClient(owner.app, base_url=ORIGIN, cookies={"kc_session": token}) as browser:
            assert browser.post("/api/auth/logout", headers=HEADERS).status_code == 204

    async def logout_before_renewal_is_sent(response, scope, receive, send):
        if scope["path"] == "/api/auth/session" and "set-cookie" in response.headers:
            await anyio.to_thread.run_sync(logout)
        await send_response(response, scope, receive, send)

    monkeypatch.setattr(JSONResponse, "__call__", logout_before_renewal_is_sent)
    response = owner.get("/api/auth/session")
    assert response.status_code == 200
    assert response.json() == {"authenticated": False, "expires_at": None, "user": None}
    assert "set-cookie" not in response.headers


def test_signing_in_as_helper_rotates_the_browser_session_and_rejects_its_old_binding(api):
    owner, config = api
    user_id = create(owner, "Helper")["id"]
    code = issue(owner, user_id)["code"]
    with TestClient(owner.app, base_url=ORIGIN, headers={"X-Capture-Account": "owner"}) as browser:
        assert (
            browser.post("/api/auth/login", headers=HEADERS, json={"password": "test-password"}).status_code
            == 204
        )
        original = browser.cookies["kc_session"]
        assert browser.get("/api/collections").status_code == 200
        assert join(browser, code).status_code == 204
        assert browser.cookies["kc_session"] != original
        assert browser.get("/api/auth/session").json()["user"]["id"] == user_id
        assert browser.get("/api/collections").json() == {"detail": "account_mismatch"}
        assert browser.get("/api/collections", headers={"X-Capture-Account": user_id}).json() == []
    with connect(config.data_dir) as db:
        assert (
            db.execute("SELECT 1 FROM sessions WHERE token_sha256=?", (auth.digest(original),)).fetchone()
            is None
        )
    assert owner.get("/api/auth/session").json()["user"]["id"] == "owner"


@pytest.mark.parametrize("endpoint", ["login", "join"])
def test_auth_limits_streamed_bodies_and_throttles_before_reading(api, monkeypatch, endpoint):
    owner, config = api
    payload = [b'{"unused":"', b"x" * 4096, b'"}']
    read = []
    stream = Request.stream

    async def measured_stream(request):
        async for chunk in stream(request):
            if chunk:
                read.append(chunk)
            yield chunk

    monkeypatch.setattr(Request, "stream", measured_stream)
    url = f"/api/auth/{endpoint}"
    # TestClient coalesces this iterator into a body. Omit Content-Length to
    # exercise the receive-side limit instead of the header check.
    oversized = owner.post(url, headers=HEADERS, content=iter(payload))
    assert oversized.status_code == 413 and oversized.json()["detail"] == "request_too_large"
    assert read
    kind, limit = ("password", 5) if endpoint == "login" else ("join", 10)
    ip = "192.0.2.11"
    with auth.auth_connect(config.data_dir) as db:
        db.executemany(
            "INSERT INTO login_attempts VALUES(?,?,?)",
            [(kind, ip, auth.timestamp(datetime.now(UTC)))] * limit,
        )
    read.clear()
    limited = owner.post(url, headers={**HEADERS, "X-Forwarded-For": ip}, content=b"invalid json")
    assert limited.status_code == 429
    assert read == []


def test_password_verification_has_one_in_flight_check(tmp_path, monkeypatch):
    config = configuration(tmp_path).model_copy(update={"password_hash": "test-hash"})
    entered = Event()
    release = Event()

    def verify(_hasher, _hash, password):
        if password == "first":
            entered.set()
            assert release.wait(5)
        return False

    monkeypatch.setattr(auth.PasswordHasher, "verify", verify)
    url = "/api/auth/login"
    with TestClient(create_app(config), base_url=ORIGIN) as client, ThreadPoolExecutor(1) as pool:
        first = pool.submit(client.post, url, headers=HEADERS, json={"password": "first"})
        try:
            assert entered.wait(5)
            second = client.post(url, headers=HEADERS, json={"password": "second"})
            assert second.status_code == 429
        finally:
            release.set()
        assert first.result().status_code == 401


@pytest.mark.parametrize("operation", ["batch", "original", "thumbnail"])
def test_disabling_helper_blocks_inflight_writes(api, monkeypatch, operation):
    owner, config = api
    client, user_id = helper(owner, "Alice")
    data = b"original data"
    root = auth.user_data_dir(config.data_dir, user_id)
    if operation == "batch":
        method, path = "POST", "/api/sync/batch"
        data = json.dumps({"schema": 2, "mutations": [collection_mutation()]}).encode()
    else:
        seed_data(client, "private", "Alice's room", data)
        with connect(root) as db:
            db.execute("UPDATE photos SET stored_at=NULL,thumb_stored_at=NULL,storage_key=NULL")
        for file in (root / "media").rglob(PHOTO):
            file.unlink()
        method, path = "PUT", f"/api/photos/{PHOTO}/{operation}"
    stream = Request.stream

    def disable():
        response = owner.patch(f"/api/people/{user_id}", headers=HEADERS, json={"disabled": True})
        assert response.status_code == 200

    async def disable_after_body(request):
        async for chunk in stream(request):
            if chunk and request.url.path == path:
                await anyio.to_thread.run_sync(disable)
            yield chunk

    monkeypatch.setattr(Request, "stream", disable_after_body)
    response = client.request(
        method,
        path,
        headers={
            **HEADERS,
            "Content-Type": "image/jpeg",
            "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
        },
        content=data,
    )
    assert response.status_code == 401
    with connect(root) as db:
        assert db.execute("SELECT id FROM collections WHERE id='c1'").fetchone() is None
        assert (
            db.execute(
                "SELECT COUNT(*) FROM photos WHERE stored_at IS NOT NULL OR thumb_stored_at IS NOT NULL"
            ).fetchone()[0]
            == 0
        )
    assert not any(path.is_file() for path in (root / "media").rglob("*"))


@pytest.mark.parametrize(
    ("path", "response_type"),
    [(f"/api/photos/{PHOTO}/original", FileResponse), ("/api/exports/all.zip", StreamingResponse)],
)
def test_disabling_helper_blocks_protected_stream_before_response_start(
    api, monkeypatch, path, response_type
):
    owner, _ = api
    client, user_id = helper(owner, "Alice")
    seed_data(client, "private", "Alice's room", b"private original")
    start = response_type.__call__

    def disable():
        response = owner.patch(f"/api/people/{user_id}", headers=HEADERS, json={"disabled": True})
        assert response.status_code == 200

    async def disable_after_response_prepared(response, scope, receive, send):
        if scope["path"] == path:
            await anyio.to_thread.run_sync(disable)
        await start(response, scope, receive, send)

    monkeypatch.setattr(response_type, "__call__", disable_after_response_prepared)
    result = client.get(path)
    assert result.status_code == 401
    assert result.json()["detail"] == "auth_required"
