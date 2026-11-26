import json
import os
import zipfile
from pathlib import Path

from kufang_capture.db import connect, run_migrations
from kufang_capture.exports import _assign_paths, _sanitize, build_export

VECTORS = json.loads((Path(__file__).parents[2] / "tools/export-path-vectors.json").read_text())
AT = "2026-11-08T07:00:00.000Z"


def test_shared_sanitize_vectors():
    for vector in VECTORS["sanitize"]:
        assert _sanitize(vector["input"]) == vector["expected"], vector["name"]


def test_shared_assignment_vectors():
    data = VECTORS["assignment"]
    collections = [{"id": row["id"], "name": row["name"]} for row in data["collections"]]
    items = {}
    entries = []
    for row in data["entries"]:
        items[row["item"]] = {"title": row["title"]}
        entries.append(
            {
                "id": row["id"],
                "item_id": row["item"],
                "collection_id": row["collection"],
                "sequence_number": row["sequence"],
                "active": row["active"],
            }
        )
    photos = [{"id": row["id"], "item_id": row["item"], "mime_type": "image/jpeg"} for row in data["photos"]]
    active_items = {row["item_id"] for row in entries if row["active"]}
    active_photos = [
        row
        for row, source in zip(photos, data["photos"], strict=True)
        if source["active"] and row["item_id"] in active_items
    ]
    trash_photos = [
        row
        for row, source in zip(photos, data["photos"], strict=True)
        if not source["active"] or row["item_id"] not in active_items
    ]
    active = _assign_paths(
        collections, items, [row for row in entries if row["active"]], active_photos, active_items
    )
    trash = _assign_paths(
        collections,
        items,
        [row for row in entries if row["active"]] + [row for row in entries if not row["active"]],
        trash_photos,
        active_items,
        True,
    )
    expected = data["expected"]
    assert active[0] == expected["collection_dirs"]
    assert {key: active[2][key] for key in expected["active"]["photo_dirs"]} == expected["active"][
        "photo_dirs"
    ]
    assert active[3] == expected["active"]["photo_paths"]
    assert {key: trash[2][key] for key in expected["trash"]["photo_dirs"]} == expected["trash"]["photo_dirs"]
    assert trash[3] == expected["trash"]["photo_paths"]


def test_server_export_v3_layout_and_columns_match_vectors(tmp_path):
    data_dir = tmp_path / "data"
    run_migrations(data_dir)
    vectors = VECTORS["assignment"]
    with connect(data_dir) as db:
        for collection in vectors["collections"]:
            db.execute(
                "INSERT INTO collections(id,name,status,storage_mode,next_sequence_number,"
                "created_at,updated_at) "
                "VALUES(?,?,'active','synced',100,?,?)",
                (collection["id"], collection["name"], AT, AT),
            )
        item_titles = {}
        for entry in vectors["entries"]:
            item_titles[entry["item"]] = entry["title"]
        for item_id, title in item_titles.items():
            db.execute(
                "INSERT INTO items(id,title,notes,dimensions,review_status,created_at,updated_at) "
                "VALUES(?,?,'','','draft',?,?)",
                (item_id, title, AT, AT),
            )
        for entry in vectors["entries"]:
            db.execute(
                "INSERT INTO entries(id,collection_id,item_id,sequence_number,deleted_at,"
                "created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    entry["id"],
                    entry["collection"],
                    entry["item"],
                    entry["sequence"],
                    None if entry["active"] else AT,
                    AT,
                    AT,
                ),
            )
        for photo in vectors["photos"]:
            content = photo["id"].encode()
            storage_key = f"media/originals/{photo['id']}"
            original = data_dir / storage_key
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_bytes(content)
            import hashlib
            import zlib

            db.execute(
                "INSERT INTO photos(id,item_id,sort_order,original_filename,mime_type,byte_size,sha256,crc32,"
                "captured_at,capture_source,deleted_at,created_at,updated_at,storage_key) "
                "VALUES(?,?,0,?,'image/jpeg',?,?,?,?, 'native_camera',?,?,?,?)",
                (
                    photo["id"],
                    photo["item"],
                    f"{photo['id']}.jpg",
                    len(content),
                    hashlib.sha256(content).hexdigest(),
                    zlib.crc32(content) & 0xFFFFFFFF,
                    AT,
                    None if photo["active"] else AT,
                    AT,
                    AT,
                    storage_key,
                ),
            )
    _, stream = build_export(data_dir, None, True, "test")
    archive_path = tmp_path / "server-v3.zip"
    archive_path.write_bytes(b"".join(stream))
    if os.environ.get("W2_EXPORT_SAMPLE") == "1":
        sample = Path("/tmp/codex-runs/w2-export-v3-shots")
        sample.mkdir(parents=True, exist_ok=True)
        (sample / "server-v3.zip").write_bytes(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        manifest = json.loads(archive.read("capture-export/manifest.json"))
        assert manifest["format_version"] == 4
        collections = json.loads(archive.read("capture-export/collections.json"))
        entries = json.loads(archive.read("capture-export/entries.json"))
        photos = json.loads(archive.read("capture-export/photos.json"))
        trash_entries = json.loads(archive.read("capture-export/trash/entries.json"))
        trash_photos = json.loads(archive.read("capture-export/trash/photos.json"))
        assert [row["folder"] for row in collections] == [""] * 3
        assert "entry_notes" in entries[0] and "starred_at" in entries[0] and "photo_dir" in entries[0]
        assert {row["photo_id"]: row["path"] for row in photos} == vectors["expected"]["active"][
            "photo_paths"
        ]
        assert {row["photo_id"]: row["path"] for row in trash_photos} == vectors["expected"]["trash"][
            "photo_paths"
        ]
        assert all(
            row["photo_dir"] == vectors["expected"]["trash"]["photo_dirs"].get(row["entry_id"], "")
            for row in trash_entries
        )
