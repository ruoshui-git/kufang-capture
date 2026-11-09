import shutil
import sqlite3

from kufang_capture.db import connect, run_migrations, single_writer
from kufang_capture.snapshot import create_snapshot


def test_migrations_are_recorded_and_idempotent(tmp_path):
    data = tmp_path / "data"
    run_migrations(data)
    run_migrations(data)
    with connect(data) as db:
        versions = {row[0] for row in db.execute("SELECT version FROM schema_migrations")}
        assert versions == {"0001_initial.sql", "0002_sync.sql", "0003_items.sql"}
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert db.execute("PRAGMA busy_timeout").fetchone()[0] == 5000


def test_items_migration_splits_shared_fields_and_keeps_photo_storage(tmp_path):
    from pathlib import Path

    from kufang_capture.db import connect

    data = tmp_path / "legacy"
    migrations = Path(__file__).parents[1] / "src" / "kufang_capture" / "migrations"
    legacy_migrations = tmp_path / "legacy-migrations"
    legacy_migrations.mkdir()
    shutil.copy(migrations / "0001_initial.sql", legacy_migrations)
    shutil.copy(migrations / "0002_sync.sql", legacy_migrations)
    original_media = data / "media" / "originals" / "p" / "p"
    thumbnail_media = data / "media" / "thumbnails" / "p" / "p"
    original_media.parent.mkdir(parents=True)
    thumbnail_media.parent.mkdir(parents=True)
    original_media.write_bytes(b"original bytes remain untouched")
    thumbnail_media.write_bytes(b"thumbnail bytes remain untouched")
    run_migrations(data, migrations_dir=legacy_migrations)
    with connect(data) as db:
        db.execute(
            "INSERT INTO collections(id,name,status,storage_mode,created_at,updated_at) "
            "VALUES('c','C','active','synced','t0','t1')"
        )
        db.execute(
            "INSERT INTO entries(id,collection_id,sequence_number,title,quantity,unit,count_detail,notes,"
            "expiration_date,dimensions,review_status,deleted_at,revision,field_revisions,"
            "created_at,updated_at) "
            "VALUES('e','c',42,'Shared','2','box','detail','note','2030-01-02','wide','complete','deleted',7,"
            '\'{"title":3,"notes":4,"quantity":5,"count_detail":8,'
            "\"review_status\":6,\"other\":9}', 't0','t9')"
        )
        db.execute(
            "INSERT INTO photos(id,entry_id,collection_id,mime_type,byte_size,sha256,crc32,captured_at,"
            "capture_source,created_at,updated_at,stored_at,storage_key,thumb_stored_at) "
            "VALUES('p','e','c','image/jpeg',1,?,1,'t2','native_camera','t0','t3','t4',"
            "'media/originals/p/p','t5')",
            ("a" * 64,),
        )
        db.commit()
    run_migrations(data, migrations_dir=migrations)
    with connect(data) as db:
        item = db.execute("SELECT * FROM items WHERE id='e'").fetchone()
        entry = db.execute("SELECT * FROM entries WHERE id='e'").fetchone()
        photo = db.execute("SELECT * FROM photos WHERE id='p'").fetchone()
        assert (item["id"], item["revision"], item["title"], item["updated_at"]) == ("e", 7, "Shared", "t9")
        assert set(__import__("json").loads(item["field_revisions"])) == {"title", "notes", "review_status"}
        assert (entry["item_id"], entry["sequence_number"], entry["revision"], entry["deleted_at"]) == (
            "e",
            42,
            7,
            "deleted",
        )
        assert set(__import__("json").loads(entry["field_revisions"])) == {"quantity", "count_detail"}
        assert (photo["item_id"], photo["stored_at"], photo["storage_key"], photo["thumb_stored_at"]) == (
            "e",
            "t4",
            "media/originals/p/p",
            "t5",
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        # Every migrated item is published so a device pulling from scratch receives it.
        published = db.execute("SELECT entity_id, collection_id, kind FROM changes WHERE entity='item'")
        assert [tuple(row) for row in published] == [("e", "", "upsert")]
    assert original_media.read_bytes() == b"original bytes remain untouched"
    assert thumbnail_media.read_bytes() == b"thumbnail bytes remain untouched"


def test_single_writer_context_acquires_and_releases_lock():
    with single_writer():
        assert True


def test_snapshot_uses_online_backup_and_passes_integrity_check(tmp_path):
    data = tmp_path / "data"
    run_migrations(data)
    with connect(data) as db:
        db.execute("INSERT INTO meta(key, value) VALUES ('test', 'ok')")
    destination = tmp_path / "snapshots" / "copy.sqlite3"

    create_snapshot(destination, data)

    with sqlite3.connect(destination) as backup:
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert backup.execute("SELECT value FROM meta WHERE key='test'").fetchone()[0] == "ok"
