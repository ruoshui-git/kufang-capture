import hashlib
import json
import subprocess
import sys
import time
import zipfile
import zlib
from pathlib import Path

from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from kufang_capture import photos
from kufang_capture.main import create_app
from kufang_capture.settings import Settings

HEADERS = {"X-Capture-Request": "1", "Origin": "http://127.0.0.1"}


def make_client(tmp_path, **settings):
    config_values = {
        "data_dir": tmp_path / "data",
        "static_dir": tmp_path / "static",
        "public_origin": "http://127.0.0.1",
        "dev_password": "test-password",
        "min_free_bytes": 0,
        **settings,
    }
    config = Settings(**config_values)
    client = TestClient(create_app(config), base_url="http://127.0.0.1")
    client.__enter__()
    response = client.post("/api/auth/login", json={"password": "test-password"}, headers=HEADERS)
    assert response.status_code == 204
    return client


def collection_mutation(mid="m-c", cid="c1", name="Room A"):
    return {
        "id": mid,
        "entity": "collection",
        "entity_id": cid,
        "collection_id": cid,
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": cid,
            "name": name,
            "description": "",
            "status": "active",
            "storage_mode": "synced",
            "next_sequence_number": 1,
            "sort_order": None,
            "sync_consented_at": None,
            "last_exported_at": None,
            "archived_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }


def entry_mutation(mid="m-e", eid="e1", cid="c1", sequence=1):
    return {
        "id": mid,
        "entity": "entry",
        "entity_id": eid,
        "collection_id": cid,
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": eid,
            "collection_id": cid,
            "sequence_number": sequence,
            "title": "",
            "quantity": None,
            "unit": "",
            "count_detail": "",
            "notes": "",
            "expiration_date": None,
            "dimensions": "",
            "review_status": "draft",
            "deleted_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }


def test_login_session_csrf_and_logout(tmp_path):
    client = make_client(tmp_path)
    assert client.get("/api/auth/session").json()["authenticated"] is True
    assert client.cookies.get("kc_session")
    http_login = client.post("/api/auth/login", json={"password": "test-password"}, headers=HEADERS)
    assert "Secure" not in http_login.headers["set-cookie"]
    assert client.post("/api/auth/logout", headers=HEADERS).status_code == 204
    assert client.get("/api/auth/session").json() == {"authenticated": False, "expires_at": None}
    assert client.get("/api/collections").status_code == 401
    assert client.post("/api/auth/login", json={"password": "wrong"}, headers=HEADERS).status_code == 401
    csrf = client.post("/api/auth/login", json={"password": "test-password"})
    assert csrf.status_code == 403
    wrong_origin = client.post(
        "/api/auth/login",
        json={"password": "test-password"},
        headers={"X-Capture-Request": "1", "Origin": "https://attacker.example"},
    )
    assert wrong_origin.status_code == 403
    client.close()


def test_login_backoff_and_secure_cookie_flags(tmp_path):
    config = Settings(
        data_dir=tmp_path / "data",
        public_origin="http://127.0.0.1",
        dev_password="test-password",
    )
    with TestClient(create_app(config), base_url="http://127.0.0.1") as client:
        headers = {"X-Capture-Request": "1", "Origin": config.public_origin}
        for _ in range(5):
            assert (
                client.post("/api/auth/login", json={"password": "wrong"}, headers=headers).status_code == 401
            )
        limited = client.post("/api/auth/login", json={"password": "test-password"}, headers=headers)
        assert limited.status_code == 429
        assert int(limited.headers["retry-after"]) >= 30

    secure = Settings(
        data_dir=tmp_path / "secure-data",
        public_origin="https://capture.example",
        password_hash=PasswordHasher().hash("test-password"),
    )
    with TestClient(create_app(secure), base_url="https://capture.example") as client:
        response = client.post(
            "/api/auth/login",
            json={"password": "test-password"},
            headers={"X-Capture-Request": "1", "Origin": secure.public_origin},
        )
        assert response.status_code == 204
        cookie = response.headers["set-cookie"]
        assert cookie.startswith("__Host-kc_session=")
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Secure" in cookie
        assert "Path=/" in cookie


def test_sync_conflicts_next_sequence_restore_purge_and_missing_parent(tmp_path):
    client = make_client(tmp_path)
    client.post(
        "/api/sync/batch", json={"mutations": [collection_mutation(), entry_mutation()]}, headers=HEADERS
    )
    missing = entry_mutation("m-orphan", "orphan", "missing-collection")
    assert (
        client.post("/api/sync/batch", json={"mutations": [missing]}, headers=HEADERS).json()["results"][0][
            "code"
        ]
        == "missing_parent"
    )

    title_update = {
        "id": "m-title",
        "entity": "entry",
        "entity_id": "e1",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": 1,
        "fields": {"title": "Latest local title"},
    }
    applied = client.post("/api/sync/batch", json={"mutations": [title_update]}, headers=HEADERS).json()[
        "results"
    ][0]
    assert applied["record"]["title"] == "Latest local title"
    conflict = {**title_update, "id": "m-conflict", "fields": {"title": "Older value"}}
    conflict_result = client.post("/api/sync/batch", json={"mutations": [conflict]}, headers=HEADERS).json()[
        "results"
    ][0]
    assert conflict_result["code"] == "field_conflict"
    assert conflict_result["conflicting_fields"] == ["title"]

    merge_sequence = {
        "id": "m-seq-max",
        "entity": "collection",
        "entity_id": "c1",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": 1,
        "fields": {"next_sequence_number": 12},
    }
    merged = client.post("/api/sync/batch", json={"mutations": [merge_sequence]}, headers=HEADERS).json()[
        "results"
    ][0]
    assert merged["record"]["next_sequence_number"] == 12
    lower = {**merge_sequence, "id": "m-seq-lower", "fields": {"next_sequence_number": 3}}
    assert (
        client.post("/api/sync/batch", json={"mutations": [lower]}, headers=HEADERS).json()["results"][0][
            "record"
        ]["next_sequence_number"]
        == 12
    )

    delete = {**title_update, "id": "m-delete", "op": "delete", "base_revision": 2, "fields": {}}
    deleted = client.post("/api/sync/batch", json={"mutations": [delete]}, headers=HEADERS).json()["results"][
        0
    ]
    assert deleted["record"]["deleted_at"]
    restore = {**delete, "id": "m-restore", "op": "restore", "base_revision": 3}
    restored = client.post("/api/sync/batch", json={"mutations": [restore]}, headers=HEADERS).json()[
        "results"
    ][0]
    assert restored["record"]["deleted_at"] is None
    purge = {**delete, "id": "m-purge", "op": "delete", "base_revision": 4}
    client.post("/api/sync/batch", json={"mutations": [purge]}, headers=HEADERS)
    purge["id"] = "m-purge-final"
    purge["op"] = "purge"
    result = client.post("/api/sync/batch", json={"mutations": [purge]}, headers=HEADERS).json()["results"][0]
    assert result["status"] == "applied"
    changes = client.get("/api/sync/changes?cursor=0&limit=1").json()
    next_page = client.get(f"/api/sync/changes?cursor={changes['cursor']}&limit=500").json()
    assert next_page["changes"][-1].get("purged") is True
    client.close()


def test_thousand_entries_sync_in_contract_sized_batches(tmp_path):
    client = make_client(tmp_path)
    client.post("/api/sync/batch", json={"mutations": [collection_mutation()]}, headers=HEADERS)
    started = time.monotonic()
    for base in range(0, 1000, 200):
        batch = [entry_mutation(f"m-{i}", f"e{i}", sequence=i + 1) for i in range(base, base + 200)]
        response = client.post("/api/sync/batch", json={"mutations": batch}, headers=HEADERS)
        assert response.status_code == 200
        assert all(item["status"] == "applied" for item in response.json()["results"])
    assert time.monotonic() - started < 5
    assert client.get("/api/collections").json()[0]["entry_count"] == 1000
    client.close()


def test_sync_create_duplicate_sequence_and_changes(tmp_path):
    client = make_client(tmp_path)
    first = collection_mutation()
    response = client.post("/api/sync/batch", json={"device_id": "d1", "mutations": [first]}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "applied"
    duplicate = client.post(
        "/api/sync/batch", json={"device_id": "d1", "mutations": [first]}, headers=HEADERS
    )
    assert duplicate.json()["results"][0]["status"] == "duplicate"
    created = client.post(
        "/api/sync/batch",
        json={"device_id": "d1", "mutations": [entry_mutation(), entry_mutation("m-e2", "e2")]},
        headers=HEADERS,
    ).json()["results"]
    assert created[0]["status"] == "applied"
    assert created[1]["code"] == "sequence_taken"
    pull = client.get("/api/sync/changes?cursor=0&limit=1")
    assert len(pull.json()["changes"]) == 1
    assert pull.json()["has_more"] is True
    assert pull.json()["cursor"] == pull.json()["changes"][-1]["seq"]
    local_only = collection_mutation("m-local", "c-local")
    local_only["fields"]["storage_mode"] = "local_only"
    rejected = client.post("/api/sync/batch", json={"mutations": [local_only]}, headers=HEADERS).json()
    assert rejected["results"][0]["code"] == "collection_not_synced"
    client.close()


def test_photo_upload_verifies_hashes_and_supports_head(tmp_path, monkeypatch):
    client = make_client(tmp_path, max_photo_bytes=64)
    client.post(
        "/api/sync/batch", json={"mutations": [collection_mutation(), entry_mutation()]}, headers=HEADERS
    )
    data = b"raw photo bytes"
    digest = hashlib.sha256(data).hexdigest()
    photo = {
        "id": "m-p",
        "entity": "photo",
        "entity_id": "p1",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": "p1",
            "entry_id": "e1",
            "collection_id": "c1",
            "sort_order": 0,
            "original_filename": "a.jpg",
            "mime_type": "image/jpeg",
            "byte_size": len(data),
            "width": 10,
            "height": 10,
            "sha256": digest,
            "crc32": zlib.crc32(data),
            "captured_at": "2026-11-08T12:00:00.000Z",
            "capture_source": "native_camera",
            "caption": "",
            "is_cover": True,
            "deleted_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }
    client.post("/api/sync/batch", json={"mutations": [photo]}, headers=HEADERS)
    url = "/api/photos/p1/original"
    headers = {**HEADERS, "X-Content-SHA256": digest, "Content-Type": "image/jpeg"}
    assert client.put("/api/photos/not-in-metadata/original", content=b"", headers=headers).status_code == 409
    bad = client.put(url, content=data, headers={**headers, "X-Content-SHA256": "0" * 64})
    assert bad.status_code == 422
    uploaded = client.put(url, content=data, headers=headers)
    assert uploaded.status_code == 201
    assert client.put(url, content=data, headers=headers).status_code == 200
    head = client.head(url)
    assert head.status_code == 200
    assert head.headers["etag"] == f'"{digest}"'
    downloaded = client.get(url)
    assert downloaded.content == data
    assert downloaded.headers["etag"] == f'"{digest}"'
    archive = tmp_path / "uploaded-export.zip"
    archive.write_bytes(client.get("/api/exports/all.zip").content)
    verify = subprocess.run(
        [sys.executable, "-I", "tools/verify-export.py", str(archive)],
        cwd=Path(__file__).parents[2],
        capture_output=True,
        text=True,
        check=False,
    )
    assert verify.returncode == 0, verify.stdout + verify.stderr
    monkeypatch.setattr(photos, "shutil_free", lambda _: 0)
    assert client.put("/api/photos/p1/original", content=data, headers=headers).status_code == 200
    client.close()


def test_photo_upload_size_limit_and_low_disk(tmp_path, monkeypatch):
    client = make_client(tmp_path, max_photo_bytes=8)
    client.post(
        "/api/sync/batch", json={"mutations": [collection_mutation(), entry_mutation()]}, headers=HEADERS
    )
    large = b"0123456789"
    large_hash = hashlib.sha256(large).hexdigest()
    mutation = {
        "id": "m-large-photo",
        "entity": "photo",
        "entity_id": "large",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": "large",
            "entry_id": "e1",
            "collection_id": "c1",
            "sort_order": 0,
            "original_filename": "large.jpg",
            "mime_type": "image/jpeg",
            "byte_size": len(large),
            "width": 1,
            "height": 1,
            "sha256": large_hash,
            "crc32": zlib.crc32(large),
            "captured_at": "2026-11-08T12:00:00.000Z",
            "capture_source": "native_camera",
            "caption": "",
            "is_cover": False,
            "deleted_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }
    client.post("/api/sync/batch", json={"mutations": [mutation]}, headers=HEADERS)
    headers = {**HEADERS, "X-Content-SHA256": large_hash, "Content-Type": "image/jpeg"}
    assert client.put("/api/photos/large/original", content=large, headers=headers).status_code == 413
    client.close()

    low_client = make_client(tmp_path / "low", min_free_bytes=100)
    low_client.post(
        "/api/sync/batch",
        json={"mutations": [collection_mutation(), entry_mutation()]},
        headers=HEADERS,
    )
    data = b"photo"
    digest = hashlib.sha256(data).hexdigest()
    mutation["id"] = "m-low-photo"
    mutation["entity_id"] = "low-photo"
    mutation["fields"].update(id="low-photo", byte_size=len(data), sha256=digest, crc32=zlib.crc32(data))
    low_client.post("/api/sync/batch", json={"mutations": [mutation]}, headers=HEADERS)
    monkeypatch.setattr(photos, "shutil_free", lambda _: 0)
    response = low_client.put(
        "/api/photos/low-photo/original",
        content=data,
        headers={**HEADERS, "X-Content-SHA256": digest, "Content-Type": "image/jpeg"},
    )
    assert response.status_code == 507
    low_client.close()


def test_server_copy_removal_requires_exact_name_and_marks_change(tmp_path):
    client = make_client(tmp_path)
    client.post(
        "/api/sync/batch", json={"mutations": [collection_mutation(name="Room / A")]}, headers=HEADERS
    )
    url = "/api/collections/c1/server-copy"
    assert client.delete(url, headers={**HEADERS, "X-Confirm-Name": "Room"}).status_code == 409
    deleted = client.delete(url, headers={**HEADERS, "X-Confirm-Name": "Room%20%2F%20A"})
    assert deleted.status_code == 204
    changes = client.get("/api/sync/changes?cursor=0&limit=100").json()["changes"]
    assert changes[-1] == {"seq": changes[-1]["seq"], "entity": "collection", "id": "c1", "removed": True}
    assert client.get("/api/collections").json() == []
    client.close()


def test_streamed_export_with_missing_original_passes_operator_verifier(tmp_path):
    client = make_client(tmp_path)
    client.post(
        "/api/sync/batch", json={"mutations": [collection_mutation(), entry_mutation()]}, headers=HEADERS
    )
    missing_photo = {
        "id": "m-missing",
        "entity": "photo",
        "entity_id": "missing-photo",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": "missing-photo",
            "entry_id": "e1",
            "collection_id": "c1",
            "sort_order": 0,
            "original_filename": "missing.jpg",
            "mime_type": "image/jpeg",
            "byte_size": 5,
            "width": 10,
            "height": 10,
            "sha256": hashlib.sha256(b"photo").hexdigest(),
            "crc32": zlib.crc32(b"photo"),
            "captured_at": "2026-11-08T12:00:00.000Z",
            "capture_source": "native_camera",
            "caption": "",
            "is_cover": True,
            "deleted_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }
    client.post("/api/sync/batch", json={"mutations": [missing_photo]}, headers=HEADERS)
    exported = client.get("/api/exports/all.zip")
    assert exported.status_code == 200
    archive = tmp_path / "server-export.zip"
    archive.write_bytes(exported.content)
    result = subprocess.run(
        [sys.executable, "-I", "tools/verify-export.py", str(archive)],
        cwd=Path(__file__).parents[2],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = json.loads(zipfile.ZipFile(archive).read("capture-export/manifest.json"))
    assert manifest["source"] == "server"
    assert manifest["missing_originals"] == [
        {"photo_id": "missing-photo", "path": "photos/e1/missing-photo.jpg"}
    ]
    client.close()


def test_unknown_api_paths_require_a_session_before_revealing_anything(tmp_path):
    from fastapi.testclient import TestClient

    from kufang_capture.main import create_app
    from kufang_capture.settings import Settings

    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    with TestClient(app) as client:
        assert client.get("/api/some-future-route").status_code == 401
        assert client.get("/api/health").status_code == 200
