import csv
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "verify-export.py"
SPEC = importlib.util.spec_from_file_location("verify_export", MODULE_PATH)
assert SPEC and SPEC.loader
verify_export = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_export)


def csv_bytes(headers: list[str], rows: list[dict[str, object]]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(
        {key: str(value).lower() if isinstance(value, bool) else value for key, value in row.items()}
        for row in rows
    )
    return b"\xef\xbb\xbf" + stream.getvalue().encode()


def archive_files() -> dict[str, bytes]:
    collections = [
        dict(
            collection_id="C1",
            name="Room",
            description="",
            status="active",
            storage_mode="local_only",
            next_sequence_number=2,
            entry_count=1,
            photo_count=1,
            created_at="2026-11-08T07:00:00.000Z",
            updated_at="2026-11-08T07:00:00.000Z",
            archived_at=None,
        )
    ]
    entries = [
        dict(
            entry_id="E1",
            collection_id="C1",
            sequence_number=1,
            sequence_label="#0001",
            title="",
            display_title="Entry #0001",
            quantity=None,
            unit="",
            count_detail="",
            notes="",
            expiration_date=None,
            dimensions="",
            review_status="draft",
            photo_count=1,
            created_at="2026-11-08T07:00:00.000Z",
            updated_at="2026-11-08T07:00:00.000Z",
            deleted_at=None,
        )
    ]
    photo_data = b"original"
    photos = [
        dict(
            photo_id="P1",
            entry_id="E1",
            collection_id="C1",
            path="photos/E1/P1.jpg",
            original_filename="P1.jpg",
            mime_type="image/jpeg",
            byte_size=len(photo_data),
            sha256=hashlib.sha256(photo_data).hexdigest(),
            width=1,
            height=1,
            sort_order=0,
            caption="",
            is_cover=True,
            capture_source="native_camera",
            captured_at="2026-11-08T07:00:00.000Z",
            created_at="2026-11-08T07:00:00.000Z",
            deleted_at=None,
        )
    ]
    data = {
        "collections.csv": csv_bytes(verify_export.COLLECTIONS, collections),
        "collections.json": (json.dumps(collections) + "\n").encode(),
        "entries.csv": csv_bytes(verify_export.ENTRIES, entries),
        "entries.json": (json.dumps(entries) + "\n").encode(),
        "photos.csv": csv_bytes(verify_export.PHOTOS, photos),
        "photos.json": (json.dumps(photos) + "\n").encode(),
        "photos/E1/P1.jpg": photo_data,
    }
    manifest = {
        "format": "kufang-capture-export",
        "format_version": 1,
        "include_trash": False,
        "counts": {
            "collections": 1,
            "entries": 1,
            "photos": 1,
            "photo_bytes": len(photo_data),
            "trash_entries": 0,
            "trash_photos": 0,
        },
        "files": [
            {"path": name, "byte_size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            for name, payload in data.items()
        ],
    }
    data["manifest.json"] = (json.dumps(manifest) + "\n").encode()
    return {f"capture-export/{name}": payload for name, payload in data.items()}


class VerifyExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_archive(self, files: dict[str, bytes], *, deflated: bool = False) -> Path:
        path = self.root / "export.zip"
        with zipfile.ZipFile(
            path, "w", compression=zipfile.ZIP_DEFLATED if deflated else zipfile.ZIP_STORED
        ) as archive:
            for name, payload in files.items():
                archive.writestr(name, payload)
        return path

    def test_good_archive_and_original_check(self) -> None:
        archive = self.write_archive(archive_files())
        originals = self.root / "originals"
        originals.mkdir()
        (originals / "P1.jpg").write_bytes(b"original")
        self.assertEqual(verify_export.verify(archive, originals), [])

    def test_bad_photo_hash_is_reported(self) -> None:
        files = archive_files()
        files["capture-export/photos/E1/P1.jpg"] = b"tampered"
        problems = verify_export.verify(self.write_archive(files))
        self.assertTrue(any("sha256 mismatch" in problem for problem in problems))

    def test_dangling_entry_id_is_reported(self) -> None:
        files = archive_files()
        rows = json.loads(files["capture-export/photos.json"])
        rows[0]["entry_id"] = "missing"
        files["capture-export/photos.json"] = (json.dumps(rows) + "\n").encode()
        # CSV remains the valid, matching row, exposing the foreign key from CSV.
        rows[0]["entry_id"] = "missing"
        files["capture-export/photos.csv"] = csv_bytes(verify_export.PHOTOS, rows)
        rebuild_manifest(files)
        self.assertTrue(
            any("entry_id is dangling" in p for p in verify_export.verify(self.write_archive(files)))
        )

    def test_deflated_member_is_reported(self) -> None:
        self.assertTrue(
            any(
                "not STORE" in p
                for p in verify_export.verify(self.write_archive(archive_files(), deflated=True))
            )
        )

    def test_count_mismatch_is_reported(self) -> None:
        files = archive_files()
        manifest = json.loads(files["capture-export/manifest.json"])
        manifest["counts"]["entries"] = 88
        files["capture-export/manifest.json"] = (json.dumps(manifest) + "\n").encode()
        self.assertTrue(
            any("count mismatch for entries" in p for p in verify_export.verify(self.write_archive(files)))
        )

    def test_csv_json_mismatch_is_reported(self) -> None:
        files = archive_files()
        rows = json.loads(files["capture-export/entries.json"])
        rows[0]["title"] = "different"
        files["capture-export/entries.json"] = (json.dumps(rows) + "\n").encode()
        self.assertTrue(
            any("CSV/JSON mismatch" in p for p in verify_export.verify(self.write_archive(files)))
        )


def rebuild_manifest(files: dict[str, bytes]) -> None:
    manifest = json.loads(files["capture-export/manifest.json"])
    manifest["files"] = [
        {
            "path": name.removeprefix("capture-export/"),
            "byte_size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        for name, payload in files.items()
        if name != "capture-export/manifest.json"
    ]
    files["capture-export/manifest.json"] = (json.dumps(manifest) + "\n").encode()


if __name__ == "__main__":
    unittest.main()
