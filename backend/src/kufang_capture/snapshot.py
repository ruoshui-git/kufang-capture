import argparse
import sqlite3
import sys
from pathlib import Path

from .settings import get_settings


def create_snapshot(destination: Path, data_dir: Path) -> None:
    source_path = data_dir / "capture.sqlite3"
    if not source_path.is_file():
        raise FileNotFoundError(f"Database does not exist: {source_path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source_path) as source, sqlite3.connect(destination) as target:
        source.backup(target)
    with sqlite3.connect(destination) as check:
        result = check.execute("PRAGMA integrity_check").fetchone()
    if result is None or result[0] != "ok":
        raise RuntimeError(f"Snapshot integrity check failed: {result[0] if result else 'no result'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Create and verify a SQLite online backup")
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        create_snapshot(args.destination, get_settings().data_dir)
    except (OSError, sqlite3.Error, RuntimeError) as exc:
        print(f"Snapshot failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
