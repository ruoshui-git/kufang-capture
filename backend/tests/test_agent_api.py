import hashlib
import zlib

import pytest
from fastapi.testclient import TestClient

from kufang_capture import agent_api
from kufang_capture.db import connect
from kufang_capture.main import create_app
from kufang_capture.settings import Settings

ROOT = "/api/agent/v1/users"
OWNER = ROOT + "/owner"
TOKEN = "agent-test-token"
DIGEST = hashlib.sha256(TOKEN.encode()).hexdigest()
BEARER = {"Authorization": f"Bearer {TOKEN}"}
CSRF = {"X-Capture-Request": "1"}
AT = "2026-11-25T10:00:00.000Z"
PHOTO = "01J00000000000000000000001"
MISSING = "01J00000000000000000000002"
DELETED = "01J00000000000000000000003"
BYTES = b"original bytes"
SHA = hashlib.sha256(BYTES).hexdigest()


def make_client(tmp_path, digest=DIGEST):
    config = Settings(
        data_dir=tmp_path / "data",
        static_dir=tmp_path / "static",
        public_origin="http://127.0.0.1",
        dev_password="test-password",
        agent_token_sha256=digest,
        app_version="test",
    )
    return TestClient(create_app(config), base_url=config.public_origin)


@pytest.mark.parametrize("digest", [None, "", DIGEST.upper(), DIGEST + "\n", "g" * 64])
def test_disabled_agent(tmp_path, digest):
    with make_client(tmp_path, digest) as client:
        for method in ("GET", "HEAD", "POST"):
            assert client.request(method, ROOT, headers=BEARER).status_code == 404


def test_agent_auth_and_read_only_methods(tmp_path):
    with make_client(tmp_path) as client:
        assert (
            client.post(
                "/api/auth/login", json={"password": "test-password"}, headers={"X-Capture-Request": "1"}
            ).status_code
            == 204
        )
        for path in (ROOT, OWNER + "/changes", OWNER + "/summary", OWNER + "/photos/bad/original"):
            response = client.get(path)
            assert response.status_code == 401
            assert response.json() == {"detail": "agent_auth_required"}
        response = client.get(ROOT, headers={"Authorization": "Bearer wrong"})
        assert response.status_code == 401
        for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"):
            response = client.request(method, OWNER + "/changes", headers=BEARER)
            assert response.status_code == 405
            assert response.headers["allow"] == "GET, HEAD"
        assert client.get(ROOT, headers=BEARER).json() == {
            "schema": 1,
            "server_version": "test",
            "users": [{"id": "owner", "name": "Owner", "disabled": False, "cursor": 0}],
        }
        assert client.head(ROOT, headers=BEARER).content == b""
        assert client.get(ROOT + "/unknown/changes", headers=BEARER).status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/sync/batch"),
        ("GET", "/api/sync/changes?schema=2"),
        ("PUT", f"/api/photos/{PHOTO}/original"),
        ("GET", f"/api/photos/{PHOTO}/original"),
        ("HEAD", f"/api/photos/{PHOTO}/original"),
        ("PUT", f"/api/photos/{PHOTO}/thumbnail"),
        ("GET", f"/api/photos/{PHOTO}/thumbnail"),
        ("GET", "/api/collections"),
        ("DELETE", "/api/collections/c1/server-copy"),
        ("GET", "/api/exports/all.zip"),
        ("GET", "/api/exports/collections/c1.zip"),
        ("GET", "/api/unknown"),
    ],
)
def test_bearer_does_not_authorize_app_routes(tmp_path, method, path):
    with make_client(tmp_path) as client:
        assert client.request(method, path, headers={**BEARER, **CSRF}).status_code == 401


def test_agent_rate_limit_is_separate_from_login(tmp_path):
    with make_client(tmp_path) as client:
        wrong = {"Authorization": "Bearer wrong", "X-Forwarded-For": "192.0.2.1"}
        for _ in range(5):
            assert client.get(ROOT, headers=wrong).status_code == 401
        response = client.get(ROOT, headers={**wrong, "X-Forwarded-For": "192.0.2.2, 192.0.2.1"})
        assert response.status_code == 429
        assert 1 <= int(response.headers["retry-after"]) <= 60
        assert client.get(ROOT, headers={**wrong, "X-Forwarded-For": "192.0.2.2"}).status_code == 401
        assert client.get(ROOT, headers={**wrong, **BEARER}).status_code == 200
        assert not client.get("/api/auth/session", headers=BEARER).json()["authenticated"]
        assert (
            client.post("/api/auth/login", headers={**wrong, **CSRF}, json={"password": TOKEN}).status_code
            == 401
        )
        assert (
            client.post(
                "/api/auth/login", headers={**wrong, **CSRF}, json={"password": "test-password"}
            ).status_code
            == 204
        )


def seed_records(data_dir):
    key = f"media/originals/{PHOTO[:2]}/{PHOTO}"
    original = data_dir / key
    original.parent.mkdir(parents=True)
    original.write_bytes(BYTES)
    with connect(data_dir) as db:
        db.executemany(
            "INSERT INTO collections(id,name,status,storage_mode,created_at,updated_at) "
            "VALUES(?,?,'active','synced',?,?)",
            [("c1", "Room A", AT, AT), ("c2", "Room B", AT, AT)],
        )
        db.executemany(
            "INSERT INTO items(id,review_status,created_at,updated_at) VALUES(?,'draft',?,?)",
            [("i1", AT, AT), ("i2", AT, AT)],
        )
        db.executemany(
            "INSERT INTO entries(id,collection_id,item_id,sequence_number,deleted_at,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            [
                ("e1", "c1", "i1", 1, None, AT, AT),
                ("e2", "c2", "i1", 3, None, AT, AT),
                ("e3", "c1", "i2", 2, AT, AT, AT),
            ],
        )
        db.executemany(
            "INSERT INTO photos(id,item_id,mime_type,byte_size,sha256,crc32,captured_at,capture_source,"
            "created_at,updated_at,deleted_at,stored_at,storage_key) "
            "VALUES(?,?,'image/jpeg',?,?,?,?,'native_camera',?,?,?,?,?)",
            [
                (pid, iid, len(BYTES), SHA, zlib.crc32(BYTES), AT, AT, AT, deleted, stored, path)
                for pid, iid, deleted, stored, path in (
                    (PHOTO, "i1", None, AT, key),
                    (MISSING, "i1", None, None, None),
                    (DELETED, "i1", AT, None, None),
                    ("01J00000000000000000000004", "i2", None, None, None),
                )
            ],
        )
    return original


def test_photos_get_head_missing_and_traversal(tmp_path):
    with make_client(tmp_path) as client:
        original = seed_records(tmp_path / "data")
        for method, body in (("GET", BYTES), ("HEAD", b"")):
            response = client.request(method, f"{OWNER}/photos/{PHOTO}/original", headers=BEARER)
            assert response.status_code == 200
            assert response.content == body
            assert response.headers["etag"] == f'"{SHA}"'
            assert response.headers["content-type"] == "image/jpeg"
            assert response.headers["content-length"] == str(len(BYTES))
            assert response.headers["x-content-sha256"] == SHA
            assert response.headers["cache-control"] == "no-store"
            assert (
                client.request(method, f"{OWNER}/photos/{MISSING}/original", headers=BEARER).status_code
                == 404
            )

        for pid in ("%2e%2e", "%2e%2e%2f%2e%2e", PHOTO.lower(), "8" + PHOTO[1:], "x"):
            assert client.get(f"{OWNER}/photos/{pid}/original", headers=BEARER).status_code == 404

        original.unlink()
        response = client.get(f"{OWNER}/photos/{PHOTO}/original", headers=BEARER)
        assert response.status_code == 404
        assert response.json() == {"detail": "photo_not_stored"}


def test_changes_paging_dedupes_and_preserves_tombstones(tmp_path):
    with make_client(tmp_path) as client:
        data = tmp_path / "data"
        seed_records(data)
        with connect(data) as db:
            db.executemany(
                "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES(?,?,'',?)",
                [
                    ("entry", "e3", "upsert"),
                    ("photo", PHOTO, "upsert"),
                    ("entry", "e3", "delete"),
                    ("photo", PHOTO, "upsert"),
                    ("photo", DELETED, "delete"),
                    ("photo", "gone", "purged"),
                    ("collection", "gone", "removed"),
                    ("entry", "absent", "upsert"),
                ],
            )
        first = client.get(OWNER + "/changes?cursor=-10&limit=3", headers=BEARER).json()
        assert first["schema"] == 1
        assert first["server_time"].endswith("Z")
        assert (first["cursor"], first["has_more"], first["latest"]) == (3, True, 8)
        photo, entry = first["changes"]
        assert (photo["seq"], entry["seq"]) == (2, 3)
        assert photo["record"]["stored_at"] == AT
        assert photo["record"]["server_storage_key"] == f"media/originals/{PHOTO[:2]}/{PHOTO}"
        assert "storage_key" not in photo["record"]
        assert photo["record"]["revision"] == 1
        assert entry["record"]["deleted_at"] == AT
        last = client.get(OWNER + "/changes?cursor=3&limit=50000", headers=BEARER).json()
        assert (last["cursor"], last["has_more"], last["latest"]) == (8, False, 8)
        assert last["changes"][0]["id"] == PHOTO
        assert last["changes"][1]["record"]["deleted_at"] == AT
        assert last["changes"][2:] == [
            {"seq": 6, "entity": "photo", "id": "gone", "purged": True},
            {"seq": 7, "entity": "collection", "id": "gone", "removed": True},
            {"seq": 8, "entity": "entry", "id": "absent", "purged": True},
        ]
        assert client.get(OWNER + "/changes?limit=0", headers=BEARER).json()["cursor"] == 1
        assert client.get(OWNER + "/changes?cursor=8", headers=BEARER).json()["changes"] == []
        response = client.get(OWNER + "/changes?cursor=9", headers=BEARER)
        assert response.status_code == 409
        assert response.json() == {"detail": "cursor_ahead"}
        assert client.get(ROOT, headers=BEARER).json()["users"][0]["cursor"] == 8


def test_changes_uses_a_single_read_snapshot(tmp_path, monkeypatch):
    with make_client(tmp_path) as client:
        data = tmp_path / "data"
        seed_records(data)
        with connect(data) as db:
            db.execute(
                "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES('item','i1','','upsert')"
            )
        latest = agent_api.latest_cursor

        def write_concurrently(db):
            cursor = latest(db)
            with connect(data) as writer:
                writer.execute("UPDATE items SET title='Changed', revision=2 WHERE id='i1'")
                writer.execute(
                    "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES('item','i1','','upsert')"
                )
            return cursor

        monkeypatch.setattr(agent_api, "latest_cursor", write_concurrently)
        page = client.get(OWNER + "/changes", headers=BEARER).json()
        assert (page["latest"], page["cursor"], page["has_more"]) == (1, 1, False)
        assert len(page["changes"]) == 1
        assert page["changes"][0]["record"]["revision"] == 1
        assert page["changes"][0]["record"]["title"] == ""


def test_summary_counts_shared_photos_once_and_caps_details(tmp_path):
    with make_client(tmp_path) as client:
        assert client.get(OWNER + "/summary", headers=BEARER).json()["last_change_at"] is None
        data = tmp_path / "data"
        seed_records(data)
        summary = client.get(OWNER + "/summary", headers=BEARER).json()
        assert summary == {
            "collections": 2,
            "items": 2,
            "entries": 2,
            "deleted_entries": 1,
            "photos": 3,
            "deleted_photos": 1,
            "missing_originals": 1,
            "missing_originals_details": [
                {
                    "photo_id": MISSING,
                    "item_id": "i1",
                    "entries": [
                        {"collection_name": "Room A", "sequence_number": 1},
                        {"collection_name": "Room B", "sequence_number": 3},
                    ],
                }
            ],
            "last_change_at": AT,
        }
        with connect(data) as db:
            db.executemany(
                "INSERT INTO photos(id,item_id,mime_type,byte_size,sha256,crc32,captured_at,capture_source,"
                "created_at,updated_at) VALUES(?,'i1','image/jpeg',1,?,0,?,'native_camera',?,?)",
                [(f"extra{i:03}", SHA, AT, AT, AT) for i in range(201)],
            )
        summary = client.get(OWNER + "/summary", headers=BEARER).json()
        assert summary["missing_originals"] == 202
        assert len(summary["missing_originals_details"]) == 200


def test_changes_limits_number_of_log_rows_before_deduplication(tmp_path):
    with make_client(tmp_path) as client:
        with connect(tmp_path / "data") as db:
            db.executemany(
                "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES('photo',?,'','purged')",
                [("gone",)] * 1001,
            )
        page = client.get(OWNER + "/changes?limit=1001", headers=BEARER).json()
        assert (page["cursor"], page["has_more"], page["latest"]) == (1000, True, 1001)
        assert page["changes"] == [{"seq": 1000, "entity": "photo", "id": "gone", "purged": True}]
