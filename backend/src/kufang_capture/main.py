from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from .db import connect, run_migrations
from .settings import Settings, get_settings

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

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers[name] = value
        return response

    @app.get("/api/health")
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

    @app.get("/", include_in_schema=False)
    def static_index():
        return static_response("index.html")

    @app.get("/{path:path}", include_in_schema=False)
    def static_path(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        return static_response(path)

    return app


app = create_app()
