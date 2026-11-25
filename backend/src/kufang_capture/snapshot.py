import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

OWNER_DB = Path("capture.sqlite3")
AUTH_DB = Path("auth.sqlite3")
MANIFEST = "manifest.json"
USER_ID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}")
SNAPSHOT_NAME = re.compile(r"\d{8}T\d{6}(?:\d{6})?Z-pre-deploy")


def read_database(source: Path, *, immutable: bool = False) -> sqlite3.Connection:
    options = "mode=ro&immutable=1" if immutable else "mode=ro"
    return sqlite3.connect(f"{source.resolve().as_uri()}?{options}", uri=True)


def verify_database(source: Path) -> None:
    with closing(read_database(source, immutable=True)) as check:
        result = check.execute("PRAGMA integrity_check").fetchone()
    if result is None or result[0] != "ok":
        raise RuntimeError(f"Integrity check failed for {source}: {result[0] if result else 'no result'}")


def backup_database(source: Path, destination: Path, *, immutable_source: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with (
        closing(read_database(source, immutable=immutable_source)) as db,
        closing(sqlite3.connect(destination)) as backup,
    ):
        db.backup(backup)
        backup.execute("PRAGMA journal_mode=DELETE")
    verify_database(destination)


def registered_databases(auth: Path) -> list[Path]:
    with closing(read_database(auth, immutable=True)) as db:
        ids = [row[0] for row in db.execute("SELECT id FROM users WHERE is_owner=0 ORDER BY id")]
    if any(not isinstance(user_id, str) or USER_ID.fullmatch(user_id) is None for user_id in ids):
        raise RuntimeError("Auth database contains an invalid user ID")
    return [AUTH_DB, *(Path("users") / user_id / OWNER_DB for user_id in ids)]


def write_set(staged: Path, data_dir: Path, *, owner_snapshot: Path | None = None) -> None:
    staged.mkdir(mode=0o700)
    databases = [OWNER_DB]
    auth = data_dir / AUTH_DB
    if auth.is_file():
        # The copied registry defines the set. Account creation commits its
        # registry row only after the helper database has been migrated.
        backup_database(auth, staged / AUTH_DB)
        databases.extend(registered_databases(staged / AUTH_DB))
    for relative in databases:
        if relative == OWNER_DB and owner_snapshot is not None:
            shutil.copyfile(owner_snapshot, staged / OWNER_DB)
        elif relative != AUTH_DB:
            backup_database(data_dir / relative, staged / relative)
    manifest = {"version": 1, "databases": [path.as_posix() for path in databases]}
    (staged / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def create_snapshot(destination: Path, data_dir: Path) -> None:
    legacy = destination.suffix == ".sqlite3"
    if not legacy and destination.exists():
        raise FileExistsError(f"Snapshot already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=destination.parent) as temporary:
        staging = Path(temporary)
        if not legacy:
            write_set(staging / "snapshot", data_dir)
            (staging / "snapshot").rename(destination)
            return

        # The installed deploy script still creates and prunes plain files.
        staged_file = staging / OWNER_DB
        backup_database(data_dir / OWNER_DB, staged_file)
        staged_file.chmod(0o600)
        os.replace(staged_file, destination)
        if not (data_dir / AUTH_DB).is_file():
            return

        staged_set = staging / "snapshot"
        companion = destination.with_suffix("")
        try:
            write_set(staged_set, data_dir, owner_snapshot=destination)
            if companion.exists() and SNAPSHOT_NAME.fullmatch(companion.name):
                # Deploy and rollback can both use the same second-based stamp.
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
                companion = destination.with_name(f"{stamp}-pre-deploy")
            if companion.exists():
                raise FileExistsError(f"Snapshot already exists: {companion}")
            staged_set.rename(companion)
        except (OSError, sqlite3.Error, RuntimeError) as exc:
            print(f"Warning: companion snapshot was not published: {exc}", file=sys.stderr)
            return
        try:
            prune_snapshots(destination.parent, keep=3)
        except OSError as exc:
            print(f"Warning: could not prune older companion snapshots: {exc}", file=sys.stderr)


def prune_snapshots(directory: Path, keep: int) -> None:
    snapshots = sorted(
        (
            path
            for path in directory.iterdir()
            if SNAPSHOT_NAME.fullmatch(path.name) and path.is_dir() and not path.is_symlink()
        ),
        key=lambda path: path.name.partition("Z")[0].ljust(21, "0"),
        reverse=True,
    )
    for path in snapshots[keep:]:
        shutil.rmtree(path)


def read_set(source: Path) -> list[Path]:
    try:
        manifest = json.loads((source / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as exc:
        raise RuntimeError(f"Cannot read snapshot manifest: {source / MANIFEST}") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise RuntimeError("Invalid snapshot manifest version")
    listed = manifest.get("databases")
    if not isinstance(listed, list) or not all(isinstance(path, str) for path in listed):
        raise RuntimeError("Invalid database list in snapshot manifest")
    present = {path.relative_to(source).as_posix() for path in source.rglob("*.sqlite3")}
    if set(listed) != present:
        raise RuntimeError("Snapshot databases are missing or differ from the manifest")
    required = [OWNER_DB]
    if AUTH_DB.as_posix() in listed:
        required.extend(registered_databases(source / AUTH_DB))
    if listed != [path.as_posix() for path in required]:
        raise RuntimeError("Snapshot manifest does not match its account registry")
    for relative in required:
        path = source / relative
        if not path.is_file() or path.resolve() != source.resolve() / relative:
            raise RuntimeError(f"Invalid or missing snapshot database: {relative}")
    return required


def clear_sessions(path: Path, is_auth: bool) -> None:
    with closing(sqlite3.connect(path)) as db, db:
        # Early owner snapshots can predate the sessions table.
        has_sessions = db.execute(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sessions'"
        ).fetchone()
        if is_auth or has_sessions:
            db.execute("DELETE FROM sessions")
        if is_auth:
            db.execute("DELETE FROM join_codes")


def restore_snapshot(source: Path, data_dir: Path) -> Path:
    """Install snapshots with the service stopped and preserve the previous database files."""
    replacements = (
        {relative: source / relative for relative in read_set(source)}
        if source.is_dir()
        else {OWNER_DB: source}
    )
    existing = list(replacements)
    if AUTH_DB in replacements:
        # Also set aside databases of accounts that were added after the snapshot.
        existing.extend(
            path.relative_to(data_dir) / OWNER_DB
            for path in sorted((data_dir / "users").glob("*"))
            if path.is_dir() and USER_ID.fullmatch(path.name)
        )
    for path in replacements.values():
        verify_database(path)
    current_auth = data_dir / AUTH_DB
    preserve_accounts = AUTH_DB not in replacements and current_auth.is_file()

    data_dir.mkdir(parents=True, exist_ok=True)
    moved = []
    installed = []
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=data_dir) as temporary:
        staged = Path(temporary)
        for relative, path in replacements.items():
            backup_database(path, staged / relative, immutable_source=True)
        if preserve_accounts:
            # An owner-only archive leaves helper accounts and their data in place.
            backup_database(current_auth, staged / AUTH_DB)
            replacements[AUTH_DB] = current_auth
        for relative in replacements:
            clear_sessions(staged / relative, is_auth=relative == AUTH_DB)
        keep = Path(tempfile.mkdtemp(prefix="before-restore-", dir=data_dir))
        try:
            for relative in dict.fromkeys([*existing, *replacements]):
                for suffix in ("", "-wal", "-shm", "-journal"):
                    live = data_dir / (str(relative) + suffix)
                    if live.exists():
                        saved = keep / live.relative_to(data_dir)
                        saved.parent.mkdir(parents=True, exist_ok=True)
                        live.rename(saved)
                        moved.append((live, saved))
            for relative in replacements:
                live = data_dir / relative
                live.parent.mkdir(parents=True, exist_ok=True)
                (staged / relative).rename(live)
                installed.append(live)
        except (OSError, KeyboardInterrupt):
            for live in reversed(installed):
                live.unlink()
            for live, saved in reversed(moved):
                saved.rename(live)
            raise
    return keep


def main() -> int:
    parser = argparse.ArgumentParser(description="Create, retain or restore verified SQLite snapshots")
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--data-dir", type=Path)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--pre-deploy", action="store_true")
    actions.add_argument("--restore", type=Path, metavar="SNAPSHOT")
    args = parser.parse_args()
    if args.data_dir is None:
        from .settings import get_settings

        args.data_dir = get_settings().data_dir
    if bool(args.destination) + bool(args.pre_deploy) + bool(args.restore) != 1:
        parser.error("Specify a destination, --pre-deploy, or --restore SNAPSHOT")
    try:
        if args.restore:
            print(f"Previous database files saved in {restore_snapshot(args.restore, args.data_dir)}")
        elif args.pre_deploy:
            if (args.data_dir / OWNER_DB).is_file() or (args.data_dir / AUTH_DB).is_file():
                directory = args.data_dir / "snapshots"
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
                destination = directory / f"{stamp}-pre-deploy"
                create_snapshot(destination, args.data_dir)
                prune_snapshots(directory, keep=3)
                print(f"Created {destination}")
        else:
            create_snapshot(args.destination, args.data_dir)
    except (OSError, sqlite3.Error, RuntimeError) as exc:
        print(f"Snapshot failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
