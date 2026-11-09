import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_writer_lock = threading.Lock()


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect(data_dir: Path) -> sqlite3.Connection:
    data_dir.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(data_dir / "capture.sqlite3", timeout=5, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")
    return connection


@contextmanager
def single_writer() -> Iterator[None]:
    """Serialize process-local writes; SQLite still coordinates other processes."""
    with _writer_lock:
        yield


def run_migrations(data_dir: Path, migrations_dir: Path | None = None) -> None:
    directory = migrations_dir or Path(__file__).with_name("migrations")
    with connect(data_dir) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )
        applied = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
        for migration in sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            if migration.name in applied:
                continue
            script = migration.read_text(encoding="utf-8")
            version = migration.name.replace("'", "''")
            if migration.name == "0003_items.sql":
                connection.execute("PRAGMA foreign_keys=OFF")
                try:
                    connection.executescript("BEGIN IMMEDIATE;\n" + script)
                    violations = connection.execute("PRAGMA foreign_key_check").fetchall()
                    if violations:
                        raise sqlite3.IntegrityError(
                            f"foreign key check failed after {migration.name}: {violations}"
                        )
                    connection.execute(f"INSERT INTO schema_migrations(version) VALUES ('{version}')")
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                finally:
                    connection.execute("PRAGMA foreign_keys=ON")
            else:
                connection.executescript(
                    "BEGIN IMMEDIATE;\n"
                    + script
                    + f"\nINSERT INTO schema_migrations(version) VALUES ('{version}');\nCOMMIT;"
                )
