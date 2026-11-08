import hashlib
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import unquote, urlsplit

import anyio
from argon2 import PasswordHasher
from argon2 import exceptions as argon_exceptions
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import StreamingResponse

from .db import connect, run_migrations, single_writer
from .exports import build_export
from .photos import get_photo, head_original, upload_original, upload_thumbnail
from .settings import Settings, get_settings
from .sync import apply_batch, now, pull_changes

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
        "worker-src 'self'; manifest-src 'self'; font-src 'self'; frame-ancestors 'none'; "
        "base-uri 'self'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        run_migrations(config.data_dir)
        yield

    app = FastAPI(lifespan=lifespan)
    cookie_name = "__Host-kc_session" if config.public_origin.startswith("https://") else "kc_session"
    secure_cookie = config.public_origin.startswith("https://")

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        code = exc.detail if isinstance(exc.detail, str) else "request_failed"
        messages = {
            "auth_required": "Authentication is required",
            "csrf_failed": "Request verification failed",
            "invalid_password": "Password is incorrect",
            "too_many_attempts": "Try again later",
            "photo_metadata_missing": "Photo metadata must sync before upload",
            "checksum_mismatch": "Photo checksum does not match metadata",
            "server_storage_low": "Server storage is low",
            "photo_too_large": "Photo exceeds size limit",
        }
        headers = exc.headers or {}
        return JSONResponse(
            {"detail": code, "message": messages.get(code, code.replace("_", " "))},
            status_code=exc.status_code,
            headers=headers,
        )

    def get_client_ip(request: Request) -> str:
        # Traefik appends the peer it observed to XFF. The rightmost value is its
        # authenticated observation; earlier values may be client supplied.
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[-1].strip() or (request.client.host if request.client else "unknown")
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def auth_and_csrf(request: Request, call_next):
        if request.url.path == "/api/health" or not request.url.path.startswith("/api/"):
            return await call_next(request)
        # Deny by default: every /api path except health and auth requires a session.
        unsafe = request.method in {"POST", "PUT", "PATCH", "DELETE"}
        if unsafe and (
            request.headers.get("x-capture-request") != "1"
            or (
                request.headers.get("origin")
                and request.headers["origin"].rstrip("/") != config.public_origin.rstrip("/")
            )
        ):
            return JSONResponse(
                {"detail": "csrf_failed", "message": "Request verification failed"}, status_code=403
            )
        if request.url.path.startswith("/api/auth/"):
            return await call_next(request)
        token = request.cookies.get(cookie_name)
        if not token:
            return JSONResponse(
                {"detail": "auth_required", "message": "Authentication is required"}, status_code=401
            )
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with connect(config.data_dir) as db:
            session = db.execute(
                "SELECT expires_at FROM sessions WHERE token_sha256=?", (token_hash,)
            ).fetchone()
            if not session or session[0] <= now():
                db.execute("DELETE FROM sessions WHERE token_sha256=?", (token_hash,))
                return JSONResponse(
                    {"detail": "auth_required", "message": "Authentication is required"}, status_code=401
                )
            expires = datetime.fromisoformat(session[0].replace("Z", "+00:00"))
            renewal_expiry = None
            if expires - datetime.now(UTC) < timedelta(days=15):
                new_expiry = (
                    (datetime.now(UTC) + timedelta(days=30))
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z")
                )
                db.execute("UPDATE sessions SET expires_at=? WHERE token_sha256=?", (new_expiry, token_hash))
                renewal_expiry = new_expiry
        response = await call_next(request)
        if renewal_expiry is not None:
            response.set_cookie(
                cookie_name,
                token,
                max_age=30 * 24 * 60 * 60,
                httponly=True,
                secure=secure_cookie,
                samesite="strict",
                path="/",
            )
        return response

    @app.post("/api/auth/login", status_code=204)
    async def login(request: Request):
        body = await request.json()
        password = body.get("password") if isinstance(body, dict) else None
        ip = get_client_ip(request)
        at = now()
        with single_writer(), connect(config.data_dir) as db:
            db.execute(
                "DELETE FROM login_attempts WHERE at < ?",
                ((datetime.now(UTC) - timedelta(minutes=15)).isoformat(),),
            )
            failures = db.execute(
                "SELECT COUNT(*) FROM login_attempts WHERE ip=? AND at >= ?",
                (ip, (datetime.now(UTC) - timedelta(minutes=15)).isoformat()),
            ).fetchone()[0]
        valid = False
        if isinstance(password, str) and config.password_hash:
            try:
                valid = await anyio.to_thread.run_sync(
                    PasswordHasher().verify, config.password_hash, password
                )
            except (argon_exceptions.VerificationError, argon_exceptions.InvalidHashError):
                valid = False
        elif isinstance(password, str) and config.dev_password and not secure_cookie:
            public_host = urlsplit(config.public_origin).hostname
            valid = (
                request.url.scheme == "http"
                and request.url.hostname in {"127.0.0.1", "localhost"}
                and public_host in {"127.0.0.1", "localhost"}
                and secrets.compare_digest(password, config.dev_password)
            )
        if failures >= 5:
            delay = min(900, 30 * (2 ** min(failures - 5, 5)))
            with single_writer(), connect(config.data_dir) as db:
                db.execute("INSERT INTO login_attempts(ip,at) VALUES(?,?)", (ip, at))
            return JSONResponse(
                {"detail": "too_many_attempts", "message": "Try again later"},
                status_code=429,
                headers={"Retry-After": str(delay)},
            )
        if not valid:
            with single_writer(), connect(config.data_dir) as db:
                db.execute("INSERT INTO login_attempts(ip,at) VALUES(?,?)", (ip, at))
            raise HTTPException(401, detail="invalid_password")
        token = secrets.token_urlsafe(32)
        expiry = (
            (datetime.now(UTC) + timedelta(days=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )
        with single_writer(), connect(config.data_dir) as db:
            db.execute(
                "INSERT INTO sessions(token_sha256,created_at,expires_at) VALUES(?,?,?)",
                (hashlib.sha256(token.encode()).hexdigest(), at, expiry),
            )
            db.execute("DELETE FROM login_attempts WHERE ip=?", (ip,))
        response = Response(status_code=204)
        response.set_cookie(
            cookie_name,
            token,
            max_age=30 * 24 * 60 * 60,
            httponly=True,
            secure=secure_cookie,
            samesite="strict",
            path="/",
        )
        return response

    @app.post("/api/auth/logout", status_code=204)
    async def logout(request: Request):
        token = request.cookies.get(cookie_name)
        if token:
            with connect(config.data_dir) as db:
                db.execute(
                    "DELETE FROM sessions WHERE token_sha256=?", (hashlib.sha256(token.encode()).hexdigest(),)
                )
        response = Response(status_code=204)
        response.delete_cookie(cookie_name, path="/", secure=secure_cookie, httponly=True, samesite="strict")
        return response

    @app.get("/api/auth/session")
    def session(request: Request):
        token = request.cookies.get(cookie_name)
        if not token:
            return {"authenticated": False, "expires_at": None}
        with connect(config.data_dir) as db:
            row = db.execute(
                "SELECT expires_at FROM sessions WHERE token_sha256=?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            ).fetchone()
        if row is None or row[0] <= now():
            return {"authenticated": False, "expires_at": None}
        return {"authenticated": True, "expires_at": row[0]}

    @app.post("/api/sync/batch")
    async def sync_batch(request: Request):
        body = await request.json()
        mutations = body.get("mutations") if isinstance(body, dict) else None
        if not isinstance(mutations, list) or len(mutations) > 200:
            raise HTTPException(422, detail="invalid_batch")
        results, cursor = apply_batch(config.data_dir, mutations)
        return {"results": results, "cursor": cursor}

    @app.get("/api/sync/changes")
    def sync_changes(cursor: int = 0, limit: int = 500):
        return pull_changes(config.data_dir, max(cursor, 0), min(max(limit, 1), 1000))

    @app.put("/api/photos/{photo_id}/original", status_code=201)
    async def photo_original_put(photo_id: str, request: Request):
        with connect(config.data_dir) as db:
            existing = db.execute("SELECT stored_at FROM photos WHERE id=?", (photo_id,)).fetchone()
        response = await upload_original(
            request, config.data_dir, config.max_photo_bytes, config.min_free_bytes
        )
        return JSONResponse(response, status_code=200 if existing and existing[0] else 201)

    @app.head("/api/photos/{photo_id}/original")
    def photo_original_head(photo_id: str):
        from fastapi.responses import Response as EmptyResponse

        return EmptyResponse(status_code=200, headers=head_original(config.data_dir, photo_id))

    @app.get("/api/photos/{photo_id}/original")
    def photo_original_get(photo_id: str):
        return get_photo(config.data_dir, photo_id, False)

    @app.put("/api/photos/{photo_id}/thumbnail")
    async def photo_thumbnail_put(photo_id: str, request: Request):
        return await upload_thumbnail(request, config.data_dir)

    @app.get("/api/photos/{photo_id}/thumbnail")
    def photo_thumbnail_get(photo_id: str):
        return get_photo(config.data_dir, photo_id, True)

    @app.get("/api/collections")
    def collections():
        with connect(config.data_dir) as db:
            rows = db.execute("SELECT * FROM collections ORDER BY created_at,id").fetchall()
            result = []
            for collection in rows:
                cid = collection["id"]
                counts = db.execute(
                    "SELECT COUNT(*) FROM entries WHERE collection_id=? AND deleted_at IS NULL",
                    (cid,),
                ).fetchone()[0]
                photos = db.execute(
                    "SELECT COUNT(*), "
                    "COALESCE(SUM(CASE WHEN p.stored_at IS NOT NULL THEN p.byte_size ELSE 0 END),0) "
                    "FROM photos p JOIN entries e ON e.id=p.entry_id "
                    "WHERE p.collection_id=? AND p.deleted_at IS NULL AND e.deleted_at IS NULL",
                    (cid,),
                ).fetchone()
                missing = db.execute(
                    "SELECT COUNT(*) FROM photos p JOIN entries e ON e.id=p.entry_id "
                    "WHERE p.collection_id=? AND p.deleted_at IS NULL AND p.stored_at IS NULL "
                    "AND e.deleted_at IS NULL",
                    (cid,),
                ).fetchone()[0]
                result.append(
                    {
                        "id": collection["id"],
                        "name": collection["name"],
                        "status": collection["status"],
                        "updated_at": collection["updated_at"],
                        "entry_count": counts,
                        "photo_count": photos[0],
                        "stored_photo_bytes": photos[1],
                        "missing_originals": missing,
                    }
                )
        return result

    @app.delete("/api/collections/{collection_id}/server-copy", status_code=204)
    def remove_server_copy(collection_id: str, request: Request):
        confirm = unquote(request.headers.get("x-confirm-name", ""))
        media_files = []
        with single_writer(), connect(config.data_dir) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT name FROM collections WHERE id=?", (collection_id,)).fetchone()
            if row is None:
                raise HTTPException(404, detail="collection_not_found")
            if confirm != row[0]:
                raise HTTPException(409, detail="confirmation_name_mismatch")
            media_files = [
                r[0]
                for r in db.execute(
                    "SELECT storage_key FROM photos WHERE collection_id=? AND storage_key IS NOT NULL",
                    (collection_id,),
                )
            ]
            media_files.extend(
                f"media/thumbnails/{photo_id[:2]}/{photo_id}"
                for (photo_id,) in db.execute("SELECT id FROM photos WHERE collection_id=?", (collection_id,))
            )
            db.execute("DELETE FROM collections WHERE id=?", (collection_id,))
            db.execute(
                "INSERT INTO changes(entity,entity_id,collection_id,kind) "
                "VALUES('collection',?,?, 'removed')",
                (collection_id, collection_id),
            )
            db.commit()
        for key in media_files:
            (config.data_dir / key).unlink(missing_ok=True)
        return Response(status_code=204)

    def export_response(collection_id: str | None, include_trash: bool):
        try:
            filename, chunks = build_export(config.data_dir, collection_id, include_trash, config.app_version)
        except KeyError:
            raise HTTPException(404, detail="collection_not_found") from None
        return StreamingResponse(
            chunks,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/exports/all.zip")
    def export_all(include_trash: int = 0):
        return export_response(None, include_trash == 1)

    @app.get("/api/exports/collections/{collection_id}.zip")
    def export_collection(collection_id: str, include_trash: int = 0):
        return export_response(collection_id, include_trash == 1)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers[name] = value
        return response

    @app.api_route("/api/health", methods=["GET", "HEAD"])
    def health() -> JSONResponse:
        try:
            with connect(config.data_dir) as connection:
                connection.execute("SELECT 1").fetchone()
        except Exception:
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return JSONResponse({"status": "ok", "version": config.app_version})

    @app.get("/api")
    def unknown_api_root() -> JSONResponse:
        return JSONResponse({"detail": "Not found"}, status_code=404)

    @app.get("/api/{api_path:path}")
    def unknown_api(api_path: str) -> JSONResponse:
        return JSONResponse({"detail": "Not found"}, status_code=404)

    static_root = config.static_dir.resolve()

    def static_response(path: str):
        relative = path or "index.html"
        candidate = (static_root / relative).resolve()
        try:
            candidate.relative_to(static_root)
        except ValueError:
            return JSONResponse({"detail": "Not found"}, status_code=404)

        if candidate.is_file():
            response = FileResponse(candidate)
            filename = candidate.name
            if filename in {"index.html", "sw.js", "registerSW.js", "manifest.webmanifest"} or (
                filename.startswith("workbox-") and filename.endswith(".js")
            ):
                response.headers["Cache-Control"] = "no-cache"
            elif relative.startswith("assets/"):
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return response

        if Path(relative).suffix:
            return JSONResponse({"detail": "Not found"}, status_code=404)
        index = (static_root / "index.html").resolve()
        try:
            index.relative_to(static_root)
        except ValueError:
            return JSONResponse({"detail": "Not found"}, status_code=404)
        if index.is_file():
            response = FileResponse(index)
            response.headers["Cache-Control"] = "no-cache"
            return response
        return JSONResponse({"detail": "Not found"}, status_code=404)

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def static_index():
        return static_response("index.html")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def static_path(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        return static_response(path)

    return app


app = create_app()
