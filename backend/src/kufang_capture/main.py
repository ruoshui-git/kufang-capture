from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import StreamingResponse

from .agent_api import agent_guard, agent_router, is_agent_path
from .auth import (
    AUTH_ROUTES,
    Cookies,
    auth_router,
    get_session,
    init_accounts,
    read_object,
    require_session,
    signed_out_session,
    user_data_dir,
)
from .db import connect, single_writer
from .exports import build_export
from .people import people_router
from .photos import (
    get_photo,
    head_original,
    patch_original,
    remove_partial_uploads,
    upload_original,
    upload_thumbnail,
)
from .settings import Settings, get_settings
from .sync import apply_batch, now, pull_changes

SYNC_BATCH_BYTES = 8 * 1024 * 1024

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
    unavailable: set[str] = set()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        failed = init_accounts(config.data_dir)
        unavailable.clear()
        unavailable.update(failed)
        yield

    app = FastAPI(lifespan=lifespan)
    cookies = Cookies(config.public_origin.startswith("https://"))
    authorize = partial(require_session, config.data_dir)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        code = exc.detail if isinstance(exc.detail, str) else "request_failed"
        if is_agent_path(request.url.path):
            return JSONResponse({"detail": code}, status_code=exc.status_code, headers=exc.headers)
        messages = {
            "account_unavailable": "Account data is temporarily unavailable",
            "auth_required": "Authentication is required",
            "csrf_failed": "Request verification failed",
            "invalid_password": "Password is incorrect",
            "invalid_join_code": "Code is invalid or expired",
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

    guard_agent = agent_guard(config, get_client_ip)
    app.include_router(agent_router(config))
    app.include_router(auth_router(config, cookies, get_client_ip, unavailable))
    app.include_router(people_router(config))

    async def auth_and_csrf(request: Request, call_next):
        if is_agent_path(request.url.path):
            response = guard_agent(request)
            if response is None:
                response = await call_next(request)
            return response
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
        if (request.method, request.url.path) in AUTH_ROUTES:
            response = await call_next(request)
            if request.method == "GET" and "set-cookie" in response.headers:
                # Suppress a prepared renewal if sign-in, logout or disable revoked its token.
                token = request.cookies.get(cookies.name)
                with single_writer():
                    if not token or get_session(config.data_dir, token) is None:
                        return signed_out_session()
            return response
        token = request.cookies.get(cookies.name)
        try:
            with single_writer():
                session = (
                    get_session(config.data_dir, token, touch=True, unavailable=unavailable)
                    if token
                    else None
                )
        except HTTPException as exc:
            return await http_error(request, exc)
        if session is None:
            return JSONResponse(
                {"detail": "auth_required", "message": "Authentication is required"}, status_code=401
            )
        user = session.user
        is_people = request.url.path == "/api/people" or request.url.path.startswith("/api/people/")
        accounts = request.headers.getlist("x-capture-account")
        if is_people and not user["is_owner"]:
            response = JSONResponse({"detail": "owner_required"}, status_code=403)
        elif accounts and accounts != [user["id"]]:
            response = JSONResponse({"detail": "account_mismatch"}, status_code=409)
        elif not accounts and not user["is_owner"]:
            response = JSONResponse({"detail": "account_required"}, status_code=409)
        else:
            request.state.user = user
            request.state.session_token = token
            request.state.data_dir = user_data_dir(config.data_dir, user["id"])
            response = await call_next(request)
            if request.method in {"GET", "HEAD"}:
                # call_next has captured the response start. Check before forwarding it or any bytes.
                try:
                    with single_writer():
                        authorize(request)
                except HTTPException as exc:
                    return await http_error(request, exc)
        return response

    @app.post("/api/sync/batch")
    async def sync_batch(request: Request):
        body = await read_object(request, limit=SYNC_BATCH_BYTES)
        schema = body.get("schema")
        if type(schema) is not int or schema not in (2, 3):
            return JSONResponse(
                {"detail": "client_outdated", "message": "This client must upgrade to sync schema 3"},
                status_code=409,
            )
        mutations = body.get("mutations")
        if not isinstance(mutations, list) or len(mutations) > 200:
            raise HTTPException(422, detail="invalid_batch")
        results, cursor = apply_batch(
            request.state.data_dir, mutations, partial(authorize, request), schema=schema
        )
        return {"results": results, "cursor": cursor}

    @app.get("/api/sync/changes")
    def sync_changes(request: Request, cursor: int = 0, limit: int = 500, schema: int | None = None):
        if schema not in (2, 3):
            return JSONResponse(
                {"detail": "client_outdated", "message": "This client must upgrade to sync schema 3"},
                status_code=409,
            )
        return pull_changes(request.state.data_dir, max(cursor, 0), min(max(limit, 1), 1000), schema=schema)

    @app.put("/api/photos/{photo_id}/original", status_code=201)
    async def photo_original_put(photo_id: str, request: Request):
        with connect(request.state.data_dir) as db:
            existing = db.execute("SELECT stored_at FROM photos WHERE id=?", (photo_id,)).fetchone()
        response = await upload_original(
            request,
            request.state.data_dir,
            config.max_photo_bytes,
            config.min_free_bytes,
            partial(authorize, request),
        )
        return JSONResponse(response, status_code=200 if existing and existing[0] else 201)

    @app.patch("/api/photos/{photo_id}/original", status_code=201)
    async def photo_original_patch(photo_id: str, request: Request):
        return await patch_original(
            request,
            request.state.data_dir,
            config.max_photo_bytes,
            config.min_free_bytes,
            partial(authorize, request),
        )

    @app.head("/api/photos/{photo_id}/original")
    def photo_original_head(photo_id: str, request: Request):
        return Response(status_code=200, headers=head_original(request.state.data_dir, photo_id))

    @app.get("/api/photos/{photo_id}/original")
    def photo_original_get(photo_id: str, request: Request):
        return get_photo(request.state.data_dir, photo_id, False)

    @app.put("/api/photos/{photo_id}/thumbnail")
    async def photo_thumbnail_put(photo_id: str, request: Request):
        return await upload_thumbnail(request, request.state.data_dir, partial(authorize, request))

    @app.get("/api/photos/{photo_id}/thumbnail")
    @app.head("/api/photos/{photo_id}/thumbnail", include_in_schema=False)
    def photo_thumbnail_get(photo_id: str, request: Request):
        return get_photo(request.state.data_dir, photo_id, True)

    @app.get("/api/collections")
    def collections(request: Request):
        with connect(request.state.data_dir) as db:
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
                    "FROM entries e JOIN items i ON i.id=e.item_id JOIN photos p ON p.item_id=i.id "
                    "WHERE e.collection_id=? AND p.deleted_at IS NULL AND e.deleted_at IS NULL",
                    (cid,),
                ).fetchone()
                missing = db.execute(
                    "SELECT COUNT(*) FROM entries e JOIN items i ON i.id=e.item_id "
                    "JOIN photos p ON p.item_id=i.id "
                    "WHERE e.collection_id=? AND p.deleted_at IS NULL AND p.stored_at IS NULL "
                    "AND e.deleted_at IS NULL",
                    (cid,),
                ).fetchone()[0]
                result.append(
                    {
                        "id": collection["id"],
                        "name": collection["name"],
                        "folder": collection["folder"],
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
        data_dir = request.state.data_dir
        confirm = unquote(request.headers.get("x-confirm-name", ""))
        media_files = []
        with single_writer(), connect(data_dir) as db:
            authorize(request)
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT name FROM collections WHERE id=?", (collection_id,)).fetchone()
            if row is None:
                raise HTTPException(404, detail="collection_not_found")
            if confirm != row[0]:
                raise HTTPException(409, detail="confirmation_name_mismatch")
            orphan_items = [
                r[0]
                for r in db.execute(
                    "SELECT DISTINCT e.item_id FROM entries e WHERE e.collection_id=? "
                    "AND NOT EXISTS (SELECT 1 FROM entries other WHERE other.item_id=e.item_id "
                    "AND other.collection_id<>?)",
                    (collection_id, collection_id),
                )
            ]
            db.execute("DELETE FROM collections WHERE id=?", (collection_id,))
            purged_photo_ids = []
            for item_id in orphan_items:
                media_files.extend(
                    r[0]
                    for r in db.execute(
                        "SELECT storage_key FROM photos WHERE item_id=? AND storage_key IS NOT NULL",
                        (item_id,),
                    )
                )
                photo_ids = [r[0] for r in db.execute("SELECT id FROM photos WHERE item_id=?", (item_id,))]
                purged_photo_ids.extend(photo_ids)
                media_files.extend(f"media/thumbnails/{pid[:2]}/{pid}" for pid in photo_ids)
                for photo_id in photo_ids:
                    db.execute("DELETE FROM photos WHERE id=?", (photo_id,))
                    db.execute(
                        "INSERT INTO changes(entity,entity_id,collection_id,kind) "
                        "VALUES('photo',?,'','purged')",
                        (photo_id,),
                    )
                db.execute("DELETE FROM items WHERE id=?", (item_id,))
                db.execute(
                    "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES('item',?,'','purged')",
                    (item_id,),
                )
            db.execute(
                "INSERT INTO changes(entity,entity_id,collection_id,kind,changed_at) "
                "VALUES('collection',?,?, 'removed',?)",
                (collection_id, collection_id, now()),
            )
            db.commit()
            for key in media_files:
                (data_dir / key).unlink(missing_ok=True)
            for photo_id in purged_photo_ids:
                remove_partial_uploads(data_dir, photo_id)
        return Response(status_code=204)

    def export_response(data_dir: Path, collection_id: str | None, include_trash: bool):
        try:
            filename, chunks = build_export(data_dir, collection_id, include_trash, config.app_version)
        except KeyError:
            raise HTTPException(404, detail="collection_not_found") from None
        return StreamingResponse(
            chunks,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/exports/all.zip")
    def export_all(request: Request, include_trash: int = 0):
        return export_response(request.state.data_dir, None, include_trash == 1)

    @app.get("/api/exports/collections/{collection_id}.zip")
    def export_collection(collection_id: str, request: Request, include_trash: int = 0):
        return export_response(request.state.data_dir, collection_id, include_trash == 1)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await auth_and_csrf(request, call_next)
        path = request.url.path
        if path.startswith("/api/photos/"):
            response.headers["Cache-Control"] = "private, no-store"
            response.headers.add_vary_header("Cookie, X-Capture-Account")
        elif path.startswith("/api/") and path != "/api/health":
            response.headers["Cache-Control"] = "no-store"
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
