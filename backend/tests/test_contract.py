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
    original_post = client.post

    def post(path, *args, **kwargs):
        payload = kwargs.get("json")
        if path == "/api/sync/batch" and isinstance(payload, dict):
            mutations = payload.get("mutations", [])
            known_items = {m.get("entity_id") for m in mutations if m.get("entity") == "item"}
            ordered = []
            for mutation in mutations:
                if mutation.get("entity") == "collection":
                    ordered.append(mutation)
                fields = mutation.get("fields", {})
                if mutation.get("entity") == "entry" and mutation.get("op") == "upsert":
                    item_id = fields.get("item_id")
                    if item_id and item_id not in known_items:
                        ordered.append(item_mutation(item_id, mutation.get("collection_id", "c1")))
                        known_items.add(item_id)
                    ordered.append(mutation)
                elif mutation.get("entity") != "collection":
                    ordered.append(mutation)
            payload = {**payload, "schema": 2, "mutations": ordered}
            kwargs["json"] = payload
        return original_post(path, *args, **kwargs)

    client.post = post
    original_get = client.get

    def get(path, *args, **kwargs):
        if path == "/api/sync/changes":
            params = dict(kwargs.get("params") or {})
            params.setdefault("schema", 2)
            kwargs["params"] = params
        elif isinstance(path, str) and path.startswith("/api/sync/changes?") and "schema=" not in path:
            path += "&schema=2"
        return original_get(path, *args, **kwargs)

    client.get = get
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
            "item_id": eid,
            "sequence_number": sequence,
            "quantity": None,
            "unit": "",
            "count_detail": "",
            "deleted_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }


def item_mutation(item_id="e1", cid="c1"):
    return {
        "id": f"m-item-{item_id}",
        "entity": "item",
        "entity_id": item_id,
        "collection_id": cid,
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": item_id,
            "title": "",
            "notes": "",
            "expiration_date": None,
            "dimensions": "",
            "review_status": "draft",
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
        "entity": "item",
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
    assert conflict_result["status"] == "conflict"
    assert conflict_result["code"] == "field_conflict"
    assert conflict_result["conflicting_fields"] == ["title"]
    retried_conflict = client.post("/api/sync/batch", json={"mutations": [conflict]}, headers=HEADERS).json()[
        "results"
    ][0]
    assert retried_conflict["status"] == "conflict"
    assert retried_conflict["code"] == "field_conflict"
    assert retried_conflict["conflicting_fields"] == ["title"]
    assert retried_conflict["duplicate"] is True

    rejected_update = {**title_update, "id": "m-rejected-update", "base_revision": None}
    rejected_result = client.post(
        "/api/sync/batch", json={"mutations": [rejected_update]}, headers=HEADERS
    ).json()["results"][0]
    assert rejected_result["status"] == "rejected"
    assert rejected_result["code"] == "invalid_field"
    retried_rejection = client.post(
        "/api/sync/batch", json={"mutations": [rejected_update]}, headers=HEADERS
    ).json()["results"][0]
    assert retried_rejection["status"] == "rejected"
    assert retried_rejection["code"] == rejected_result["code"]
    assert retried_rejection["duplicate"] is True

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

    delete = {
        **entry_mutation("m-delete", "e1"),
        "op": "delete",
        "base_revision": 1,
        "fields": {},
    }
    deleted = client.post("/api/sync/batch", json={"mutations": [delete]}, headers=HEADERS).json()["results"][
        0
    ]
    assert deleted["record"]["deleted_at"]
    restore = {**delete, "id": "m-restore", "op": "restore", "base_revision": 2}
    restored = client.post("/api/sync/batch", json={"mutations": [restore]}, headers=HEADERS).json()[
        "results"
    ][0]
    assert restored["record"]["deleted_at"] is None
    purge = {**delete, "id": "m-purge", "op": "delete", "base_revision": 3}
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
    for base in range(0, 1000, 100):
        batch = [entry_mutation(f"m-{i}", f"e{i}", sequence=i + 1) for i in range(base, base + 100)]
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
    assert "duplicate" not in duplicate.json()["results"][0]
    created = client.post(
        "/api/sync/batch",
        json={"device_id": "d1", "mutations": [entry_mutation(), entry_mutation("m-e2", "e2")]},
        headers=HEADERS,
    ).json()["results"]
    assert created[0]["status"] == "applied"
    assert created[1]["status"] == "applied"
    assert created[3]["code"] == "sequence_taken"
    pull = client.get("/api/sync/changes?cursor=0&limit=1")
    assert len(pull.json()["changes"]) == 1
    assert pull.json()["has_more"] is True
    assert pull.json()["cursor"] == pull.json()["changes"][-1]["seq"]
    local_only = collection_mutation("m-local", "c-local")
    local_only["fields"]["storage_mode"] = "local_only"
    rejected = client.post("/api/sync/batch", json={"mutations": [local_only]}, headers=HEADERS).json()
    assert rejected["results"][0]["code"] == "collection_not_synced"
    client.close()


def test_schema_one_sync_is_rejected_without_writes(tmp_path):
    client = make_client(tmp_path)
    old_entry = entry_mutation()
    old_entry["fields"].update(
        title="Schema one title",
        notes="old notes",
        expiration_date=None,
        dimensions="",
        review_status="draft",
    )
    old_entry["fields"].pop("item_id")
    old_photo = {
        "id": "m-v1-photo",
        "entity": "photo",
        "entity_id": "v1-photo",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {"id": "v1-photo", "entry_id": "e1", "collection_id": "c1"},
    }
    old_body = {"mutations": [collection_mutation(), old_entry, old_photo]}
    response = client.request("POST", "/api/sync/batch", json=old_body, headers=HEADERS)
    assert response.status_code == 409
    assert response.json()["detail"] == "client_outdated"
    assert client.get("/api/collections").json() == []
    changes = client.request("GET", "/api/sync/changes?cursor=0&limit=10", headers=HEADERS)
    assert changes.status_code == 409
    assert changes.json()["detail"] == "client_outdated"
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
            "item_id": "e1",
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
    # Without an uploaded thumbnail, the thumbnail URL serves the original, cached only briefly.
    fallback = client.get("/api/photos/p1/thumbnail")
    assert fallback.status_code == 200 and fallback.content == data
    assert fallback.headers["cache-control"] == "private, max-age=300"
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
            "item_id": "e1",
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


def test_server_copy_removal_preserves_shared_item_until_last_collection(tmp_path):
    from kufang_capture.db import connect

    client = make_client(tmp_path)
    item = item_mutation("shared", "c1")
    entry_one = entry_mutation("m-e1", "e1", "c1", 1)
    entry_one["fields"]["item_id"] = "shared"
    entry_two = entry_mutation("m-e2", "e2", "c2", 1)
    entry_two["fields"]["item_id"] = "shared"
    response = client.post(
        "/api/sync/batch",
        json={
            "schema": 2,
            "mutations": [
                collection_mutation(),
                collection_mutation("m-c2", "c2", "Room B"),
                item,
                entry_one,
                entry_two,
            ],
        },
        headers=HEADERS,
    )
    assert all(result["status"] == "applied" for result in response.json()["results"])
    photo = {
        "id": "m-photo",
        "entity": "photo",
        "entity_id": "p-shared",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": "p-shared",
            "item_id": "shared",
            "mime_type": "image/jpeg",
            "byte_size": 5,
            "sha256": hashlib.sha256(b"photo").hexdigest(),
            "crc32": zlib.crc32(b"photo"),
            "captured_at": "2026-11-08T12:00:00.000Z",
            "capture_source": "native_camera",
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }
    assert (
        client.post("/api/sync/batch", json={"schema": 2, "mutations": [photo]}, headers=HEADERS).json()[
            "results"
        ][0]["status"]
        == "applied"
    )
    data_dir = tmp_path / "data"
    original = data_dir / "media/originals/p-shared/p-shared"
    thumbnail = data_dir / "media/thumbnails/p-/p-shared"
    original.parent.mkdir(parents=True)
    thumbnail.parent.mkdir(parents=True)
    original.write_bytes(b"photo")
    thumbnail.write_bytes(b"thumb")
    with connect(data_dir) as db:
        db.execute(
            "UPDATE photos SET storage_key=?,stored_at=? WHERE id='p-shared'",
            (str(original.relative_to(data_dir)), "2026-11-08T12:00:00.000Z"),
        )

    remove_one = client.delete(
        "/api/collections/c1/server-copy", headers={**HEADERS, "X-Confirm-Name": "Room A"}
    )
    assert remove_one.status_code == 204
    assert original.read_bytes() == b"photo" and thumbnail.read_bytes() == b"thumb"
    with connect(data_dir) as db:
        assert db.execute("SELECT 1 FROM items WHERE id='shared'").fetchone()
        assert db.execute("SELECT 1 FROM photos WHERE id='p-shared'").fetchone()
    remove_last = client.delete(
        "/api/collections/c2/server-copy", headers={**HEADERS, "X-Confirm-Name": "Room B"}
    )
    assert remove_last.status_code == 204
    assert not original.exists() and not thumbnail.exists()
    with connect(data_dir) as db:
        assert db.execute("SELECT 1 FROM items WHERE id='shared'").fetchone() is None
        assert db.execute("SELECT 1 FROM photos WHERE id='p-shared'").fetchone() is None
        purged = {
            (row[0], row[1]) for row in db.execute("SELECT entity,kind FROM changes WHERE kind='purged'")
        }
        assert purged == {("photo", "purged"), ("item", "purged")}
    client.close()


def test_entry_purge_removes_orphan_item_photos_and_media(tmp_path):
    from kufang_capture.db import connect

    client = make_client(tmp_path)
    entry = entry_mutation()
    item = item_mutation("e1", "c1")
    item["fields"].update(title="Keep me until purge")
    photo = {
        "id": "m-purge-photo",
        "entity": "photo",
        "entity_id": "p1",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": "p1",
            "item_id": "e1",
            "mime_type": "image/jpeg",
            "byte_size": 5,
            "sha256": hashlib.sha256(b"photo").hexdigest(),
            "crc32": zlib.crc32(b"photo"),
            "captured_at": "2026-11-08T12:00:00.000Z",
            "capture_source": "native_camera",
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
        },
    }
    created = client.post(
        "/api/sync/batch",
        json={"schema": 2, "mutations": [collection_mutation(), item, entry, photo]},
        headers=HEADERS,
    )
    assert all(result["status"] == "applied" for result in created.json()["results"])
    data_dir = tmp_path / "data"
    original = data_dir / "media/originals/p1/p1"
    thumbnail = data_dir / "media/thumbnails/p1/p1"
    original.parent.mkdir(parents=True)
    thumbnail.parent.mkdir(parents=True)
    original.write_bytes(b"photo")
    thumbnail.write_bytes(b"thumb")
    with connect(data_dir) as db:
        db.execute("UPDATE photos SET storage_key=? WHERE id='p1'", (str(original.relative_to(data_dir)),))
    deleted = {
        **entry,
        "id": "m-delete-e1",
        "op": "delete",
        "base_revision": 1,
        "fields": {},
    }
    assert (
        client.post("/api/sync/batch", json={"schema": 2, "mutations": [deleted]}, headers=HEADERS).json()[
            "results"
        ][0]["status"]
        == "applied"
    )
    purge = {**deleted, "id": "m-purge-e1", "op": "purge", "fields": {}}
    assert (
        client.post("/api/sync/batch", json={"schema": 2, "mutations": [purge]}, headers=HEADERS).json()[
            "results"
        ][0]["status"]
        == "applied"
    )
    assert not original.exists() and not thumbnail.exists()
    with connect(data_dir) as db:
        assert db.execute("SELECT 1 FROM items WHERE id='e1'").fetchone() is None
        assert db.execute("SELECT 1 FROM photos WHERE id='p1'").fetchone() is None
        purged = {
            (row[0], row[1]) for row in db.execute("SELECT entity,kind FROM changes WHERE kind='purged'")
        }
        assert purged == {("entry", "purged"), ("photo", "purged"), ("item", "purged")}
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
            "item_id": "e1",
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


def test_version_two_export_shared_and_trash_item_sets(tmp_path):
    from kufang_capture.db import connect

    client = make_client(tmp_path)
    client.post("/api/sync/batch", json={"mutations": [collection_mutation()]}, headers=HEADERS)
    data_dir = tmp_path / "data"
    with connect(data_dir) as db:
        db.execute(
            "INSERT INTO collections(id,name,status,storage_mode,created_at,updated_at) "
            "VALUES('c2','Room B','active','synced','2026-11-08T12:01:00.000Z','2026-11-08T12:01:00.000Z')"
        )
        db.execute(
            "INSERT INTO items(id,title,notes,expiration_date,dimensions,review_status,revision,"
            "field_revisions,"
            "created_at,updated_at) VALUES('i-shared','Shared','',NULL,'','complete',3,'{}',"
            "'2026-11-08T12:02:00.000Z','2026-11-08T12:10:00.000Z')"
        )
        db.execute(
            "INSERT INTO items(id,title,notes,expiration_date,dimensions,review_status,"
            "created_at,updated_at) "
            "VALUES('i-trash','Only trash','',NULL,'','draft','2026-11-08T12:03:00.000Z',"
            "'2026-11-08T12:03:00.000Z')"
        )
        for values in (
            ("e-active", "c1", "i-shared", 1, None, "2026-11-08T12:04:00.000Z"),
            ("e-deleted-shared", "c2", "i-shared", 2, "2026-11-08T12:05:00.000Z", "2026-11-08T12:05:00.000Z"),
            ("e-deleted-only", "c2", "i-trash", 3, "2026-11-08T12:06:00.000Z", "2026-11-08T12:06:00.000Z"),
        ):
            db.execute(
                "INSERT INTO entries(id,collection_id,item_id,sequence_number,quantity,unit,"
                "count_detail,deleted_at,"
                "created_at,updated_at) VALUES(?,?,?,?,NULL,'','',?,'2026-11-08T12:00:00.000Z',?)",
                values,
            )
        for photo_id, item_id in (("p-shared", "i-shared"), ("p-trash", "i-trash")):
            db.execute(
                "INSERT INTO photos(id,item_id,mime_type,byte_size,sha256,crc32,captured_at,capture_source,"
                "created_at,updated_at) VALUES(?,?,'image/jpeg',1,?,0,'2026-11-08T12:00:00.000Z',"
                "'native_camera','2026-11-08T12:00:00.000Z','2026-11-08T12:00:00.000Z')",
                (photo_id, item_id, "a" * 64),
            )
    archive_bytes = client.get("/api/exports/all.zip?include_trash=1").content
    import io

    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        names = archive.namelist()
        assert "capture-export/photos/i-shared/p-shared.jpg" not in names
        assert "capture-export/trash/photos/i-trash/p-trash.jpg" not in names
        manifest = json.loads(archive.read("capture-export/manifest.json"))
        active_entries = json.loads(archive.read("capture-export/entries.json"))
        trash_entries = json.loads(archive.read("capture-export/trash/entries.json"))
        active_photos = json.loads(archive.read("capture-export/photos.json"))
        trash_photos = json.loads(archive.read("capture-export/trash/photos.json"))
    assert manifest["format_version"] == 2
    assert manifest["counts"] == {
        "collections": 2,
        "items": 1,
        "entries": 1,
        "photos": 1,
        "photo_bytes": 1,
        "trash_entries": 2,
        "trash_photos": 1,
    }
    assert active_entries[0]["item_id"] == "i-shared"
    assert active_entries[0]["updated_at"] == "2026-11-08T12:10:00.000Z"
    assert {entry["entry_id"] for entry in trash_entries} == {"e-deleted-shared", "e-deleted-only"}
    assert [photo["photo_id"] for photo in active_photos + trash_photos] == ["p-shared", "p-trash"]
    assert active_photos[0]["item_id"] == "i-shared"
    assert trash_photos[0]["item_id"] == "i-trash"
    assert active_photos[0]["path"] == "photos/i-shared/p-shared.jpg"
    assert trash_photos[0]["path"] == "trash/photos/i-trash/p-trash.jpg"
    client.close()


def test_unknown_api_paths_require_a_session_before_revealing_anything(tmp_path):
    from fastapi.testclient import TestClient

    from kufang_capture.main import create_app
    from kufang_capture.settings import Settings

    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    with TestClient(app) as client:
        assert client.get("/api/some-future-route").status_code == 401
        assert client.get("/api/health").status_code == 200


def test_full_client_records_with_local_fields_are_applied_and_wrong_fields_rejected(tmp_path):
    # The app sends whole local records on create, including device-only bookkeeping.
    client = make_client(tmp_path)
    local = {"revision": 1, "server_revision": None, "sync_state": "pending"}
    collection = collection_mutation()
    collection["fields"] |= local
    item = item_mutation()
    item["fields"] |= local
    entry = entry_mutation()
    entry["fields"] |= local
    photo = {
        "id": "m-p",
        "entity": "photo",
        "entity_id": "p1",
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": "p1",
            "item_id": "e1",
            "sort_order": 0,
            "original_filename": "a.jpg",
            "mime_type": "image/jpeg",
            "byte_size": 3,
            "width": 1,
            "height": 1,
            "sha256": "a" * 64,
            "crc32": 1,
            "captured_at": "2026-11-08T12:00:00.000Z",
            "capture_source": "photo_library",
            "caption": "",
            "is_cover": True,
            "deleted_at": None,
            "created_at": "2026-11-08T12:00:00.000Z",
            "updated_at": "2026-11-08T12:00:00.000Z",
            "upload_state": "pending",
            "server_storage_key": None,
            "upload_attempts": 0,
            "upload_next_attempt_at": None,
            **local,
        },
    }
    results = client.post(
        "/api/sync/batch",
        json={"device_id": "d1", "mutations": [collection, item, entry, photo]},
        headers=HEADERS,
    ).json()["results"]
    assert [r["status"] for r in results] == ["applied"] * 4
    stale = entry_mutation("m-e-title", "e1")
    stale["base_revision"] = 1
    stale["fields"] = {"title": "belongs to the item"}
    rejected = client.post("/api/sync/batch", json={"mutations": [stale]}, headers=HEADERS).json()
    assert rejected["results"][0]["status"] == "rejected"
    assert rejected["results"][0]["code"] == "invalid_field"
    client.close()
