import json
import shutil
import sqlite3
from contextlib import closing

import pytest

from kufang_capture.auth import auth_connect, init_accounts, user_data_dir
from kufang_capture.db import connect, run_migrations, single_writer
from kufang_capture.snapshot import create_snapshot, main, prune_snapshots, restore_snapshot


def test_migrations_are_recorded_and_idempotent(tmp_path):
    data = tmp_path / "data"
    run_migrations(data)
    run_migrations(data)
    with connect(data) as db:
        versions = {row[0] for row in db.execute("SELECT version FROM schema_migrations")}
        assert versions == {
            "0001_initial.sql",
            "0002_sync.sql",
            "0003_items.sql",
            "0004_folders_stars.sql",
            "0005_removal_timestamp.sql",
        }
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
    destination = tmp_path / "snapshots" / "copy"
    with connect(data) as db:
        db.execute("INSERT INTO meta(key, value) VALUES ('test', 'ok')")
        db.commit()
        assert (data / "capture.sqlite3-wal").stat().st_size > 0
        db.execute("INSERT INTO meta(key, value) VALUES ('pending', 'not committed')")
        create_snapshot(destination, data)

    with closing(sqlite3.connect(destination / "capture.sqlite3")) as backup:
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert backup.execute("SELECT key, value FROM meta").fetchall() == [("test", "ok")]


def test_snapshot_restore_covers_auth_and_all_user_databases_and_keeps_media(tmp_path):
    data = tmp_path / "data"
    init_accounts(data)
    first = "01J00000000000000000000001"
    second = "01J00000000000000000000002"

    def add_user(user_id, disabled=None):
        directory = user_data_dir(data, user_id)
        run_migrations(directory)
        with auth_connect(data) as db:
            db.execute(
                "INSERT INTO users(id,name,name_key,is_owner,created_at,disabled_at) VALUES(?,?,?,0,?,?)",
                (user_id, user_id, user_id, "created", disabled),
            )
        return directory

    helper = add_user(first, disabled="disabled")
    media = helper / "media"
    media.mkdir()
    (media / "original").write_bytes(b"preserved")
    for directory, value in ((data, "owner"), (helper, "helper")):
        with connect(directory) as db:
            db.execute("INSERT INTO meta VALUES('sentinel',?)", (value,))
    with connect(data) as db:
        db.execute("INSERT INTO sessions VALUES('owner-hash','created','expires')")
    with auth_connect(data) as db:
        db.execute("INSERT INTO sessions VALUES('helper-hash',?,'created','expires','seen',NULL,1)", (first,))
        db.execute("INSERT INTO join_codes VALUES('code-hash',?,'expires',NULL)", (first,))
    archive = tmp_path / "snapshots" / "all"
    create_snapshot(archive, data)
    assert sorted(path.relative_to(archive).as_posix() for path in archive.rglob("*") if path.is_file()) == [
        "auth.sqlite3",
        "capture.sqlite3",
        "manifest.json",
        f"users/{first}/capture.sqlite3",
    ]
    later = add_user(second)
    for directory in (data, helper):
        with connect(directory) as db:
            db.execute("UPDATE meta SET value='changed' WHERE key='sentinel'")

    wal = helper / "capture.sqlite3-wal"
    wal.write_bytes(b"stale sidecar")
    saved = restore_snapshot(archive, data)
    assert (saved / wal.relative_to(data)).read_bytes() == b"stale sidecar"
    assert not wal.exists()
    assert not (later / "capture.sqlite3").exists()
    assert (saved / "users" / second / "capture.sqlite3").exists()
    with auth_connect(data) as db:
        assert db.execute("SELECT disabled_at FROM users WHERE id=?", (first,)).fetchone()[0] == "disabled"
        assert db.execute("SELECT 1 FROM users WHERE id=?", (second,)).fetchone() is None
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM join_codes").fetchone()[0] == 0
    with connect(data) as db:
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    with closing(sqlite3.connect(archive / "auth.sqlite3")) as db:
        assert db.execute("SELECT COUNT(*) FROM join_codes").fetchone()[0] == 1
    for directory, value in ((data, "owner"), (helper, "helper")):
        with connect(directory) as db:
            assert db.execute("SELECT value FROM meta WHERE key='sentinel'").fetchone()[0] == value
    assert (media / "original").read_bytes() == b"preserved"


def test_incomplete_snapshot_is_never_published_or_restored(tmp_path):
    data = tmp_path / "data"
    init_accounts(data)
    helper = "01J00000000000000000000001"
    with auth_connect(data) as db:
        db.execute("INSERT INTO users(id,name,name_key,is_owner,created_at) VALUES(?,?,?,0,?)", (helper,) * 4)
    destination = tmp_path / "snapshots" / "copy"
    with pytest.raises(sqlite3.OperationalError):
        create_snapshot(destination, data)
    assert not destination.exists()
    assert list(destination.parent.iterdir()) == []
    with pytest.raises(RuntimeError, match="manifest"):
        restore_snapshot(data, tmp_path / "live")
    assert not (tmp_path / "live").exists()


def test_legacy_restore_and_independent_directory_retention(tmp_path):
    data = tmp_path / "data"
    init_accounts(data)
    archives = tmp_path / "snapshots"
    archives.mkdir()
    legacy = archives / "20261124T101010Z-pre-deploy.sqlite3"
    with connect(data) as db:
        db.execute("INSERT INTO sessions VALUES('owner-hash','created','expires')")
    with connect(data) as db, closing(sqlite3.connect(legacy)) as backup:
        db.backup(backup)
    helper_id = "01J00000000000000000000001"
    helper = user_data_dir(data, helper_id)
    run_migrations(helper)
    with connect(helper) as db:
        db.execute("INSERT INTO meta VALUES('helper-data','current')")
    with auth_connect(data) as db:
        db.execute(
            "INSERT INTO users(id,name,name_key,is_owner,created_at) VALUES(?,'Helper','helper',0,'created')",
            (helper_id,),
        )
        db.execute(
            "INSERT INTO sessions VALUES('helper-hash',?,'created','expires','seen',NULL,1)", (helper_id,)
        )
        db.execute("INSERT INTO join_codes VALUES('join-hash',?,'expires',NULL)", (helper_id,))
    with connect(data) as db:
        db.execute("INSERT INTO meta VALUES('after','live')")
    keep = restore_snapshot(legacy, data)
    assert (keep / "capture.sqlite3").exists()
    assert (data / "auth.sqlite3").exists()
    with connect(data) as db:
        assert db.execute("SELECT value FROM meta WHERE key='after'").fetchone() is None
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    with auth_connect(data) as db:
        assert db.execute("SELECT 1 FROM users WHERE id=?", (helper_id,)).fetchone()
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM join_codes").fetchone()[0] == 0
    with connect(helper) as db:
        assert db.execute("SELECT value FROM meta WHERE key='helper-data'").fetchone()[0] == "current"

    old = archives / "20261123T101010999999Z-pre-deploy"
    latest = archives / "20261124T101010000001Z-pre-deploy"
    newest = archives / "20261125T101010000000Z-pre-deploy"
    for archive in (old, latest, newest):
        archive.mkdir()
    other_legacy = archives / "20261122T101010Z-pre-deploy.sqlite3"
    other_legacy.touch()
    unrelated = archives / "keep-me.sqlite3"
    unrelated.touch()
    prune_snapshots(archives, keep=2)
    assert sorted(archives.iterdir()) == sorted([legacy, other_legacy, latest, newest, unrelated])


def test_legacy_snapshot_path_is_a_file_and_companion_prunes_only_directories(tmp_path):
    data = tmp_path / "data"
    archives = data / "snapshots"
    run_migrations(data)
    baseline = archives / "20261120T101010Z-pre-deploy.sqlite3"
    create_snapshot(baseline, data)
    assert baseline.is_file()
    assert list(archives.iterdir()) == [baseline]
    init_accounts(data)
    for day in range(21, 25):
        destination = archives / f"202611{day}T101010Z-pre-deploy.sqlite3"
        create_snapshot(destination, data)
        with closing(sqlite3.connect(destination)) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert len(list(archives.glob("*-pre-deploy.sqlite3"))) == 5
    sets = sorted(path.name for path in archives.iterdir() if path.is_dir())
    assert sets == [f"202611{day}T101010Z-pre-deploy" for day in range(22, 25)]
    manifest = archives / sets[-1] / "manifest.json"
    assert json.loads(manifest.read_text()) == {
        "version": 1,
        "databases": ["capture.sqlite3", "auth.sqlite3"],
    }


def test_corrupt_helper_keeps_legacy_owner_snapshot(tmp_path, monkeypatch, capsys):
    data = tmp_path / "data"
    init_accounts(data)
    helper = "01J00000000000000000000001"
    helper_dir = user_data_dir(data, helper)
    run_migrations(helper_dir)
    with auth_connect(data) as db:
        db.execute(
            "INSERT INTO users(id,name,name_key,is_owner,created_at) VALUES(?,?,?,0,'t0')",
            (helper, "Helper", "helper"),
        )
    with connect(data) as db:
        db.execute("INSERT INTO meta VALUES('owner_data','preserved')")
    (helper_dir / "capture.sqlite3").write_bytes(b"corrupt database")
    destination = data / "snapshots" / "20261125T101010Z-pre-deploy.sqlite3"
    monkeypatch.setattr("sys.argv", ["snapshot", "--data-dir", str(data), str(destination)])

    assert main() == 0
    assert "warning" in capsys.readouterr().err.lower()
    assert list(destination.parent.iterdir()) == [destination]
    with closing(sqlite3.connect(destination)) as db:
        assert db.execute("SELECT value FROM meta WHERE key='owner_data'").fetchone() == ("preserved",)


@pytest.mark.parametrize("missing", ["manifest", "auth", "helper", "helper-unlisted"])
def test_restore_checks_manifest_and_all_required_files_before_touching_live_data(tmp_path, missing):
    data = tmp_path / "data"
    init_accounts(data)
    helper = "01J00000000000000000000001"
    run_migrations(user_data_dir(data, helper))
    with auth_connect(data) as db:
        db.execute("INSERT INTO users(id,name,name_key,is_owner,created_at) VALUES(?,?,?,0,?)", (helper,) * 4)
    archive = tmp_path / "snapshot"
    create_snapshot(archive, data)
    manifest = archive / "manifest.json"
    helper_db = f"users/{helper}/capture.sqlite3"
    if missing == "manifest":
        manifest.unlink()
    elif missing == "auth":
        (archive / "auth.sqlite3").unlink()
    else:
        (archive / helper_db).unlink()
        if missing == "helper-unlisted":
            info = json.loads(manifest.read_text())
            info["databases"].remove(helper_db)
            manifest.write_text(json.dumps(info))
    live = data / "capture.sqlite3"
    inode = live.stat().st_ino
    with pytest.raises(RuntimeError, match="manifest|missing"):
        restore_snapshot(archive, data)
    assert live.stat().st_ino == inode
    assert not list(data.glob("before-restore-*"))
