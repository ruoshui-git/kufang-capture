import sqlite3

from kufang_capture.db import connect, run_migrations, single_writer
from kufang_capture.snapshot import create_snapshot


def test_migrations_are_recorded_and_idempotent(tmp_path):
    data = tmp_path / "data"
    run_migrations(data)
    run_migrations(data)
    with connect(data) as db:
        versions = {row[0] for row in db.execute("SELECT version FROM schema_migrations")}
        assert versions == {"0001_initial.sql", "0002_sync.sql"}
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert db.execute("PRAGMA busy_timeout").fetchone()[0] == 5000


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
