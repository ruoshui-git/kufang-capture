from fastapi.testclient import TestClient

from kufang_capture.main import create_app
from kufang_capture.settings import Settings


def test_health_migrates_database_and_sets_security_headers(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=tmp_path / "static", app_version="test"))
    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "test"}
    assert response.headers["content-security-policy"].startswith("default-src 'self'")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "same-origin"
    assert response.headers["permissions-policy"] == "camera=(self), microphone=(), geolocation=()"


def test_unknown_api_is_json_404(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    with TestClient(app) as client:
        response = client.get("/api/not-a-route")
    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}
    assert response.headers["content-type"].startswith("application/json")


def test_static_files_cache_rules_and_spa_fallback(tmp_path):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<main>SPA</main>")
    (static / "assets" / "app.js").write_text("console.log('app')")
    (static / "sw.js").write_text("self.skipWaiting()")
    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=static))

    with TestClient(app) as client:
        root = client.get("/")
        route = client.get("/collections/one")
        asset = client.get("/assets/app.js")
        worker = client.get("/sw.js")
        missing_asset = client.get("/missing.js")

    assert root.text == "<main>SPA</main>"
    assert route.text == "<main>SPA</main>"
    assert route.headers["cache-control"] == "no-cache"
    assert asset.text == "console.log('app')"
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert worker.headers["cache-control"] == "no-cache"
    assert missing_asset.status_code == 404


def test_static_path_traversal_is_rejected(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (tmp_path / "secret.txt").write_text("private")
    (static / "index.html").write_text("SPA")
    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=static))

    with TestClient(app) as client:
        response = client.get("/%2e%2e/secret.txt")

    assert response.status_code == 404
    assert response.text != "private"


def test_head_requests_are_supported_for_spa_and_health(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<main>SPA</main>")
    app = create_app(Settings(data_dir=tmp_path / "data", static_dir=static))
    with TestClient(app) as client:
        assert client.head("/").status_code == 200
        assert client.head("/c/some-collection").status_code == 200
        assert client.head("/api/health").status_code == 200
