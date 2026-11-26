import asyncio
import hashlib
import os
import time
import zlib
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from test_accounts import AT, PHOTO, batch, helper
from test_contract import HEADERS, collection_mutation, entry_mutation, item_mutation

from kufang_capture import photos
from kufang_capture.db import connect
from kufang_capture.main import create_app
from kufang_capture.settings import Settings

URL = f"/api/photos/{PHOTO}/original"
BODY = b"original image bytes"


def photo_mutation(body: bytes, *, crc: int | None = None) -> dict:
    return {
        "id": "m-photo",
        "entity": "photo",
        "entity_id": PHOTO,
        "collection_id": "c1",
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "item_id": "e1",
            "original_filename": "photo.jpg",
            "mime_type": "image/jpeg",
            "byte_size": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "crc32": zlib.crc32(body) if crc is None else crc,
            "captured_at": AT,
            "capture_source": "native_camera",
            "created_at": AT,
            "updated_at": AT,
        },
    }


def seed(client: TestClient, body: bytes = BODY, *, crc: int | None = None) -> None:
    mutations = [
        collection_mutation(),
        item_mutation("e1", "c1"),
        entry_mutation(),
        photo_mutation(body, crc=crc),
    ]
    assert [row["status"] for row in batch(client, mutations)] == ["applied"] * len(mutations)


@pytest.fixture
def api(tmp_path: Path):
    data_dir = tmp_path / "data"
    config = Settings(
        data_dir=data_dir,
        static_dir=tmp_path / "static",
        public_origin=HEADERS["Origin"],
        dev_password="test-password",
        max_photo_bytes=3 * photos.CHUNK_SIZE,
        min_free_bytes=0,
    )
    with TestClient(create_app(config), base_url=HEADERS["Origin"]) as client:
        assert (
            client.post("/api/auth/login", headers=HEADERS, json={"password": "test-password"}).status_code
            == 204
        )
        yield client, data_dir


def patch_headers(offset: int, body: bytes = BODY) -> dict[str, str]:
    return {
        **HEADERS,
        "Content-Type": "application/offset+octet-stream",
        "X-Content-SHA256": hashlib.sha256(body).hexdigest(),
        "Upload-Offset": str(offset),
    }


def partial_path(data_dir: Path, body: bytes = BODY) -> Path:
    return data_dir / "media" / "tmp" / "partial" / f"{PHOTO}.{hashlib.sha256(body).hexdigest()}"


def check_head(client: TestClient, offset: int) -> None:
    response = client.head(URL)
    assert response.status_code == 404
    assert response.headers["Upload-Offset"] == str(offset)
    assert response.headers["Cache-Control"] == "private, no-store"
    assert not response.content


def test_three_patches_install_exact_original_and_acknowledge(api):
    client, data_dir = api
    seed(client)
    check_head(client, 0)
    for start, end in [(0, 4), (4, 12)]:
        response = client.patch(URL, headers=patch_headers(start), content=BODY[start:end])
        assert response.status_code == 204
        assert response.headers["Upload-Offset"] == str(end)
        assert not response.content
        check_head(client, end)
        assert client.get(URL).status_code == 404

    response = client.patch(URL, headers=patch_headers(12), content=BODY[12:])
    assert response.status_code == 201
    key = f"media/originals/{PHOTO[:2]}/{PHOTO}"
    assert response.json() == {
        "photo_id": PHOTO,
        "sha256": hashlib.sha256(BODY).hexdigest(),
        "byte_size": len(BODY),
        "server_storage_key": key,
    }
    assert (data_dir / key).read_bytes() == BODY
    assert client.get(URL).content == BODY
    assert not partial_path(data_dir).exists()
    with connect(data_dir) as db:
        stored_at, storage_key, updated_at, revision = db.execute(
            "SELECT stored_at, storage_key, updated_at, revision FROM photos WHERE id=?", (PHOTO,)
        ).fetchone()
        assert stored_at and storage_key == key and stored_at == updated_at and revision == 2
        changes = db.execute(
            "SELECT kind FROM changes WHERE entity = 'photo' AND entity_id = ? ORDER BY seq", (PHOTO,)
        ).fetchall()
        assert [row[0] for row in changes] == ["upsert", "upsert"]

    head = client.head(URL)
    assert head.status_code == 200
    assert head.headers["ETag"] == f'"{hashlib.sha256(BODY).hexdigest()}"'
    assert head.headers["Content-Type"] == "image/jpeg"
    assert head.headers["Content-Length"] == str(len(BODY))
    assert "Upload-Offset" not in head.headers
    repeated = client.patch(URL, headers=patch_headers(1), content=b"ignored")
    assert repeated.status_code == 200
    assert repeated.json() == response.json()
    with connect(data_dir) as db:
        assert db.execute("SELECT revision FROM photos WHERE id=?", (PHOTO,)).fetchone()[0] == 2


def test_unexpected_offset_cannot_append_bytes(api):
    client, data_dir = api
    seed(client)
    assert client.patch(URL, headers=patch_headers(0), content=BODY[:5]).status_code == 204
    mismatch = client.patch(URL, headers=patch_headers(3), content=BODY[3:])
    assert mismatch.status_code == 409
    assert mismatch.json() == {"detail": "upload_offset_mismatch", "offset": 5}
    assert mismatch.headers["Upload-Offset"] == "5"
    assert partial_path(data_dir).read_bytes() == BODY[:5]


def stream_request(offset: int, messages: AsyncIterator[dict]) -> Request:
    return Request(
        {
            "type": "http",
            "method": "PATCH",
            "path_params": {"photo_id": PHOTO},
            "headers": [(k.lower().encode(), v.encode()) for k, v in patch_headers(offset).items()],
        },
        receive=messages.__anext__,
    )


@pytest.mark.parametrize("received_bytes", [5, len(BODY)])
def test_client_disconnect_keeps_every_received_byte(api, received_bytes):
    client, data_dir = api
    seed(client)

    async def receive() -> AsyncIterator[dict]:
        yield {"type": "http.request", "body": BODY[:received_bytes], "more_body": True}
        yield {"type": "http.disconnect"}

    response = asyncio.run(
        photos.patch_original(stream_request(0, receive()), data_dir, 1024, 0, lambda: None)
    )
    assert response.status_code == 204
    assert partial_path(data_dir).read_bytes() == BODY[:received_bytes]
    check_head(client, received_bytes)
    assert (
        client.patch(URL, headers=patch_headers(received_bytes), content=BODY[received_bytes:]).status_code
        == 201
    )
    assert client.get(URL).content == BODY


def test_new_request_takes_ownership_from_stalled_request(api):
    client, data_dir = api
    seed(client)

    async def exercise():
        stalled = asyncio.Event()
        release_old = asyncio.Event()

        async def older_stream() -> AsyncIterator[dict]:
            yield {"type": "http.request", "body": BODY[:5], "more_body": True}
            stalled.set()
            await release_old.wait()
            yield {"type": "http.request", "body": b"these bytes must never append"}

        async def newer_stream() -> AsyncIterator[dict]:
            yield {"type": "http.request", "body": BODY[5:10]}

        def send(offset: int, stream: AsyncIterator[dict]):
            return photos.patch_original(stream_request(offset, stream), data_dir, 1024, 0, lambda: None)

        old = asyncio.create_task(send(0, older_stream()))
        await stalled.wait()
        assert (await send(5, newer_stream())).status_code == 204
        release_old.set()
        displaced = await old
        assert displaced.status_code == 409
        assert displaced.headers["Upload-Offset"] == "10"

    asyncio.run(exercise())
    assert partial_path(data_dir).read_bytes() == BODY[:10]
    assert client.patch(URL, headers=patch_headers(10), content=BODY[10:]).status_code == 201
    assert client.get(URL).content == BODY


@pytest.mark.parametrize("failure", ["hash", "crc", "overflow"])
def test_failed_verification_or_overflow_removes_partial(api, failure):
    client, data_dir = api
    seed(client, crc=0 if failure == "crc" else None)
    assert client.patch(URL, headers=patch_headers(0), content=BODY[:5]).status_code == 204
    ending = BODY[5:]
    if failure == "hash":
        ending = b"!" + ending[1:]
    if failure == "overflow":
        ending += b"!"
    response = client.patch(URL, headers=patch_headers(5), content=ending)
    assert response.status_code == 422
    assert response.json()["detail"] == "checksum_mismatch"
    assert not partial_path(data_dir).exists()
    check_head(client, 0)
    assert client.get(URL).status_code == 404


def test_chunk_and_original_size_limits(api):
    client, data_dir = api
    body = b"a" * (2 * photos.CHUNK_SIZE)
    seed(client, body)
    assert client.patch(URL, headers=patch_headers(0, body), content=body[:5]).status_code == 204
    # An iterable sends a streaming, chunked request without a declared Content-Length.
    pieces = (b"a" * size for size in [photos.CHUNK_SIZE // 2, photos.CHUNK_SIZE // 2, 1])
    response = client.patch(URL, headers=patch_headers(5, body), content=pieces)
    assert response.status_code == 413
    assert response.json()["detail"] == "chunk_too_large"
    assert partial_path(data_dir, body).read_bytes() == body[:5]

    too_large = b"a" * (3 * photos.CHUNK_SIZE + 1)
    with connect(data_dir) as db:
        db.execute(
            "UPDATE photos SET byte_size=?,sha256=? WHERE id=?",
            (len(too_large), hashlib.sha256(too_large).hexdigest(), PHOTO),
        )
    response = client.patch(URL, headers=patch_headers(0, too_large), content=b"")
    assert response.status_code == 413
    assert response.json()["detail"] == "photo_too_large"


def test_preconditions_for_metadata_hash_offset_content_type_and_storage(api, monkeypatch):
    client, data_dir = api
    response = client.patch(URL, headers=patch_headers(0), content=BODY)
    assert response.status_code == 409
    assert response.json()["detail"] == "photo_metadata_missing"
    check_head(client, 0)
    seed(client)
    headers = patch_headers(0)
    for invalid_offset in ("", "-1", "0.5", "0,0"):
        response = client.patch(URL, headers={**headers, "Upload-Offset": invalid_offset}, content=b"")
        assert response.status_code == 422
        assert response.json()["detail"] == "invalid_upload_offset"
    response = client.patch(URL, headers={**headers, "Content-Type": "image/jpeg"}, content=b"")
    assert response.status_code == 415
    assert response.json()["detail"] == "unsupported_chunk_type"
    response = client.patch(URL, headers=patch_headers(0, b"other bytes"), content=b"")
    assert response.status_code == 422
    assert response.json()["detail"] == "checksum_mismatch"
    monkeypatch.setattr(photos, "shutil_free", lambda _: -1)
    response = client.patch(URL, headers=headers, content=BODY)
    assert response.status_code == 507
    assert response.json()["detail"] == "server_storage_low"
    assert not partial_path(data_dir).exists()


@pytest.mark.parametrize("purge", ["photo", "entry", "server-copy"])
def test_purge_removes_partial_uploads(api, purge):
    client, data_dir = api
    seed(client)
    assert client.patch(URL, headers=patch_headers(0), content=BODY[:5]).status_code == 204
    if purge == "server-copy":
        response = client.delete(
            "/api/collections/c1/server-copy", headers={**HEADERS, "X-Confirm-Name": "Room A"}
        )
        assert response.status_code == 204
    else:
        target = photo_mutation(BODY) if purge == "photo" else entry_mutation()
        deleted = {**target, "id": "delete", "op": "delete", "fields": {}, "base_revision": 1}
        assert batch(client, [deleted])[0]["status"] == "applied"
        purged = {**deleted, "id": "purge", "op": "purge", "base_revision": 2}
        assert batch(client, [purged])[0]["status"] == "applied"
    assert not partial_path(data_dir).exists()
    check_head(client, 0)


def test_expiration_and_previous_hash_do_not_resume(api):
    client, data_dir = api
    seed(client)
    stale_hash = partial_path(data_dir, b"previous original")
    expired = partial_path(data_dir).with_name("another-photo." + "0" * 64)
    current = partial_path(data_dir)
    current.parent.mkdir(parents=True)
    for partial in (stale_hash, expired, current):
        partial.write_bytes(BODY[:4])
    cutoff = time.time() - photos.PARTIAL_MAX_AGE - 60
    for partial in (expired, current):
        os.utime(partial, (cutoff, cutoff))
    check_head(client, 0)
    response = client.patch(URL, headers=patch_headers(0), content=BODY[:5])
    assert response.status_code == 204
    assert current.read_bytes() == BODY[:5]
    assert not stale_hash.exists() and not expired.exists()


def test_put_installs_original_and_removes_partial(api):
    client, data_dir = api
    seed(client)
    assert client.patch(URL, headers=patch_headers(0), content=BODY[:5]).status_code == 204
    response = client.put(URL, headers={**patch_headers(0), "Content-Type": "image/jpeg"}, content=BODY)
    assert response.status_code == 201
    assert not partial_path(data_dir).exists()
    assert client.get(URL).content == BODY


def test_helper_partial_isolation_and_csrf_account_binding(api):
    owner, _ = api
    alice, alice_id = helper(owner, "Alice")
    bob, bob_id = helper(owner, "Bob")
    with alice, bob:
        seed(alice)
        seed(bob)
        headers = patch_headers(0)
        wrong_account = alice.patch(URL, headers={**headers, "X-Capture-Account": bob_id}, content=BODY)
        assert wrong_account.status_code == 409
        assert wrong_account.json()["detail"] == "account_mismatch"
        with TestClient(alice.app, base_url=HEADERS["Origin"], cookies=alice.cookies) as unbound:
            missing_account = unbound.patch(URL, headers=headers, content=BODY)
            assert missing_account.status_code == 409
            assert missing_account.json()["detail"] == "account_required"
        for invalid_headers in (
            {**headers, "X-Capture-Request": "0"},
            {**headers, "Origin": "http://different.test"},
        ):
            denied = alice.patch(URL, headers=invalid_headers, content=BODY)
            assert denied.status_code == 403
            assert denied.json()["detail"] == "csrf_failed"
        check_head(alice, 0)
        response = alice.patch(URL, headers={**headers, "X-Capture-Account": alice_id}, content=BODY[:5])
        assert response.status_code == 204
        check_head(alice, 5)
        check_head(bob, 0)
