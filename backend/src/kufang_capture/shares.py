import hashlib
import re
import secrets
import sqlite3
import unicodedata
from base64 import urlsafe_b64encode
from collections import OrderedDict, defaultdict, deque
from collections.abc import Callable, Iterator
from contextlib import ExitStack, closing
from datetime import UTC, datetime, timedelta
from math import ceil
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any, Never

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .auth import ALPHABET, auth_connect, digest, read_object, require_session, timestamp, user_data_dir
from .db import connect, single_writer
from .photos import photo_file
from .settings import Settings
from .sync import ID_RE

SHARE_PATH = "/api/share"
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
MAX_SHARES = 50
FAILURE_WINDOW = 60
MAX_FAILURES = 10
MAX_TRACKED_IPS = 4096


def is_share_path(path: str) -> bool:
    return path == SHARE_PATH or path.startswith(SHARE_PATH + "/")


def share_label(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or any(unicodedata.category(c) in {"Cc", "Cs"} for c in value):
        raise HTTPException(422, detail="invalid_label")
    label = value.strip()
    if len(label) > 40:
        raise HTTPException(422, detail="invalid_label")
    return label or None


def share_link(row: sqlite3.Row, name: str, origin: str, at: str) -> dict[str, object]:
    expiry = row["expires_at"]
    return {
        "id": row["id"],
        "collection_id": row["collection_id"],
        "collection_name": name,
        "label": row["label"],
        "url": f"{origin}/share#{row['token']}",
        "created_at": row["created_at"],
        "expires_at": expiry,
        "last_viewed_at": row["last_viewed_at"],
        "expired": expiry is not None and expiry <= at,
    }


def shares_router(config: Settings) -> APIRouter:
    router = APIRouter(prefix="/api/shares")
    root = config.data_dir
    origin = config.public_origin.rstrip("/")

    @router.get("")
    def list_shares(request: Request, collection_id: str | None = None) -> dict[str, list[dict[str, object]]]:
        user_id = request.state.user["id"]
        with auth_connect(root) as db:
            query = "SELECT * FROM shares WHERE user_id=? AND revoked_at IS NULL"
            params = [user_id]
            if collection_id is not None:
                query += " AND collection_id=?"
                params.append(collection_id)
            rows = db.execute(query + " ORDER BY created_at DESC, rowid DESC", params).fetchall()
        with connect(request.state.data_dir) as db:
            names = {}
            for cid in {row["collection_id"] for row in rows}:
                name = db.execute("SELECT name FROM collections WHERE id=?", (cid,)).fetchone()
                names[cid] = name["name"] if name else ""
        at = timestamp(datetime.now(UTC))
        return {"shares": [share_link(row, names[row["collection_id"]], origin, at) for row in rows]}

    @router.post("", status_code=201)
    async def create_share(request: Request) -> dict[str, object]:
        body = await read_object(request)
        collection_id = body.get("collection_id")
        if (
            body.keys() - {"collection_id", "label", "expires_in_days"}
            or not isinstance(collection_id, str)
            or ID_RE.fullmatch(collection_id) is None
        ):
            raise HTTPException(422, detail="invalid_request")
        label = share_label(body.get("label"))
        days = body.get("expires_in_days", 30)
        if days is not None and (type(days) is not int or not 1 <= days <= 365):
            raise HTTPException(422, detail="invalid_expiry")

        user_id = request.state.user["id"]
        with single_writer(), auth_connect(root) as db:
            require_session(root, request)
            with connect(request.state.data_dir) as account:
                collection = account.execute(
                    "SELECT name FROM collections WHERE id=?", (collection_id,)
                ).fetchone()
            if collection is None:
                raise HTTPException(404, detail="collection_not_found")
            db.execute("BEGIN IMMEDIATE")
            count = db.execute(
                "SELECT COUNT(*) FROM shares WHERE user_id=? AND revoked_at IS NULL", (user_id,)
            ).fetchone()[0]
            if count >= MAX_SHARES:
                raise HTTPException(409, detail="too_many_shares")
            current = datetime.now(UTC)
            at = timestamp(current)
            expires_at = timestamp(current + timedelta(days=days)) if days is not None else None
            token = urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
            # Encode a 48-bit Unix millisecond timestamp and 80 bits of randomness, as for user IDs.
            bits = (int(current.timestamp() * 1000) << 80) | secrets.randbits(80)
            share_id = "".join(ALPHABET[(bits >> shift) & 31] for shift in range(125, -1, -5))
            row = db.execute(
                "INSERT INTO shares(id,token,token_sha256,user_id,collection_id,label,created_at,expires_at) "
                "VALUES(?,?,?,?,?,?,?,?) RETURNING *",
                (share_id, token, digest(token), user_id, collection_id, label, at, expires_at),
            ).fetchone()
        return share_link(row, collection["name"], origin, at)

    @router.delete("/{share_id}", status_code=204)
    def revoke_share(share_id: str, request: Request) -> Response:
        with single_writer(), auth_connect(root) as db:
            require_session(root, request)
            updated = db.execute(
                "UPDATE shares SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
                (timestamp(datetime.now(UTC)), share_id, request.state.user["id"]),
            )
            if not updated.rowcount:
                raise HTTPException(404, detail="share_not_found")
        return Response(status_code=204)

    return router


def revoke_collection_shares(root: Path, user_id: str, collection_id: str) -> None:
    """Revoke every live link to a collection. The caller holds single_writer."""
    with auth_connect(root) as db:
        db.execute(
            "UPDATE shares SET revoked_at=? WHERE user_id=? AND collection_id=? AND revoked_at IS NULL",
            (timestamp(datetime.now(UTC)), user_id, collection_id),
        )


class ShareFailures:
    def __init__(self, client_ip: Callable[[Request], str]) -> None:
        self.client_ip = client_ip
        self.failures: OrderedDict[str, deque[float]] = OrderedDict()
        self.lock = Lock()

    def reject(self, request: Request, status: int, detail: str) -> Never:
        ip = self.client_ip(request)
        with self.lock:
            current = monotonic()
            cutoff = current - FAILURE_WINDOW
            # Ordered by most recent failure, so expired IPs can be removed from the front.
            while self.failures and next(iter(self.failures.values()))[-1] <= cutoff:
                self.failures.popitem(last=False)
            attempts = self.failures.get(ip)
            if attempts is None:
                if len(self.failures) >= MAX_TRACKED_IPS:
                    self._limited(next(iter(self.failures.values()))[-1], current)
                attempts = self.failures[ip] = deque()
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if len(attempts) >= MAX_FAILURES:
                self._limited(attempts[0], current)
            attempts.append(current)
            self.failures.move_to_end(ip)
        raise HTTPException(status, detail=detail)

    @staticmethod
    def _limited(since: float, current: float) -> Never:
        raise HTTPException(
            429,
            detail="too_many_attempts",
            headers={"Retry-After": str(max(1, ceil(since + FAILURE_WINDOW - current)))},
        )


def read_snapshot(db: sqlite3.Connection, share: sqlite3.Row, collection: sqlite3.Row) -> dict[str, object]:
    room = dict(collection)
    updated_at = room.pop("updated_at")
    entries = []
    photos_by_item: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in db.execute(
        """
        SELECT p.item_id, p.id, p.mime_type, p.byte_size, p.width, p.height, p.captured_at, p.caption,
               p.is_cover, p.sort_order, p.updated_at, p.stored_at
        FROM entries e JOIN photos p ON p.item_id=e.item_id
        WHERE e.collection_id=? AND e.deleted_at IS NULL AND p.deleted_at IS NULL
        """,
        (collection["id"],),
    ):
        photo = dict(row)
        stored_at = photo.pop("stored_at")
        photo_at = photo.pop("updated_at")
        updated_at = max(updated_at, photo_at, stored_at or photo_at, key=datetime.fromisoformat)
        photo["is_cover"] = bool(photo["is_cover"])
        photo["stored"] = stored_at is not None
        photos_by_item[photo.pop("item_id")].append(photo)
    for row in db.execute(
        """
        SELECT e.id, e.item_id, e.sequence_number, e.quantity, e.unit, e.count_detail, e.entry_notes,
               i.title, i.notes, i.expiration_date, i.dimensions, i.review_status,
               e.created_at, e.updated_at, i.updated_at AS item_updated_at
        FROM entries e JOIN items i ON i.id=e.item_id
        WHERE e.collection_id=? AND e.deleted_at IS NULL
        ORDER BY e.sequence_number
        """,
        (collection["id"],),
    ):
        entry = dict(row)
        entry["updated_at"] = max(
            entry["updated_at"], entry.pop("item_updated_at"), key=datetime.fromisoformat
        )
        updated_at = max(updated_at, entry["updated_at"], key=datetime.fromisoformat)
        photos = photos_by_item.get(entry["item_id"], [])
        photos.sort(key=lambda p: (p["sort_order"], datetime.fromisoformat(p["captured_at"]), p["id"]))
        entry["photos"] = photos
        entries.append(entry)
    return {
        "schema": 1,
        "share": {"label": share["label"], "expires_at": share["expires_at"]},
        "collection": room,
        "updated_at": updated_at,
        "entries": entries,
    }


def shared_photo(
    db: sqlite3.Connection, data_dir: Path, collection_id: str, photo_id: str, thumbnail: bool, head: bool
) -> Response:
    if ID_RE.fullmatch(photo_id) is None:
        raise HTTPException(404, detail="photo_not_found")
    record = db.execute(
        """
        SELECT p.id, p.mime_type, p.byte_size, p.sha256, p.storage_key, p.stored_at
        FROM photos p JOIN entries e ON e.item_id=p.item_id
        WHERE p.id=? AND e.collection_id=? AND p.deleted_at IS NULL AND e.deleted_at IS NULL
        """,
        (photo_id, collection_id),
    ).fetchone()
    if record is None:
        raise HTTPException(404, detail="photo_not_found")
    path, mime, is_thumbnail = photo_file(data_dir, record, thumbnail)
    try:
        if is_thumbnail:
            content = path.read_bytes()
            return Response(
                None if head else content,
                media_type="application/octet-stream",
                headers={
                    "Content-Length": str(len(content)),
                    "ETag": f'"{hashlib.sha256(content).hexdigest()}"',
                },
            )
        if record["stored_at"] is None:
            raise HTTPException(404, detail="photo_not_stored")
        original = path.open("rb")
    except (FileNotFoundError, IsADirectoryError):
        raise HTTPException(404, detail="photo_not_stored") from None

    headers = {"Content-Length": str(record["byte_size"]), "ETag": f'"{record["sha256"]}"'}
    if head:
        original.close()
        return Response(media_type=mime, headers=headers)

    def chunks() -> Iterator[bytes]:
        # An open file stays readable even if its entry is concurrently purged.
        with closing(original):
            yield from iter(lambda: original.read(64 * 1024), b"")

    return StreamingResponse(
        chunks(), media_type=mime, headers=headers, background=BackgroundTask(original.close)
    )


def public_share_router(
    config: Settings, client_ip: Callable[[Request], str], unavailable: set[str]
) -> APIRouter:
    router = APIRouter(prefix=SHARE_PATH)
    root = config.data_dir
    failures = ShareFailures(client_ip)

    def read_token(request: Request) -> str:
        tokens = request.headers.getlist("x-capture-share")
        if len(tokens) != 1 or TOKEN_RE.fullmatch(tokens[0]) is None:
            failures.reject(request, 401, "share_required")
        return tokens[0]

    def find_share(request: Request, token: str) -> sqlite3.Row:
        with auth_connect(root) as db:
            share = db.execute(
                "SELECT s.id, s.user_id, s.collection_id, s.label, s.expires_at, s.last_viewed_at "
                "FROM shares s JOIN users u ON u.id=s.user_id "
                "WHERE s.token_sha256=? AND s.revoked_at IS NULL AND u.disabled_at IS NULL",
                (digest(token),),
            ).fetchone()
        if share is None or share["user_id"] in unavailable:
            failures.reject(request, 404, "share_not_found")
        return share

    def find_collection(
        db: sqlite3.Connection, share: sqlite3.Row, request: Request, current: datetime
    ) -> sqlite3.Row:
        collection = db.execute(
            "SELECT id, name, description, folder, status, archived_at, updated_at "
            "FROM collections WHERE id=?",
            (share["collection_id"],),
        ).fetchone()
        if collection is None:
            failures.reject(request, 404, "share_not_found")
        if share["expires_at"] is not None and share["expires_at"] <= timestamp(current):
            raise HTTPException(410, detail="share_expired")
        return collection

    @router.get("")
    @router.head("", include_in_schema=False)
    def snapshot(request: Request) -> Response:
        token = read_token(request)
        # Reject unknown tokens before taking the writer lock, so failed attempts never contend with sync.
        find_share(request, token)
        with ExitStack() as stack:
            # Pin the account snapshot before a revocation, disable or account write can intervene.
            with single_writer():
                share = find_share(request, token)
                current = datetime.now(UTC)
                db = stack.enter_context(connect(user_data_dir(root, share["user_id"])))
                db.execute("BEGIN")
                collection = find_collection(db, share, request, current)
            payload = read_snapshot(db, share, collection)
        response = JSONResponse(payload)
        if request.method == "HEAD":
            return Response(headers=response.headers)

        cutoff = timestamp(current - timedelta(minutes=1))
        if share["last_viewed_at"] is None or share["last_viewed_at"] <= cutoff:
            with single_writer(), auth_connect(root) as db:
                db.execute(
                    "UPDATE shares SET last_viewed_at=? "
                    "WHERE id=? AND revoked_at IS NULL AND (last_viewed_at IS NULL OR last_viewed_at<=?) "
                    "AND EXISTS (SELECT 1 FROM users WHERE id=shares.user_id AND disabled_at IS NULL)",
                    (timestamp(current), share["id"], cutoff),
                )
        return response

    @router.get("/photos/{photo_id}/thumbnail")
    @router.head("/photos/{photo_id}/thumbnail", include_in_schema=False)
    @router.get("/photos/{photo_id}/original")
    @router.head("/photos/{photo_id}/original", include_in_schema=False)
    def photo(photo_id: str, request: Request) -> Response:
        token = read_token(request)
        find_share(request, token)
        # Keep photo authorization and the file open together across server-copy removal and uploads.
        with single_writer():
            share = find_share(request, token)
            directory = user_data_dir(root, share["user_id"])
            with connect(directory) as db:
                db.execute("BEGIN")
                find_collection(db, share, request, datetime.now(UTC))
                return shared_photo(
                    db,
                    directory,
                    share["collection_id"],
                    photo_id,
                    request.url.path.endswith("/thumbnail"),
                    request.method == "HEAD",
                )

    @router.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def unknown_share_path() -> Response:
        raise HTTPException(404, detail="not_found")

    return router
