import hashlib
import json
import logging
import re
import secrets
import sqlite3
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import anyio
from argon2 import PasswordHasher
from argon2 import exceptions as argon_exceptions
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .db import connect, run_migrations, single_writer
from .settings import Settings

logger = logging.getLogger(__name__)

OWNER_ID = "owner"
AUTH_FILE = "auth.sqlite3"
REQUEST_BYTES = 4096
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ULID_RE = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}")
CODE_ALIASES = str.maketrans({"O": "0", "I": "1", "L": "1"})
AUTH_ROUTES = {
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/join"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/session"),
}


def timestamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def user_data_dir(root: Path, user_id: str) -> Path:
    if user_id == OWNER_ID:
        return root
    if ULID_RE.fullmatch(user_id) is None:
        raise ValueError("Invalid user ID")
    return root / "users" / user_id


def auth_connect(root: Path) -> sqlite3.Connection:
    return connect(root, AUTH_FILE)


def init_accounts(root: Path) -> set[str]:
    run_migrations(root)
    run_migrations(root, Path(__file__).with_name("auth_migrations"), AUTH_FILE)
    with auth_connect(root) as auth:
        auth.execute("BEGIN IMMEDIATE")
        auth.execute(
            "INSERT OR IGNORE INTO users(id,name,name_key,is_owner,created_at) VALUES(?,?,?,1,?)",
            (OWNER_ID, "Owner", "owner", timestamp(datetime.now(UTC))),
        )
        # Drop any owner copies left by an earlier account-enabled development build.
        auth.execute("DELETE FROM sessions WHERE user_id=?", (OWNER_ID,))
        users = auth.execute("SELECT id FROM users WHERE is_owner=0").fetchall()
    unavailable = set()
    for user in users:
        user_id = user["id"]
        try:
            run_migrations(user_data_dir(root, user_id))
        except (OSError, sqlite3.Error, ValueError):
            logger.exception("Cannot open or migrate database for helper account %s", user_id)
            unavailable.add(user_id)
    return unavailable


@dataclass(frozen=True)
class Session:
    user: dict
    expires_at: str
    renewed: bool

    @property
    def days(self) -> int:
        return 30 if self.user["is_owner"] else 180


@dataclass(frozen=True)
class Cookies:
    secure: bool

    @property
    def name(self) -> str:
        return "__Host-kc_session" if self.secure else "kc_session"

    def set(self, response: Response, token: str, days: int) -> None:
        response.set_cookie(
            self.name,
            token,
            max_age=days * 86400,
            path="/",
            httponly=True,
            secure=self.secure,
            samesite="strict",
        )

    def clear(self, response: Response) -> None:
        response.delete_cookie(self.name, path="/", httponly=True, secure=self.secure, samesite="strict")


def get_session(
    root: Path,
    token: str,
    *,
    touch: bool = False,
    renew: bool = False,
    unavailable: set[str] | None = None,
) -> Session | None:
    """Look up a session. Hold single_writer when recording activity or renewing."""
    token_hash = digest(token)
    current = datetime.now(UTC)
    at = timestamp(current)
    # The owner always uses the same table, including across image rollbacks.
    with connect(root) as legacy, auth_connect(root) as db:
        owner_session = legacy.execute(
            "SELECT expires_at FROM sessions WHERE token_sha256=?", (token_hash,)
        ).fetchone()
        if owner_session is not None:
            row = db.execute(
                "SELECT id,name,is_owner,disabled_at,last_seen_at,? AS expires_at FROM users WHERE id=?",
                (owner_session["expires_at"], OWNER_ID),
            ).fetchone()
        else:
            row = db.execute(
                "SELECT s.expires_at,s.last_seen_at,u.id,u.name,u.is_owner,u.disabled_at "
                "FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_sha256=? AND u.is_owner=0",
                (token_hash,),
            ).fetchone()
        if row is None or row["disabled_at"] or row["expires_at"] <= at:
            return None
        if unavailable and row["id"] in unavailable:
            raise HTTPException(503, detail="account_unavailable")
        owner = bool(row["is_owner"])
        expiry = row["expires_at"]
        renewed = renew and datetime.fromisoformat(expiry) - current < timedelta(days=15 if owner else 150)
        if renewed:
            expiry = timestamp(current + timedelta(days=30 if owner else 180))
            (legacy if owner else db).execute(
                "UPDATE sessions SET expires_at=? WHERE token_sha256=?", (expiry, token_hash)
            )
        if (touch or renew) and (row["last_seen_at"] or "") <= timestamp(current - timedelta(minutes=1)):
            if not owner:
                db.execute("UPDATE sessions SET last_seen_at=? WHERE token_sha256=?", (at, token_hash))
            db.execute(
                "UPDATE users SET last_seen_at=MAX(COALESCE(last_seen_at,''),?) WHERE id=?",
                (at, row["id"]),
            )
        return Session({"id": row["id"], "name": row["name"], "is_owner": owner}, expiry, renewed)


def require_session(root: Path, request: Request) -> None:
    """Revalidate the authenticated account at a protected operation's boundary."""
    session = get_session(root, request.state.session_token)
    if session is None or session.user["id"] != request.state.user["id"]:
        raise HTTPException(401, detail="auth_required")


def signed_out_session() -> JSONResponse:
    return JSONResponse({"authenticated": False, "expires_at": None, "user": None})


async def read_object(request: Request, *, limit: int = REQUEST_BYTES) -> dict:
    length = request.headers.get("content-length", "").lstrip("0")
    max_length = str(limit)
    if (
        length.isascii()
        and length.isdigit()
        and (len(length) > len(max_length) or (len(length) == len(max_length) and length > max_length))
    ):
        raise HTTPException(413, detail="request_too_large")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, detail="request_too_large")
        body.extend(chunk)
    try:
        value = json.loads(body)
    except (ValueError, RecursionError):
        raise HTTPException(422, detail="invalid_request") from None
    if not isinstance(value, dict):
        raise HTTPException(422, detail="invalid_request")
    return value


def create_session(
    db: sqlite3.Connection,
    root: Path,
    user_id: str,
    current: datetime,
    previous_token: str | None,
    device_label: str | None = None,
) -> str:
    if previous_token:
        revoke_session(db, root, previous_token)
    token = secrets.token_urlsafe(32)
    at = timestamp(current)
    owner = user_id == OWNER_ID
    expiry = timestamp(current + timedelta(days=30 if owner else 180))
    if owner:
        with connect(root) as legacy:
            legacy.execute("DELETE FROM sessions WHERE expires_at<=?", (at,))
            legacy.execute(
                "INSERT INTO sessions(token_sha256,created_at,expires_at) VALUES(?,?,?)",
                (digest(token), at, expiry),
            )
    else:
        db.execute("DELETE FROM sessions WHERE user_id=? AND expires_at<=?", (user_id, at))
        db.execute(
            "INSERT INTO sessions("
            "token_sha256,user_id,created_at,expires_at,last_seen_at,device_label,pairing) "
            "VALUES(?,?,?,?,?,?,1)",
            (digest(token), user_id, at, expiry, at, device_label),
        )
    db.execute("UPDATE users SET last_seen_at=? WHERE id=?", (at, user_id))
    return token


def revoke_session(db: sqlite3.Connection, root: Path, token: str) -> None:
    token_hash = digest(token)
    with connect(root) as legacy:
        removed = legacy.execute("DELETE FROM sessions WHERE token_sha256=?", (token_hash,)).rowcount
    if not removed:
        db.execute("DELETE FROM sessions WHERE token_sha256=?", (token_hash,))


def register_failure(db: sqlite3.Connection, kind: str, ip: str, current: datetime) -> None:
    db.execute("DELETE FROM login_attempts WHERE at <= ?", (timestamp(current - timedelta(minutes=15)),))
    db.execute("INSERT INTO login_attempts(kind,ip,at) VALUES(?,?,?)", (kind, ip, timestamp(current)))


def retry_after(db: sqlite3.Connection, kind: str, ip: str, current: datetime) -> int:
    cutoff = timestamp(current - timedelta(minutes=15))
    row = db.execute(
        "SELECT COUNT(CASE WHEN ip=? THEN 1 END),COUNT(*) FROM login_attempts WHERE kind=? AND at>?",
        (ip, kind, cutoff),
    ).fetchone()
    if kind == "password":
        return 30 if row[0] >= 5 else 0
    return 900 if row[0] >= 10 or row[1] >= 100 else 0


def rate_limited(delay: int) -> JSONResponse:
    return JSONResponse(
        {"detail": "too_many_attempts", "message": "Try again later"},
        status_code=429,
        headers={"Retry-After": str(delay)},
    )


def normalize_code(value: object) -> str:
    if not isinstance(value, str) or len(value) > 128:
        return ""
    compact = "".join(c for c in value if not c.isspace() and unicodedata.category(c) != "Pd")
    if len(compact) != 8 or not compact.isascii():
        return ""
    code = compact.upper().translate(CODE_ALIASES)
    return code if all(c in ALPHABET for c in code) else ""


def auth_router(
    config: Settings, cookies: Cookies, client_ip: Callable[[Request], str], unavailable: set[str]
) -> APIRouter:
    root = config.data_dir
    router = APIRouter(prefix="/api/auth")
    password_slot = anyio.CapacityLimiter(1)

    def current_limit(kind: str, ip: str) -> int:
        with auth_connect(root) as db:
            return retry_after(db, kind, ip, datetime.now(UTC))

    @router.post("/login", status_code=204)
    async def login(request: Request):
        ip = client_ip(request)
        if delay := current_limit("password", ip):
            return rate_limited(delay)
        password = (await read_object(request)).get("password")
        try:
            password_slot.acquire_nowait()
        except anyio.WouldBlock:
            return rate_limited(1)
        try:
            if delay := current_limit("password", ip):
                return rate_limited(delay)
            valid = False
            if isinstance(password, str) and config.password_hash:
                try:
                    valid = await anyio.to_thread.run_sync(
                        PasswordHasher().verify, config.password_hash, password
                    )
                except (argon_exceptions.VerificationError, argon_exceptions.InvalidHashError, UnicodeError):
                    pass
            elif isinstance(password, str) and config.dev_password and not cookies.secure:
                valid = (
                    request.url.scheme == "http"
                    and request.url.hostname in {"127.0.0.1", "localhost"}
                    and urlsplit(config.public_origin).hostname in {"127.0.0.1", "localhost"}
                    and secrets.compare_digest(
                        password.encode(errors="surrogatepass"), config.dev_password.encode()
                    )
                )
            with single_writer():
                with auth_connect(root) as db:
                    current = datetime.now(UTC)
                    if valid:
                        token = create_session(db, root, OWNER_ID, current, request.cookies.get(cookies.name))
                        db.execute("DELETE FROM login_attempts WHERE kind='password' AND ip=?", (ip,))
                    else:
                        register_failure(db, "password", ip, current)
                if not valid:
                    raise HTTPException(401, detail="invalid_password")
                response = Response(status_code=204)
                cookies.set(response, token, 30)
                return response
        finally:
            password_slot.release()

    @router.post("/join", status_code=204)
    async def join(request: Request):
        ip = client_ip(request)
        if delay := current_limit("join", ip):
            return rate_limited(delay)
        body = await read_object(request)
        code_hash = digest(normalize_code(body.get("code")))
        label = body.get("device_label")
        if label is not None:
            if (
                not isinstance(label, str)
                or len(label.strip()) > 80
                or "\x00" in label
                or any("\ud800" <= c <= "\udfff" for c in label)
            ):
                raise HTTPException(422, detail="invalid_device_label")
            label = label.strip() or None
        with single_writer(), auth_connect(root) as db:
            db.execute("BEGIN IMMEDIATE")
            current = datetime.now(UTC)
            at = timestamp(current)
            if delay := retry_after(db, "join", ip, current):
                return rate_limited(delay)
            user_id = None
            for candidate in db.execute(
                "SELECT j.code_sha256,j.user_id FROM join_codes j JOIN users u ON u.id=j.user_id "
                "WHERE j.consumed_at IS NULL AND j.expires_at>? AND u.disabled_at IS NULL",
                (at,),
            ):
                # Keep the comparison independent of the matching code's position.
                if secrets.compare_digest(candidate["code_sha256"], code_hash):
                    user_id = candidate["user_id"]
            if user_id is None:
                register_failure(db, "join", ip, current)
            else:
                if user_id in unavailable:
                    raise HTTPException(503, detail="account_unavailable")
                db.execute("UPDATE join_codes SET consumed_at=? WHERE code_sha256=?", (at, code_hash))
                token = create_session(db, root, user_id, current, request.cookies.get(cookies.name), label)
                response = Response(status_code=204)
                cookies.set(response, token, 180)
                return response
        raise HTTPException(401, detail="invalid_join_code")

    @router.post("/logout", status_code=204)
    async def logout(request: Request):
        token = request.cookies.get(cookies.name)
        with single_writer():
            if token:
                with auth_connect(root) as db:
                    revoke_session(db, root, token)
            response = Response(status_code=204)
            cookies.clear(response)
            return response

    @router.get("/session")
    async def session(request: Request):
        token = request.cookies.get(cookies.name)
        with single_writer():
            current = get_session(root, token, renew=True, unavailable=unavailable) if token else None
            if current is None:
                return signed_out_session()
            response = JSONResponse(
                {"authenticated": True, "expires_at": current.expires_at, "user": current.user}
            )
            if current.renewed:
                cookies.set(response, token, current.days)
            return response

    return router
