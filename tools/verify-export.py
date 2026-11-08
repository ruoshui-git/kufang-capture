#!/usr/bin/env python3
"""Validate a Kufang Capture format version 1 export using only the stdlib."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

COLLECTIONS = [
    "collection_id",
    "name",
    "description",
    "status",
    "storage_mode",
    "next_sequence_number",
    "entry_count",
    "photo_count",
    "created_at",
    "updated_at",
    "archived_at",
]
ENTRIES = [
    "entry_id",
    "collection_id",
    "sequence_number",
    "sequence_label",
    "title",
    "display_title",
    "quantity",
    "unit",
    "count_detail",
    "notes",
    "expiration_date",
    "dimensions",
    "review_status",
    "photo_count",
    "created_at",
    "updated_at",
    "deleted_at",
]
PHOTOS = [
    "photo_id",
    "entry_id",
    "collection_id",
    "path",
    "original_filename",
    "mime_type",
    "byte_size",
    "sha256",
    "width",
    "height",
    "sort_order",
    "caption",
    "is_cover",
    "capture_source",
    "captured_at",
    "created_at",
    "deleted_at",
]


def load_table(
    archive: zipfile.ZipFile, path: str, headers: list[str], problems: list[str]
) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    csv_path, json_path = f"capture-export/{path}.csv", f"capture-export/{path}.json"
    try:
        raw_csv = archive.read(csv_path).decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(raw_csv, newline=""))
        if reader.fieldnames != headers:
            problems.append(f"{csv_path}: header mismatch")
        csv_rows = list(reader)
    except (KeyError, UnicodeDecodeError, csv.Error) as exc:
        problems.append(f"{csv_path}: cannot read CSV ({exc})")
        csv_rows = []
    try:
        json_rows = json.loads(archive.read(json_path))
        if not isinstance(json_rows, list) or any(not isinstance(row, dict) for row in json_rows):
            raise ValueError("expected an array of objects")
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        problems.append(f"{json_path}: cannot read JSON ({exc})")
        json_rows = []
    if len(csv_rows) != len(json_rows):
        problems.append(f"{path}: CSV and JSON row counts differ")
    for index, (csv_row, json_row) in enumerate(zip(csv_rows, json_rows, strict=False), start=1):
        if set(json_row) != set(headers):
            problems.append(f"{path} row {index}: JSON keys do not match CSV headers")
        for key in headers:
            value = json_row.get(key)
            if isinstance(value, bool):
                expected = str(value).lower()
            elif value is None:
                expected = ""
            else:
                expected = str(value)
            if csv_row.get(key) != expected:
                problems.append(f"{path} row {index}: CSV/JSON mismatch for {key}")
                break
    return csv_rows, json_rows


def parse_int(value: Any, label: str, problems: list[str]) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        problems.append(f"{label}: expected an integer, got {value!r}")
        return -1


def verify(path: Path, originals: Path | None = None) -> list[str]:
    problems: list[str] = []
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        return [f"cannot open ZIP: {exc}"]
    with archive:
        infos = archive.infolist()
        names = [item.filename for item in infos]
        if len(names) != len(set(names)):
            problems.append("ZIP contains duplicate member paths")
        if any(not name.startswith("capture-export/") for name in names):
            problems.append("all paths must be under capture-export/")
        if any(item.compress_type != zipfile.ZIP_STORED for item in infos):
            problems.append("ZIP contains a member that is not STORE compressed")
        if archive.testzip() is not None:
            problems.append(f"ZIP CRC failure in {archive.testzip()}")
        try:
            manifest = json.loads(archive.read("capture-export/manifest.json"))
            if manifest.get("format") != "kufang-capture-export" or manifest.get("format_version") != 1:
                problems.append("manifest format/version is not Kufang Capture version 1")
        except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            return problems + [f"cannot read manifest.json ({exc})"]

        trash = bool(manifest.get("include_trash"))
        missing_original_paths = {
            item.get("path")
            for item in manifest.get("missing_originals", [])
            if isinstance(item, dict) and isinstance(item.get("path"), str)
        }
        core = [
            "capture-export/manifest.json",
            "capture-export/collections.csv",
            "capture-export/collections.json",
        ]
        base = ["entries.csv", "entries.json", "photos.csv", "photos.json"]
        expected = set(core + [f"capture-export/{x}" for x in base])
        if trash:
            expected.update(f"capture-export/trash/{x}" for x in base)
        actual = set(names)
        for required in sorted(expected - actual):
            problems.append(f"missing required member {required}")

        collections, _ = load_table(archive, "collections", COLLECTIONS, problems)
        entries, _ = load_table(archive, "entries", ENTRIES, problems)
        photos, _ = load_table(archive, "photos", PHOTOS, problems)
        trash_entries: list[dict[str, str]] = []
        trash_photos: list[dict[str, str]] = []
        if trash:
            trash_entries, _ = load_table(archive, "trash/entries", ENTRIES, problems)
            trash_photos, _ = load_table(archive, "trash/photos", PHOTOS, problems)
        elif any(name.startswith("capture-export/trash/") for name in names):
            problems.append("trash members present when include_trash is false")

        collection_ids = {row.get("collection_id") for row in collections}
        entry_by_id = {row.get("entry_id"): row for row in entries + trash_entries}
        for row in entries + trash_entries:
            if row.get("collection_id") not in collection_ids:
                problems.append(f"entry {row.get('entry_id')}: collection_id is dangling")
        seen_photo_paths: set[str] = set()
        for row in photos + trash_photos:
            if row.get("entry_id") not in entry_by_id:
                problems.append(f"photo {row.get('photo_id')}: entry_id is dangling")
            if row.get("collection_id") not in collection_ids:
                problems.append(f"photo {row.get('photo_id')}: collection_id is dangling")
            photo_path = row.get("path", "")
            expected_prefix = "trash/photos/" if row in trash_photos else "photos/"
            if not photo_path.startswith(expected_prefix) or ".." in Path(photo_path).parts:
                problems.append(
                    f"photo {row.get('photo_id')}: path is outside its expected {expected_prefix} subtree"
                )
            if photo_path in seen_photo_paths:
                problems.append(f"duplicate photo path {photo_path}")
            seen_photo_paths.add(photo_path)
            archive_path = f"capture-export/{photo_path}"
            if photo_path in missing_original_paths:
                if archive_path in actual:
                    problems.append(f"missing original {photo_path}: unexpected archive member is present")
                continue
            try:
                data = archive.read(archive_path)
                if len(data) != parse_int(
                    row.get("byte_size", "-1"), f"photo {row.get('photo_id')} byte_size", problems
                ):
                    problems.append(f"photo {row.get('photo_id')}: byte_size mismatch")
                digest = hashlib.sha256(data).hexdigest()
                if digest != row.get("sha256"):
                    problems.append(f"photo {row.get('photo_id')}: sha256 mismatch")
                if originals is not None:
                    photo_id = row.get("photo_id", "")
                    ext = Path(photo_path).suffix
                    candidates = [originals / f"{photo_id}{ext}", originals / str(row.get("sha256", ""))]
                    source = next((candidate for candidate in candidates if candidate.is_file()), None)
                    if source is None:
                        problems.append(f"photo {photo_id}: no matching original in {originals}")
                    elif source.read_bytes() != data:
                        problems.append(f"photo {photo_id}: original bytes differ")
            except (KeyError, ValueError, OSError) as exc:
                problems.append(f"photo {row.get('photo_id')}: cannot verify member {archive_path} ({exc})")
        active_photo_counts: dict[str, int] = {}
        trash_photo_counts: dict[str, int] = {}
        for row in photos:
            active_photo_counts[row.get("entry_id", "")] = (
                active_photo_counts.get(row.get("entry_id", ""), 0) + 1
            )
        for row in trash_photos:
            trash_photo_counts[row.get("entry_id", "")] = (
                trash_photo_counts.get(row.get("entry_id", ""), 0) + 1
            )
        for row in entries:
            if parse_int(
                row.get("photo_count", "-1"), f"entry {row.get('entry_id')} photo_count", problems
            ) != active_photo_counts.get(row.get("entry_id", ""), 0):
                problems.append(f"entry {row.get('entry_id')}: active photo_count mismatch")
        for row in trash_entries:
            if parse_int(
                row.get("photo_count", "-1"), f"entry {row.get('entry_id')} photo_count", problems
            ) != trash_photo_counts.get(row.get("entry_id", ""), 0):
                problems.append(f"entry {row.get('entry_id')}: trash photo_count mismatch")
        for row in collections:
            cid = row.get("collection_id", "")
            entry_count = sum(1 for entry in entries if entry.get("collection_id") == cid)
            photo_count = sum(1 for photo in photos if photo.get("collection_id") == cid)
            if (
                parse_int(row.get("entry_count", "-1"), f"collection {cid} entry_count", problems)
                != entry_count
            ):
                problems.append(f"collection {cid}: active entry_count mismatch")
            if (
                parse_int(row.get("photo_count", "-1"), f"collection {cid} photo_count", problems)
                != photo_count
            ):
                problems.append(f"collection {cid}: active photo_count mismatch")
        expected_files = set(core + [f"capture-export/{x}" for x in base])
        expected_files.update(
            f"capture-export/{row.get('path', '')}"
            for row in photos
            if row.get("path") not in missing_original_paths
        )
        if trash:
            expected_files.update(f"capture-export/trash/{x}" for x in base)
            expected_files.update(
                f"capture-export/{row.get('path', '')}"
                for row in trash_photos
                if row.get("path") not in missing_original_paths
            )
        if actual != expected_files:
            for unexpected in sorted(actual - expected_files):
                problems.append(f"unexpected archive member {unexpected}")
            for absent in sorted(expected_files - actual):
                problems.append(f"missing expected archive member {absent}")
        listed = manifest.get("files", [])
        listed_paths: set[str] = set()
        for item in listed:
            file_path = item.get("path")
            if not isinstance(file_path, str):
                problems.append("manifest files contains an invalid path")
                continue
            if file_path in listed_paths:
                problems.append(f"manifest lists {file_path} more than once")
            listed_paths.add(file_path)
            try:
                data = archive.read(f"capture-export/{file_path}")
                if len(data) != item.get("byte_size"):
                    problems.append(f"manifest byte_size mismatch for {file_path}")
                if hashlib.sha256(data).hexdigest() != item.get("sha256"):
                    problems.append(f"manifest sha256 mismatch for {file_path}")
            except KeyError:
                problems.append(f"manifest file is missing: {file_path}")
        actual_files = {
            name.removeprefix("capture-export/") for name in names if name != "capture-export/manifest.json"
        }
        if listed_paths != actual_files:
            for extra in sorted(actual_files - listed_paths):
                problems.append(f"member is not listed in manifest: {extra}")
            for missing in sorted(listed_paths - actual_files):
                problems.append(f"manifest lists absent member: {missing}")

        counts = manifest.get("counts", {})
        expected_counts = {
            "collections": len(collections),
            "entries": len(entries),
            "photos": len(photos),
            "photo_bytes": sum(
                parse_int(row.get("byte_size", 0), f"photo {row.get('photo_id')} byte_size", problems)
                for row in photos
            ),
            "trash_entries": len(trash_entries) if trash else 0,
            "trash_photos": len(trash_photos) if trash else 0,
        }
        for key, value in expected_counts.items():
            if counts.get(key) != value:
                problems.append(f"manifest count mismatch for {key}: expected {value}, got {counts.get(key)}")
        expected_paths = {"capture-export/manifest.json"} | {f"capture-export/{p}" for p in listed_paths}
        for extra in sorted(actual - expected_paths):
            problems.append(f"unexpected archive member {extra}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--originals", type=Path)
    parser.add_argument("--json", action="store_true", help="print results as JSON")
    args = parser.parse_args()
    problems = verify(args.archive, args.originals)
    if args.json:
        print(json.dumps({"valid": not problems, "problems": problems}, indent=2))
    elif problems:
        print("Export verification failed:")
        for problem in problems:
            print(f"- {problem}")
    else:
        print("Export verified successfully.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
