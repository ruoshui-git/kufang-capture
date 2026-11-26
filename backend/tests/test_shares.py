import hashlib
import re
import zlib
from base64 import urlsafe_b64decode
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from test_accounts import PHOTO, batch, helper, seed_data
from test_contract import HEADERS, collection_mutation, entry_mutation, item_mutation

from kufang_capture import main, shares
from kufang_capture.auth import ULID_RE, auth_connect
from kufang_capture.db import connect, single_writer
from kufang_capture.settings import Settings

ORIGIN = "http://127.0.0.1"
LINKS = "/api/shares"
PUBLIC = "/api/share"
AT = "2026-11-08T12:00:00.000Z"
EARLY_CAPTURE = "2026-11-08T12:00:00Z"
LATER_CAPTURE = "2026-11-08T12:00:00.123Z"
ENTRY_AT = "2026-11-08T13:00:00.000Z"
ITEM_AT = "2026-11-08T14:00:00Z"
PHOTO_AT = "2026-11-08T14:00:00.123Z"
STORED_AT = "2026-11-08T15:00:00.000Z"
DELETED_AT = "2026-11-09T00:00:00.000Z"
BYTES = b"original\x00\xff\n"
THUMBNAIL = b"thumbnail"
SHA = hashlib.sha256(BYTES).hexdigest()


@pytest.fixture
def api(tmp_path: Path) -> Iterator[tuple[TestClient, TestClient, Settings]]:
    config = Settings(
        data_dir=tmp_path / "data",
        static_dir=tmp_path / "static",
        public_origin=ORIGIN + "/",
        dev_password="test-password",
        min_free_bytes=0,
    )
    config.static_dir.mkdir()
    (config.static_dir / "index.html").write_text("<html>Capture</html>", encoding="utf-8")
    with TestClient(main.create_app(config), base_url=ORIGIN) as owner:
        assert (
            owner.post("/api/auth/login", json={"password": "test-password"}, headers=HEADERS).status_code
            == 204
        )
        with closing(TestClient(owner.app, base_url=ORIGIN)) as visitor:
            yield owner, visitor, config


class Clock(datetime):
    current = datetime(2026, 11, 26, 10, tzinfo=UTC)

    @classmethod
    def now(cls, tz=UTC) -> datetime:
        return cls.current.astimezone(tz)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> type[Clock]:
    monkeypatch.setattr(Clock, "current", datetime(2026, 11, 26, 10, tzinfo=UTC))
    monkeypatch.setattr(shares, "datetime", Clock)
    return Clock


def link(client: TestClient, collection_id: str = "c1", **options: Any) -> dict[str, Any]:
    response = client.post(LINKS, headers=HEADERS, json={"collection_id": collection_id, **options})
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def token_header(share: dict[str, Any]) -> dict[str, str]:
    return {"X-Capture-Share": share["url"].split("#", 1)[1]}


def assert_error(response: Response, status: int, detail: str) -> None:
    assert response.status_code == status, response.text
    error = response.json()
    assert error["detail"] == detail
    assert set(error) == {"detail", "message"}
    assert error["message"]


def assert_private_headers(response: Response, cache: str = "no-store") -> None:
    assert response.headers["cache-control"] == cache
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-robots-tag"] == "noindex, nofollow"


def seed_collections(client: TestClient, *collections: tuple[str, str]) -> None:
    results = batch(client, [collection_mutation("m-" + cid, cid, name) for cid, name in collections])
    assert [r["status"] for r in results] == ["applied"] * len(collections)


def test_owner_and_helper_manage_separate_links(api: tuple[TestClient, TestClient, Settings]) -> None:
    owner, visitor, config = api
    assistant, user_id = helper(owner, "Helper")
    seed_collections(owner, ("c1", "Room A"), ("c2", "Room B"))
    seed_collections(assistant, ("c1", "Helper's room"))
    first = link(owner, label="  Boss  ")
    second = link(owner, "c2", label="  ", expires_in_days=None)
    third = link(assistant, expires_in_days=1)
    assert first == {
        "id": first["id"],
        "collection_id": "c1",
        "collection_name": "Room A",
        "label": "Boss",
        "url": first["url"],
        "created_at": first["created_at"],
        "expires_at": first["expires_at"],
        "last_viewed_at": None,
        "expired": False,
    }
    assert ULID_RE.fullmatch(first["id"])
    token = token_header(first)["X-Capture-Share"]
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
    assert len(urlsafe_b64decode(token + "=")) == 32
    assert first["url"] == f"{ORIGIN}/share#{token}"
    assert datetime.fromisoformat(first["expires_at"]) - datetime.fromisoformat(
        first["created_at"]
    ) == timedelta(days=30)
    assert second["expires_at"] is None
    assert second["label"] is None
    assert third["collection_name"] == "Helper's room"
    assert datetime.fromisoformat(third["expires_at"]) - datetime.fromisoformat(
        third["created_at"]
    ) == timedelta(days=1)
    with auth_connect(config.data_dir) as db:
        row = db.execute(
            "SELECT token,token_sha256,user_id FROM shares WHERE id=?", (first["id"],)
        ).fetchone()
        assert tuple(row) == (token, hashlib.sha256(token.encode()).hexdigest(), "owner")
        assert db.execute("SELECT user_id FROM shares WHERE id=?", (third["id"],)).fetchone()[0] == user_id

    assert owner.get(LINKS).json() == {"shares": [second, first]}
    assert owner.get(LINKS, params={"collection_id": "c1"}).json() == {"shares": [first]}
    assert owner.get(LINKS, params={"collection_id": "absent"}).json() == {"shares": []}
    assert assistant.get(LINKS).json() == {"shares": [third]}
    assert_error(assistant.delete(f"{LINKS}/{first['id']}", headers=HEADERS), 404, "share_not_found")
    assert_error(owner.delete(f"{LINKS}/{third['id']}", headers=HEADERS), 404, "share_not_found")
    viewed = visitor.get(PUBLIC, headers=token_header(third))
    assert viewed.status_code == 200
    assert viewed.json()["collection"]["name"] == "Helper's room"

    for account, share, remaining in ((owner, first, [second]), (assistant, third, [])):
        path = f"{LINKS}/{share['id']}"
        response = account.delete(path, headers=HEADERS)
        assert response.status_code == 204
        assert response.content == b""
        assert_error(account.delete(path, headers=HEADERS), 404, "share_not_found")
        assert account.get(LINKS).json() == {"shares": remaining}
        assert_error(visitor.get(PUBLIC, headers=token_header(share)), 404, "share_not_found")


@pytest.mark.parametrize("value", [True, False, 1.0, 2.5, "30", 0, 366, -1, [], {}])
def test_invalid_expiry(api: tuple[TestClient, TestClient, Settings], value: object) -> None:
    owner, _, _ = api
    assert_error(
        owner.post(LINKS, headers=HEADERS, json={"collection_id": "c1", "expires_in_days": value}),
        422,
        "invalid_expiry",
    )


@pytest.mark.parametrize("value", ["x" * 41, "A\u0000B", "A\x7fB", "\nBoss", "\ud800", 1, {}])
def test_invalid_label(api: tuple[TestClient, TestClient, Settings], value: object) -> None:
    owner, _, _ = api
    # The escaped surrogate is only representable in a raw JSON body.
    if value == "\ud800":
        response = owner.post(LINKS, headers=HEADERS, content=b'{"collection_id":"c1","label":"\\ud800"}')
    else:
        response = owner.post(LINKS, headers=HEADERS, json={"collection_id": "c1", "label": value})
    assert_error(response, 422, "invalid_label")


@pytest.mark.parametrize(
    "body", [{"collection_id": "c1", "extra": 1}, {}, {"collection_id": 1}, {"collection_id": ""}, [], "x"]
)
def test_invalid_request(api: tuple[TestClient, TestClient, Settings], body: object) -> None:
    owner, _, _ = api
    assert_error(owner.post(LINKS, headers=HEADERS, json=body), 422, "invalid_request")


def test_body_limit_and_collection_required(api: tuple[TestClient, TestClient, Settings]) -> None:
    owner, _, _ = api
    assert_error(owner.post(LINKS, headers=HEADERS, content=b"{"), 422, "invalid_request")
    body = b'{"collection_id":"c1"}'
    padding = b" " * (4096 - len(body))
    assert_error(owner.post(LINKS, headers=HEADERS, content=body + padding), 404, "collection_not_found")
    assert_error(owner.post(LINKS, headers=HEADERS, content=body + padding + b" "), 413, "request_too_large")
    seed_collections(owner, ("c1", "Room A"))
    response = owner.post(LINKS, headers=HEADERS, content=body + padding)
    assert response.status_code == 201
    assert link(owner, label="库" * 40, expires_in_days=365)["label"] == "库" * 40


def test_cap_counts_expired_links_and_is_per_account(api: tuple[TestClient, TestClient, Settings]) -> None:
    owner, _, config = api
    assistant, _ = helper(owner, "Helper")
    seed_collections(owner, ("c1", "Room A"), ("c2", "Room B"))
    seed_collections(assistant, ("c1", "Helper's room"))
    first = link(owner, expires_in_days=1)
    with auth_connect(config.data_dir) as db:
        db.execute("UPDATE shares SET expires_at=? WHERE id=?", (AT, first["id"]))
    for _ in range(49):
        link(owner, "c2")
    assert_error(owner.post(LINKS, headers=HEADERS, json={"collection_id": "c1"}), 409, "too_many_shares")
    assert len(owner.get(LINKS).json()["shares"]) == 50
    assert owner.get(LINKS, params={"collection_id": "c1"}).json() == {
        "shares": [{**first, "expires_at": AT, "expired": True}]
    }
    assert link(assistant)
    assert owner.delete(f"{LINKS}/{first['id']}", headers=HEADERS).status_code == 204
    assert link(owner)


def test_management_uses_csrf_and_account_binding(api: tuple[TestClient, TestClient, Settings]) -> None:
    owner, _, _ = api
    assistant, user_id = helper(owner, "Helper")
    seed_collections(assistant, ("c1", "Helper's room"))
    share = link(assistant)
    suffix = f"{LINKS}/{share['id']}"
    for method, path in (("POST", LINKS), ("DELETE", suffix)):
        assert_error(assistant.request(method, path), 403, "csrf_failed")
        assert_error(
            assistant.request(method, path, headers={**HEADERS, "Origin": "https://example.com"}),
            403,
            "csrf_failed",
        )
    assert owner.get(LINKS, headers={"X-Capture-Account": user_id}).json()["detail"] == "account_mismatch"
    assert owner.get(LINKS, headers={"X-Capture-Account": "owner"}).status_code == 200
    assert assistant.get(LINKS, headers={"X-Capture-Account": "owner"}).status_code == 409
    assert assistant.get(LINKS, headers={"X-Capture-Account": "owner"}).json()["detail"] == "account_mismatch"
    del assistant.headers["X-Capture-Account"]
    for method, path in (("GET", LINKS), ("POST", LINKS), ("DELETE", suffix)):
        response = assistant.request(method, path, headers=HEADERS)
        assert response.status_code == 409
        assert response.json()["detail"] == "account_required"


def with_fields(mutation: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {**mutation, "fields": {**mutation["fields"], **fields}}


def photo_mutation(photo_id: str, item_id: str, collection_id: str = "c1", **fields: Any) -> dict[str, Any]:
    return {
        "id": "m-" + photo_id,
        "entity": "photo",
        "entity_id": photo_id,
        "collection_id": collection_id,
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "id": photo_id,
            "item_id": item_id,
            "mime_type": "image/jpeg",
            "byte_size": len(BYTES),
            "width": 640,
            "height": 480,
            "sha256": SHA,
            "crc32": zlib.crc32(BYTES),
            "captured_at": AT,
            "capture_source": "native_camera",
            "original_filename": "private-filename.jpg",
            "caption": "Shelf",
            "created_at": AT,
            "updated_at": PHOTO_AT,
            **fields,
        },
    }


def upload(client: TestClient, photo_id: str, kind: str) -> None:
    response = client.put(
        f"/api/photos/{photo_id}/{kind}",
        headers={**HEADERS, "Content-Type": "image/jpeg", "X-Content-SHA256": SHA},
        content=BYTES if kind == "original" else THUMBNAIL,
    )
    assert response.status_code == (201 if kind == "original" else 200), response.text


@pytest.fixture
def shared_room(api: tuple[TestClient, TestClient, Settings]) -> dict[str, Any]:
    owner, _, config = api
    shared_entry = entry_mutation("m-later", "later", sequence=42)
    other_entry = entry_mutation("m-other", "other", "c2", sequence=99)
    mutations = [
        with_fields(collection_mutation("m-c1", "c1", "Room A"), description="Supplies", folder="Building A"),
        collection_mutation("m-c2", "c2", "Room B"),
        with_fields(
            item_mutation("shared"),
            title="Incense",
            notes="Item notes",
            expiration_date="2030-01-02",
            dimensions="2 cm",
            review_status="needs_review",
            updated_at=ITEM_AT,
        ),
        item_mutation("first"),
        item_mutation("trash"),
        item_mutation("private", "c2"),
        with_fields(
            shared_entry,
            item_id="shared",
            quantity="5.00",
            unit="boxes",
            count_detail="sealed",
            entry_notes="Room A notes",
            starred_at=AT,
            updated_at=ENTRY_AT,
        ),
        with_fields(other_entry, item_id="shared", quantity="99", entry_notes="Private placement"),
        entry_mutation("m-first", "first", sequence=1),
        with_fields(
            entry_mutation("m-trash", "trash", sequence=10), deleted_at=DELETED_AT, updated_at=DELETED_AT
        ),
        entry_mutation("m-private", "private", "c2", sequence=100),
        photo_mutation("p-cover", "shared", sort_order=2, is_cover=True),
        photo_mutation("p-fallback", "shared", captured_at=LATER_CAPTURE, sort_order=1),
        photo_mutation("p-missing", "shared", captured_at=LATER_CAPTURE, sort_order=1),
        photo_mutation("p-early", "shared", captured_at=EARLY_CAPTURE, sort_order=1),
        photo_mutation("p-deleted", "shared", deleted_at=DELETED_AT, updated_at=DELETED_AT),
        photo_mutation("p-trash", "trash", updated_at=DELETED_AT),
        photo_mutation("p-private", "private", "c2", updated_at=DELETED_AT),
    ]
    results = batch(owner, mutations)
    assert [result["status"] for result in results] == ["applied"] * len(mutations), results
    for photo_id in ("p-cover", "p-fallback", "p-deleted", "p-trash", "p-private"):
        upload(owner, photo_id, "original")
    upload(owner, "p-cover", "thumbnail")
    with connect(config.data_dir) as db:
        db.execute(
            "UPDATE photos SET stored_at=?,updated_at=? WHERE id IN ('p-cover','p-fallback')",
            (STORED_AT, PHOTO_AT),
        )
    return link(owner, label="Visitor", expires_in_days=None)


def test_snapshot_exact_shape_and_last_viewed(
    api: tuple[TestClient, TestClient, Settings], clock: type[Clock], shared_room: dict[str, Any]
) -> None:
    owner, visitor, config = api
    headers = token_header(shared_room)
    head = visitor.head(PUBLIC, headers=headers)
    assert head.status_code == 200
    assert head.content == b""
    assert owner.get(LINKS).json()["shares"][0]["last_viewed_at"] is None
    response = visitor.get(PUBLIC, headers=headers)
    assert response.status_code == 200
    assert head.headers["content-length"] == response.headers["content-length"]
    assert_private_headers(response)
    assert response.json() == {
        "schema": 1,
        "share": {"label": "Visitor", "expires_at": None},
        "collection": {
            "id": "c1",
            "name": "Room A",
            "description": "Supplies",
            "folder": "Building A",
            "status": "active",
            "archived_at": None,
        },
        "updated_at": STORED_AT,
        "entries": [
            {
                "id": "first",
                "item_id": "first",
                "sequence_number": 1,
                "quantity": None,
                "unit": "",
                "count_detail": "",
                "entry_notes": "",
                "title": "",
                "notes": "",
                "expiration_date": None,
                "dimensions": "",
                "review_status": "draft",
                "created_at": AT,
                "updated_at": AT,
                "photos": [],
            },
            {
                "id": "later",
                "item_id": "shared",
                "sequence_number": 42,
                "quantity": "5.00",
                "unit": "boxes",
                "count_detail": "sealed",
                "entry_notes": "Room A notes",
                "title": "Incense",
                "notes": "Item notes",
                "expiration_date": "2030-01-02",
                "dimensions": "2 cm",
                "review_status": "needs_review",
                "created_at": AT,
                "updated_at": ITEM_AT,
                "photos": [
                    {
                        "id": photo_id,
                        "mime_type": "image/jpeg",
                        "byte_size": len(BYTES),
                        "width": 640,
                        "height": 480,
                        "captured_at": captured,
                        "caption": "Shelf",
                        "is_cover": order == 2,
                        "sort_order": order,
                        "stored": stored,
                    }
                    for photo_id, captured, order, stored in (
                        ("p-early", EARLY_CAPTURE, 1, False),
                        ("p-fallback", LATER_CAPTURE, 1, True),
                        ("p-missing", LATER_CAPTURE, 1, False),
                        ("p-cover", AT, 2, True),
                    )
                ],
            },
        ],
    }
    assert owner.get(LINKS).json()["shares"][0]["last_viewed_at"] == "2026-11-26T10:00:00.000Z"
    clock.current += timedelta(seconds=59)
    assert visitor.get(PUBLIC, headers=headers).status_code == 200
    assert owner.get(LINKS).json()["shares"][0]["last_viewed_at"] == "2026-11-26T10:00:00.000Z"
    clock.current += timedelta(seconds=1)
    assert visitor.get(PUBLIC, headers=headers).status_code == 200
    assert owner.get(LINKS).json()["shares"][0]["last_viewed_at"] == "2026-11-26T10:01:00.000Z"
    # The later photo timestamp also participates when original storage is older.
    with connect(config.data_dir) as db:
        db.execute("UPDATE photos SET stored_at=? WHERE stored_at IS NOT NULL", (AT,))
    assert visitor.get(PUBLIC, headers=headers).json()["updated_at"] == PHOTO_AT


def test_snapshot_uses_one_read_transaction(
    api: tuple[TestClient, TestClient, Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner, visitor, config = api
    seed_data(owner, "c1", "Room A", b"bytes")
    share = link(owner)
    read_snapshot = shares.read_snapshot

    def concurrent_update(db, share, collection):
        with connect(config.data_dir) as writer:
            writer.execute("UPDATE collections SET name='Modified',updated_at=? WHERE id='c1'", (STORED_AT,))
            writer.execute("UPDATE items SET title='Modified',updated_at=?", (STORED_AT,))
            writer.execute("UPDATE photos SET deleted_at=?", (STORED_AT,))
        return read_snapshot(db, share, collection)

    with monkeypatch.context() as patch:
        patch.setattr(shares, "read_snapshot", concurrent_update)
        page = visitor.get(PUBLIC, headers=token_header(share)).json()
    assert page["collection"]["name"] == "Room A"
    assert page["entries"][0]["title"] == "Room A"
    assert len(page["entries"][0]["photos"]) == 1
    page = visitor.get(PUBLIC, headers=token_header(share)).json()
    assert page["collection"]["name"] == "Modified"
    assert page["entries"][0]["title"] == "Modified"
    assert page["entries"][0]["photos"] == []


def test_public_access_ignores_other_accounts_cookie(
    api: tuple[TestClient, TestClient, Settings], shared_room: dict[str, Any]
) -> None:
    owner, visitor, _ = api
    assistant, _ = helper(owner, "Helper")
    del assistant.headers["X-Capture-Account"]
    assert assistant.get("/api/auth/session").json()["authenticated"] is True
    headers = token_header(shared_room)
    anonymous = visitor.get(PUBLIC, headers=headers)
    assert anonymous.status_code == 200
    response = assistant.get(PUBLIC, headers=headers)
    assert response.status_code == 200
    assert response.json() == anonymous.json()
    assert "set-cookie" not in response.headers
    assert assistant.get(PUBLIC, headers={**headers, "X-Capture-Account": "wrong"}).status_code == 200
    response = assistant.get(f"{PUBLIC}/photos/p-cover/original", headers=headers)
    assert response.status_code == 200
    assert response.content == BYTES


def test_expiry_revocation_and_server_copy_removal(
    api: tuple[TestClient, TestClient, Settings], clock: type[Clock]
) -> None:
    owner, visitor, _ = api
    seed_data(owner, "c1", "Room A", BYTES)
    expired = link(owner, expires_in_days=1)
    active = link(owner, expires_in_days=None)
    photo_url = f"{PUBLIC}/photos/{PHOTO}/original"
    assert visitor.get(photo_url, headers=token_header(active)).content == BYTES
    assert visitor.get(PUBLIC, headers=token_header(expired)).status_code == 200
    clock.current += timedelta(days=1)
    assert_error(visitor.get(PUBLIC, headers=token_header(expired)), 410, "share_expired")
    assert_error(visitor.get(photo_url, headers=token_header(expired)), 410, "share_expired")
    assert owner.get(LINKS).json()["shares"][-1]["expired"] is True
    assert owner.delete(f"{LINKS}/{expired['id']}", headers=HEADERS).status_code == 204
    assert_error(visitor.get(PUBLIC, headers=token_header(expired)), 404, "share_not_found")
    assert (
        owner.delete(
            "/api/collections/c1/server-copy", headers={**HEADERS, "X-Confirm-Name": "Room A"}
        ).status_code
        == 204
    )
    assert_error(visitor.get(PUBLIC, headers=token_header(active)), 404, "share_not_found")
    assert_error(visitor.get(photo_url, headers=token_header(active)), 404, "share_not_found")
    # Removing the server copy revokes its links, so they stay dead if sync recreates the same ID.
    assert owner.get(LINKS, params={"collection_id": "c1"}).json() == {"shares": []}
    assert_error(
        owner.post(LINKS, headers=HEADERS, json={"collection_id": "c1"}), 404, "collection_not_found"
    )
    recreated = batch(owner, [collection_mutation("m-recreate-c1", "c1", "Room A")])
    assert [r["status"] for r in recreated] == ["applied"]
    assert_error(visitor.get(PUBLIC, headers=token_header(active)), 404, "share_not_found")
    assert link(owner)["collection_id"] == "c1"


def test_server_copy_removal_revokes_only_that_collections_links(
    api: tuple[TestClient, TestClient, Settings],
) -> None:
    owner, visitor, _ = api
    seed_collections(owner, ("c1", "Room A"), ("c2", "Room B"))
    removed, kept = link(owner, "c1"), link(owner, "c2")
    assert_error(
        owner.delete("/api/collections/c1/server-copy", headers={**HEADERS, "X-Confirm-Name": "Wrong"}),
        409,
        "confirmation_name_mismatch",
    )
    assert visitor.get(PUBLIC, headers=token_header(removed)).status_code == 200
    response = owner.delete(
        "/api/collections/c1/server-copy", headers={**HEADERS, "X-Confirm-Name": "Room A"}
    )
    assert response.status_code == 204
    assert_error(visitor.get(PUBLIC, headers=token_header(removed)), 404, "share_not_found")
    assert visitor.get(PUBLIC, headers=token_header(kept)).status_code == 200
    with auth_connect(api[2].data_dir) as db:
        assert db.execute(
            "SELECT revoked_at IS NOT NULL FROM shares WHERE id=?", (removed["id"],)
        ).fetchone()[0]


def test_unknown_tokens_are_rejected_without_the_writer_lock(
    api: tuple[TestClient, TestClient, Settings],
) -> None:
    owner, visitor, _ = api
    seed_collections(owner, ("c1", "Room A"))
    unknown = {"X-Capture-Share": "A" * 43}
    paths = [PUBLIC, f"{PUBLIC}/photos/{'0' * 26}/thumbnail"]
    with ThreadPoolExecutor(max_workers=1) as pool, single_writer():
        # A rejection that waited for the writer lock would time out here instead of answering.
        for path in paths:
            response = pool.submit(visitor.get, path, headers=unknown).result(timeout=5)
            assert_error(response, 404, "share_not_found")


def test_disabled_and_unavailable_accounts(
    api: tuple[TestClient, TestClient, Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner, visitor, config = api
    assistant, user_id = helper(owner, "Helper")
    seed_collections(assistant, ("c1", "Helper's room"))
    share = link(assistant)
    headers = token_header(share)
    assert visitor.get(PUBLIC, headers=headers).status_code == 200
    patch = f"/api/people/{user_id}"
    assert owner.patch(patch, headers=HEADERS, json={"disabled": True}).status_code == 200
    assert_error(visitor.get(PUBLIC, headers=headers), 404, "share_not_found")
    assert owner.patch(patch, headers=HEADERS, json={"disabled": False}).status_code == 200
    assert visitor.get(PUBLIC, headers=headers).status_code == 200
    init_accounts = main.init_accounts
    monkeypatch.setattr(main, "init_accounts", lambda root: {user_id} | init_accounts(root))
    with TestClient(main.create_app(config), base_url=ORIGIN) as restarted:
        assert_error(restarted.get(PUBLIC, headers=headers), 404, "share_not_found")


def test_photo_bytes_metadata_head_and_access(
    api: tuple[TestClient, TestClient, Settings], shared_room: dict[str, Any]
) -> None:
    owner, visitor, _ = api
    headers = token_header(shared_room)
    for pid, kind, content, mime in (
        ("p-cover", "thumbnail", THUMBNAIL, "application/octet-stream"),
        ("p-fallback", "thumbnail", BYTES, "image/jpeg"),
        ("p-cover", "original", BYTES, "image/jpeg"),
        ("p-fallback", "original", BYTES, "image/jpeg"),
    ):
        for method in ("GET", "HEAD"):
            response = visitor.request(method, f"{PUBLIC}/photos/{pid}/{kind}", headers=headers)
            assert response.status_code == 200
            assert response.content == (content if method == "GET" else b"")
            assert response.headers["content-type"] == mime
            assert response.headers["content-length"] == str(len(content))
            assert response.headers["etag"] == f'"{hashlib.sha256(content).hexdigest()}"'
            assert_private_headers(response, "private, no-store")
    for pid in ("p-private", "p-deleted", "p-trash", "unknown"):
        for kind in ("original", "thumbnail"):
            response = visitor.get(f"{PUBLIC}/photos/{pid}/{kind}", headers=headers)
            assert_error(response, 404, "photo_not_found")
            assert_private_headers(response, "private, no-store")
    for kind in ("original", "thumbnail"):
        assert_error(
            visitor.get(f"{PUBLIC}/photos/p-missing/{kind}", headers=headers), 404, "photo_not_stored"
        )
    upload(owner, "p-missing", "thumbnail")
    assert visitor.get(f"{PUBLIC}/photos/p-missing/thumbnail", headers=headers).content == THUMBNAIL
    assert_error(visitor.get(f"{PUBLIC}/photos/p-missing/original", headers=headers), 404, "photo_not_stored")
    assert owner.get(LINKS).json()["shares"][0]["last_viewed_at"] is None


def test_prefix_boundaries_methods_and_headers(api: tuple[TestClient, TestClient, Settings]) -> None:
    owner, visitor, _ = api
    for path in (LINKS, f"{LINKS}/id", "/api/sharesX", "/api/share-x"):
        response = visitor.get(path, headers={"X-Capture-Share": "A" * 43})
        assert_error(response, 401, "auth_required")
        assert response.headers["referrer-policy"] == "same-origin"
        assert "x-robots-tag" not in response.headers
    for path in (PUBLIC, f"{PUBLIC}/photos/p/original"):
        response = visitor.get(path)
        assert_error(response, 401, "share_required")
        cache = "private, no-store" if "/photos/" in path else "no-store"
        assert_private_headers(response, cache)
        for method in ("POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"):
            response = visitor.request(method, path)
            assert_error(response, 405, "method_not_allowed")
            assert response.headers["allow"] == "GET, HEAD"
            assert_private_headers(response, cache)
    assert_error(visitor.get(f"{PUBLIC}/unknown"), 404, "not_found")
    assert visitor.head(f"{PUBLIC}/unknown").status_code == 404
    assert visitor.post(f"{PUBLIC}/unknown").status_code == 405
    page = visitor.get("/share")
    assert page.status_code == 200
    assert page.text == "<html>Capture</html>"
    assert_private_headers(page, "no-cache")
    for path in ("/", "/join"):
        response = visitor.get(path)
        assert response.status_code == 200
        assert response.headers["referrer-policy"] == "same-origin"
        assert "x-robots-tag" not in response.headers
    assert owner.get(LINKS).json() == {"shares": []}


def test_throttle_uses_rolling_window_and_rightmost_ip(
    api: tuple[TestClient, TestClient, Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner, visitor, _ = api
    seed_collections(owner, ("c1", "Room A"))
    valid = token_header(link(owner))
    tick = 0.0
    monkeypatch.setattr(shares, "monotonic", lambda: tick)
    ip = {"X-Forwarded-For": "192.0.2.1"}
    assert_error(visitor.get(PUBLIC, headers=ip), 401, "share_required")
    tick = 30.0
    for bad in ("A" * 42, "+" * 43, "unknown"):
        assert_error(visitor.get(PUBLIC, headers={**ip, "X-Capture-Share": bad}), 401, "share_required")
    unknown = {"X-Capture-Share": "A" * 43}
    for _ in range(6):
        assert_error(visitor.get(PUBLIC, headers={**ip, **unknown}), 404, "share_not_found")
    tick = 59.0
    response = visitor.get(PUBLIC, headers={**unknown, "X-Forwarded-For": "192.0.2.2, 192.0.2.1"})
    assert_error(response, 429, "too_many_attempts")
    assert response.headers["retry-after"] == "1"
    assert_private_headers(response)
    assert visitor.get(PUBLIC, headers={**ip, **valid}).status_code == 200
    assert_error(
        visitor.get(f"{PUBLIC}/photos/unknown/thumbnail", headers={**ip, **valid}), 404, "photo_not_found"
    )
    assert_error(visitor.get(PUBLIC, headers={"X-Forwarded-For": "192.0.2.2"}), 401, "share_required")
    tick = 60.0
    assert_error(visitor.get(PUBLIC, headers=ip), 401, "share_required")
    response = visitor.get(PUBLIC, headers=ip)
    assert_error(response, 429, "too_many_attempts")
    assert response.headers["retry-after"] == "30"


def test_throttle_bounds_tracked_ips(
    api: tuple[TestClient, TestClient, Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner, visitor, _ = api
    seed_collections(owner, ("c1", "Room A"))
    valid = token_header(link(owner))
    tick = 0.0
    monkeypatch.setattr(shares, "monotonic", lambda: tick)
    monkeypatch.setattr(shares, "MAX_TRACKED_IPS", 2)
    for ip in ("192.0.2.1", "192.0.2.2"):
        assert_error(visitor.get(PUBLIC, headers={"X-Forwarded-For": ip}), 401, "share_required")
    third = {"X-Forwarded-For": "192.0.2.3"}
    response = visitor.get(PUBLIC, headers=third)
    assert_error(response, 429, "too_many_attempts")
    assert response.headers["retry-after"] == "60"
    assert visitor.get(PUBLIC, headers={**third, **valid}).status_code == 200
    tick = 60.0
    assert_error(visitor.get(PUBLIC, headers=third), 401, "share_required")
