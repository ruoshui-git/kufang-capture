import secrets
import sqlite3
import unicodedata
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request

from .agent_api import account_stats
from .auth import ALPHABET, auth_connect, digest, read_object, require_session, timestamp, user_data_dir
from .db import connect, run_migrations, single_writer
from .settings import Settings


def people_router(config: Settings) -> APIRouter:
    root = config.data_dir
    router = APIRouter(prefix="/api/people")

    people_query = (
        "SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) "
        "AS device_count FROM users u"
    )

    def person(db: sqlite3.Connection, user_id: str) -> sqlite3.Row:
        row = db.execute(
            people_query + " WHERE u.id=?",
            (timestamp(datetime.now(UTC)), user_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, detail="person_not_found")
        return row

    def public_person(row: sqlite3.Row) -> dict:
        stats = account_stats(user_data_dir(root, row["id"]))
        device_count = row["device_count"]
        if row["is_owner"]:
            with connect(root) as db:
                device_count = db.execute(
                    "SELECT COUNT(*) FROM sessions WHERE expires_at>?", (timestamp(datetime.now(UTC)),)
                ).fetchone()[0]
        return {
            "id": row["id"],
            "name": row["name"],
            "is_owner": bool(row["is_owner"]),
            "disabled": row["disabled_at"] is not None,
            "created_at": row["created_at"],
            "last_seen_at": row["last_seen_at"],
            "last_change_at": stats["last_change_at"],
            "rooms": stats["collections"],
            "entries": stats["entries"],
            "photos": stats["photos"],
            "missing_originals": stats["missing_originals"],
            "device_count": device_count,
        }

    def validated_name(value: object) -> tuple[str, str]:
        if not isinstance(value, str):
            raise HTTPException(422, detail="invalid_name")
        name = unicodedata.normalize("NFC", value.strip())
        if not 1 <= len(name) <= 40 or any(unicodedata.category(c) in {"Cc", "Cs"} for c in name):
            raise HTTPException(422, detail="invalid_name")
        return name, unicodedata.normalize("NFC", name.casefold())

    @router.get("")
    def list_people():
        with auth_connect(root) as db:
            rows = db.execute(
                people_query + " ORDER BY is_owner DESC,created_at,id", (timestamp(datetime.now(UTC)),)
            ).fetchall()
        return [public_person(row) for row in rows]

    @router.post("", status_code=201)
    async def create_person(request: Request):
        name, key = validated_name((await read_object(request)).get("name"))
        current = datetime.now(UTC)
        bits = (int(current.timestamp() * 1000) << 80) | secrets.randbits(80)
        user_id = "".join(ALPHABET[(bits >> shift) & 31] for shift in range(125, -1, -5))
        with single_writer(), auth_connect(root) as db:
            require_session(root, request)
            db.execute("BEGIN IMMEDIATE")
            added = db.execute(
                "INSERT INTO users(id,name,name_key,is_owner,created_at) VALUES(?,?,?,0,?) "
                "ON CONFLICT(name_key) DO NOTHING",
                (user_id, name, key, timestamp(current)),
            )
            if not added.rowcount:
                raise HTTPException(409, detail="name_taken")
            run_migrations(user_data_dir(root, user_id))
            row = person(db, user_id)
        return public_person(row)

    @router.patch("/{user_id}")
    async def update_person(user_id: str, request: Request):
        body = await read_object(request)
        if not body or body.keys() - {"name", "disabled"}:
            raise HTTPException(422, detail="invalid_request")
        name = validated_name(body["name"]) if "name" in body else None
        disabled = body.get("disabled")
        if "disabled" in body and type(disabled) is not bool:
            raise HTTPException(422, detail="invalid_request")
        with single_writer(), auth_connect(root) as db:
            require_session(root, request)
            db.execute("BEGIN IMMEDIATE")
            existing = person(db, user_id)
            if disabled is not None and existing["is_owner"]:
                raise HTTPException(409, detail="owner_protected")
            if name is not None:
                if db.execute(
                    "SELECT 1 FROM users WHERE name_key=? AND id<>?", (name[1], user_id)
                ).fetchone():
                    raise HTTPException(409, detail="name_taken")
                db.execute("UPDATE users SET name=?,name_key=? WHERE id=?", (*name, user_id))
            if disabled is not None:
                at = timestamp(datetime.now(UTC))
                db.execute(
                    "UPDATE users SET disabled_at=CASE WHEN ? THEN COALESCE(disabled_at,?) ELSE NULL END "
                    "WHERE id=?",
                    (disabled, at, user_id),
                )
                if disabled:
                    db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
                    db.execute(
                        "UPDATE join_codes SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL",
                        (at, user_id),
                    )
            row = person(db, user_id)
        return public_person(row)

    @router.post("/{user_id}/code")
    def issue_code(user_id: str, request: Request):
        with single_writer(), auth_connect(root) as db:
            require_session(root, request)
            db.execute("BEGIN IMMEDIATE")
            row = person(db, user_id)
            if row["is_owner"]:
                raise HTTPException(409, detail="owner_protected")
            if row["disabled_at"]:
                raise HTTPException(409, detail="person_disabled")
            current = datetime.now(UTC)
            at = timestamp(current)
            expires_at = timestamp(current + timedelta(minutes=10))
            db.execute(
                "UPDATE join_codes SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL",
                (at, user_id),
            )
            while True:
                raw = "".join(secrets.choice(ALPHABET) for _ in range(8))
                if db.execute(
                    "INSERT INTO join_codes(code_sha256,user_id,expires_at) VALUES(?,?,?) "
                    "ON CONFLICT(code_sha256) DO NOTHING",
                    (digest(raw), user_id, expires_at),
                ).rowcount:
                    break
        code = f"{raw[:4]}-{raw[4:]}"
        return {
            "code": code,
            "expires_at": expires_at,
            "url": f"{config.public_origin.rstrip('/')}/join#{code}",
        }

    return router
