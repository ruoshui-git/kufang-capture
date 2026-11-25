import hashlib
import secrets
import sqlite3
from collections.abc import Callable
from contextlib import closing
from math import ceil
from pathlib import Path
from time import monotonic

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .auth import ULID_RE, auth_connect, user_data_dir
from .db import connect
from .settings import Settings
from .sync import SHA_RE, TABLES, now, public_record

AGENT_PATH = "/api/agent"
READ_METHODS = {"GET", "HEAD"}


def is_agent_path(path: str) -> bool:
    return path == AGENT_PATH or path.startswith(AGENT_PATH + "/")


def agent_guard(
    config: Settings, client_ip: Callable[[Request], str]
) -> Callable[[Request], Response | None]:
    digest = config.agent_token_sha256 or ""
    enabled = SHA_RE.fullmatch(digest) is not None
    failures: dict[str, int] = {}
    expires_at = 0.0

    def guard(request: Request) -> Response | None:
        nonlocal expires_at
        if not enabled:
            return JSONResponse({"detail": "not_found"}, status_code=404)
        if request.method not in READ_METHODS:
            return JSONResponse(
                {"detail": "method_not_allowed"}, status_code=405, headers={"Allow": "GET, HEAD"}
            )
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer" and token:
            if secrets.compare_digest(hashlib.sha256(token.encode()).hexdigest(), digest):
                return None

        current = monotonic()
        if current >= expires_at:
            failures.clear()
            expires_at = current + 60
        ip = client_ip(request)
        count = failures.get(ip, 0)
        # Bound memory use even if a caller can rotate its source address.
        if count >= 5 or (ip not in failures and len(failures) >= 4096):
            return JSONResponse(
                {"detail": "agent_auth_required"},
                status_code=429,
                headers={"Retry-After": str(ceil(expires_at - current))},
            )
        failures[ip] = count + 1
        return JSONResponse(
            {"detail": "agent_auth_required"}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
        )

    return guard


def resolve_agent_user(config: Settings, user_id: str) -> Path:
    with auth_connect(config.data_dir) as db:
        known = db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone()
    if known is None:
        raise HTTPException(404, detail="user_not_found")
    return user_data_dir(config.data_dir, user_id)


def latest_cursor(db: sqlite3.Connection) -> int:
    return db.execute("SELECT COALESCE(MAX(seq),0) FROM changes").fetchone()[0]


def agent_router(config: Settings) -> APIRouter:
    router = APIRouter(prefix=AGENT_PATH + "/v1/users")

    @router.get("")
    @router.head("", include_in_schema=False)
    def users():
        with auth_connect(config.data_dir) as db:
            rows = db.execute("SELECT * FROM users ORDER BY is_owner DESC,created_at,id").fetchall()
        users = []
        for row in rows:
            with connect(user_data_dir(config.data_dir, row["id"])) as db:
                cursor = latest_cursor(db)
            users.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "disabled": row["disabled_at"] is not None,
                    "cursor": cursor,
                }
            )
        return {"schema": 1, "server_version": config.app_version, "users": users}

    @router.get("/{user_id}/changes")
    @router.head("/{user_id}/changes", include_in_schema=False)
    def changes(user_id: str, cursor: int = 0, limit: int = 500):
        return agent_changes(resolve_agent_user(config, user_id), max(cursor, 0), min(max(limit, 1), 1000))

    @router.get("/{user_id}/photos/{photo_id}/original")
    @router.head("/{user_id}/photos/{photo_id}/original", include_in_schema=False)
    def photo_original(user_id: str, photo_id: str, request: Request):
        directory = resolve_agent_user(config, user_id)
        if ULID_RE.fullmatch(photo_id) is None:
            raise HTTPException(404, detail="photo_not_stored")
        return agent_original(directory, photo_id, request.method == "HEAD")

    @router.get("/{user_id}/summary")
    @router.head("/{user_id}/summary", include_in_schema=False)
    def summary(user_id: str):
        return agent_summary(resolve_agent_user(config, user_id))

    return router


def agent_changes(data_dir: Path, cursor: int, limit: int) -> dict[str, object]:
    with connect(data_dir) as db:
        db.execute("BEGIN")
        latest = latest_cursor(db)
        if cursor > latest:
            raise HTTPException(409, detail="cursor_ahead")
        rows = db.execute(
            "SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?", (cursor, limit + 1)
        ).fetchall()
        page = rows[:limit]
        last_by_record = {(row["entity"], row["entity_id"]): row["seq"] for row in page}
        changes = []
        for row in page:
            entity, record_id, seq = row["entity"], row["entity_id"], row["seq"]
            if last_by_record[entity, record_id] != seq:
                continue
            change = {"seq": seq, "entity": entity, "id": record_id}
            if row["kind"] in {"purged", "removed"}:
                change[row["kind"]] = True
            else:
                record = db.execute(f"SELECT * FROM {TABLES[entity]} WHERE id=?", (record_id,)).fetchone()
                if record is None:
                    change["purged"] = True
                else:
                    change["record"] = public_record(record, entity)
            changes.append(change)
    has_more = len(rows) > limit
    return {
        "schema": 1,
        "changes": changes,
        "cursor": page[-1]["seq"] if has_more else latest,
        "has_more": has_more,
        "latest": latest,
        "server_time": now(),
    }


def agent_original(data_dir: Path, photo_id: str, head: bool) -> Response:
    key = f"media/originals/{photo_id[:2]}/{photo_id}"
    with connect(data_dir) as db:
        photo = db.execute(
            "SELECT mime_type,byte_size,sha256 FROM photos WHERE id=? AND stored_at IS NOT NULL "
            "AND storage_key=?",
            (photo_id, key),
        ).fetchone()
    if photo is None:
        raise HTTPException(404, detail="photo_not_stored")
    try:
        original = (data_dir / key).open("rb")
    except (FileNotFoundError, IsADirectoryError):
        raise HTTPException(404, detail="photo_not_stored") from None
    headers = {
        "Content-Length": str(photo["byte_size"]),
        "ETag": f'"{photo["sha256"]}"',
        "X-Content-SHA256": photo["sha256"],
    }
    if head:
        original.close()
        return Response(media_type=photo["mime_type"], headers=headers)

    def chunks():
        # Keep the open file readable if a concurrent purge unlinks it.
        with closing(original):
            yield from iter(lambda: original.read(64 * 1024), b"")

    return StreamingResponse(
        chunks(), media_type=photo["mime_type"], headers=headers, background=BackgroundTask(original.close)
    )


MISSING_ORIGINALS = """
    FROM photos p
    WHERE p.deleted_at IS NULL AND (p.stored_at IS NULL OR p.storage_key IS NULL)
      AND EXISTS (SELECT 1 FROM entries e WHERE e.item_id = p.item_id AND e.deleted_at IS NULL)
"""


def _read_account_stats(db: sqlite3.Connection) -> dict[str, object]:
    counts = dict(
        db.execute(
            f"""
            SELECT
                (SELECT COUNT(*) FROM collections) AS collections,
                (SELECT COUNT(*) FROM items) AS items,
                (SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL) AS entries,
                (SELECT COUNT(*) FROM entries WHERE deleted_at IS NOT NULL) AS deleted_entries,
                (SELECT COUNT(*) FROM photos WHERE deleted_at IS NULL) AS photos,
                (SELECT COUNT(*) FROM photos WHERE deleted_at IS NOT NULL) AS deleted_photos,
                (SELECT COUNT(*) {MISSING_ORIGINALS}) AS missing_originals
            """
        ).fetchone()
    )
    last_change_at = db.execute(
        "SELECT MAX(at) FROM ("
        "SELECT MAX(updated_at) AS at FROM collections UNION ALL "
        "SELECT MAX(updated_at) FROM items UNION ALL "
        "SELECT MAX(updated_at) FROM entries UNION ALL "
        "SELECT MAX(updated_at) FROM photos UNION ALL "
        "SELECT MAX(changed_at) FROM changes UNION ALL "
        "SELECT MAX(applied_at) FROM applied_mutations "
        "WHERE json_extract(result_json, '$.status')='applied' "
        "AND json_type(result_json, '$.server_revision')='null'"
        ")"
    ).fetchone()[0]
    return {**counts, "last_change_at": last_change_at}


def account_stats(data_dir: Path) -> dict[str, object]:
    with connect(data_dir) as db:
        db.execute("BEGIN")
        return _read_account_stats(db)


def agent_summary(data_dir: Path) -> dict[str, object]:
    with connect(data_dir) as db:
        db.execute("BEGIN")
        stats = _read_account_stats(db)
        missing = db.execute(
            f"SELECT p.id AS photo_id, p.item_id {MISSING_ORIGINALS} ORDER BY p.id LIMIT 200"
        ).fetchall()
        details = [
            {
                **dict(photo),
                "entries": [
                    dict(entry)
                    for entry in db.execute(
                        "SELECT c.name AS collection_name, e.sequence_number "
                        "FROM entries e JOIN collections c ON c.id=e.collection_id "
                        "WHERE e.item_id=? AND e.deleted_at IS NULL ORDER BY c.name,c.id,e.sequence_number",
                        (photo["item_id"],),
                    )
                ],
            }
            for photo in missing
        ]
    return {**stats, "missing_originals_details": details}
