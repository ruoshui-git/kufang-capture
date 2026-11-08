import csv
import hashlib
import io
import json
import re
import struct
import zlib
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .db import connect

ROOT = "capture-export/"
COLLECTION_COLUMNS = [
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
ENTRY_COLUMNS = [
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
PHOTO_COLUMNS = [
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


def _csv(rows: list[dict[str, Any]], columns: list[str]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator="\r\n", extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_value(row.get(key)) for key in columns})
    return b"\xef\xbb\xbf" + output.getvalue().encode("utf-8")


def _csv_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return value


def _json(rows: list[dict[str, Any]], columns: list[str]) -> bytes:
    return json.dumps(
        [{key: row.get(key) for key in columns} for row in rows], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")


def _extension(row: dict[str, Any]) -> str:
    known = {
        "image/jpeg": "jpg",
        "image/heic": "heic",
        "image/heif": "heif",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
    }
    if row["mime_type"] in known:
        return known[row["mime_type"]]
    suffix = Path(row["original_filename"]).suffix.lower().lstrip(".")
    return suffix if re.fullmatch(r"[a-z0-9]{1,5}", suffix) else "bin"


def _slug(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    return (slug or "collection")[:40]


def _dos_time(value: datetime) -> tuple[int, int]:
    year = max(1980, value.year)
    return ((year - 1980) << 9) | (value.month << 5) | value.day, (value.hour << 11) | (value.minute << 5) | (
        value.second // 2
    )


def _member_header(
    name: bytes, size: int, crc: int, date: tuple[int, int], offset: int
) -> tuple[bytes, bytes]:
    zip64_size = size >= 0xFFFFFFFF
    zip64_offset = offset >= 0xFFFFFFFF
    extra = b""
    if zip64_size or zip64_offset:
        data = (struct.pack("<QQ", size, size) if zip64_size else b"") + (
            struct.pack("<Q", offset) if zip64_offset else b""
        )
        extra = struct.pack("<HH", 1, len(data)) + data
    local_extra = struct.pack("<HHQQ", 1, 16, size, size) if zip64_size else b""
    local_size = 0xFFFFFFFF if zip64_size else size
    local = (
        struct.pack(
            "<IHHHHHIIIHH",
            0x04034B50,
            45 if zip64_size else 20,
            0x800,
            0,
            date[1],
            date[0],
            crc,
            local_size,
            local_size,
            len(name),
            len(local_extra),
        )
        + name
        + local_extra
    )
    central = (
        struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50,
            45 if zip64_size or zip64_offset else 20,
            45 if zip64_size or zip64_offset else 20,
            0x800,
            0,
            date[1],
            date[0],
            crc,
            local_size,
            local_size,
            len(name),
            len(extra),
            0,
            0,
            0,
            0,
            0xFFFFFFFF if zip64_offset else offset,
        )
        + name
        + extra
    )
    return local, central


def build_export(
    data_dir: Path, collection_id: str | None, include_trash: bool, app_version: str
) -> tuple[str, Iterator[bytes]]:
    exported_at = datetime.now(UTC).replace(microsecond=0)
    iso_time = exported_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with connect(data_dir) as db:
        where = "WHERE id=?" if collection_id else ""
        collections = [
            dict(row)
            for row in db.execute(
                f"SELECT * FROM collections {where} ORDER BY created_at,id",
                (collection_id,) if collection_id else (),
            )
        ]
        if collection_id and not collections:
            raise KeyError(collection_id)
        cids = [r["id"] for r in collections]
        if not cids:
            entries, photos = [], []
        else:
            marks = ",".join("?" for _ in cids)
            entries = [
                dict(row)
                for row in db.execute(
                    f"SELECT * FROM entries WHERE collection_id IN ({marks}) "
                    "ORDER BY collection_id,sequence_number",
                    cids,
                )
            ]
            photos = [
                dict(row)
                for row in db.execute(
                    f"SELECT * FROM photos WHERE collection_id IN ({marks}) "
                    "ORDER BY entry_id,sort_order,captured_at",
                    cids,
                )
            ]
    coll_order = {row["id"]: i for i, row in enumerate(collections)}
    entry_order = {row["id"]: (coll_order[row["collection_id"]], row["sequence_number"]) for row in entries}
    photos.sort(
        key=lambda row: (
            *entry_order.get(row["entry_id"], (999999, 999999)),
            row["sort_order"],
            row["captured_at"],
        )
    )
    active_entries = [row for row in entries if row["deleted_at"] is None]
    active_photos = [
        p
        for p in photos
        if p["deleted_at"] is None
        and next((e["deleted_at"] for e in entries if e["id"] == p["entry_id"]), None) is None
    ]
    trash_entries = [e for e in entries if e["deleted_at"] is not None]
    entry_by_id = {e["id"]: e for e in entries}
    trash_photos = [
        p
        for p in photos
        if p["deleted_at"] is not None or entry_by_id[p["entry_id"]]["deleted_at"] is not None
    ]

    def export_collection(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "collection_id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "status": row["status"],
            "storage_mode": row["storage_mode"],
            "next_sequence_number": row["next_sequence_number"],
            "entry_count": sum(1 for e in active_entries if e["collection_id"] == row["id"]),
            "photo_count": sum(1 for p in active_photos if p["collection_id"] == row["id"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "archived_at": row["archived_at"],
        }

    c_rows = [export_collection(c) for c in collections]

    def entry_rows(
        source: list[dict[str, Any]], allowed_photos: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        count_by_entry: dict[str, int] = {}
        for p in allowed_photos:
            count_by_entry[p["entry_id"]] = count_by_entry.get(p["entry_id"], 0) + 1
        return [
            {
                "entry_id": e["id"],
                "collection_id": e["collection_id"],
                "sequence_number": e["sequence_number"],
                "sequence_label": f"#{e['sequence_number']:04d}",
                "title": e["title"],
                "display_title": e["title"].strip() or f"Entry #{e['sequence_number']:04d}",
                "quantity": e["quantity"],
                "unit": e["unit"],
                "count_detail": e["count_detail"],
                "notes": e["notes"],
                "expiration_date": e["expiration_date"],
                "dimensions": e["dimensions"],
                "review_status": e["review_status"],
                "photo_count": count_by_entry.get(e["id"], 0),
                "created_at": e["created_at"],
                "updated_at": e["updated_at"],
                "deleted_at": e["deleted_at"],
            }
            for e in source
        ]

    e_rows = entry_rows(active_entries, active_photos)
    trash_entry_ids = {entry["id"] for entry in trash_entries}
    trash_entry_ids.update(
        photo["entry_id"] for photo in trash_photos if entry_by_id[photo["entry_id"]]["deleted_at"] is None
    )
    t_entries = entry_rows([entry for entry in entries if entry["id"] in trash_entry_ids], trash_photos)

    missing = []
    photo_rows = []
    trash_photo_rows = []
    active_file_sources: list[tuple[str, int, int, str, Path | None]] = []
    trash_file_sources: list[tuple[str, int, int, str, Path | None]] = []

    def photo_rows_for(source: list[dict[str, Any]], prefix: str) -> list[dict[str, Any]]:
        rows = []
        for photo in source:
            path = f"{prefix}photos/{photo['entry_id']}/{photo['id']}.{_extension(photo)}"
            stored_path = data_dir / photo["storage_key"] if photo["storage_key"] else None
            stored = stored_path is not None and stored_path.is_file()
            rows.append(
                {
                    "photo_id": photo["id"],
                    "entry_id": photo["entry_id"],
                    "collection_id": photo["collection_id"],
                    "path": path,
                    "original_filename": photo["original_filename"],
                    "mime_type": photo["mime_type"],
                    "byte_size": photo["byte_size"],
                    "sha256": photo["sha256"],
                    "width": photo["width"],
                    "height": photo["height"],
                    "sort_order": photo["sort_order"],
                    "caption": photo["caption"],
                    "is_cover": bool(photo["is_cover"]),
                    "capture_source": photo["capture_source"],
                    "captured_at": photo["captured_at"],
                    "created_at": photo["created_at"],
                    "deleted_at": photo["deleted_at"],
                }
            )
            if stored:
                file_source = (path, photo["byte_size"], photo["crc32"], photo["sha256"], stored_path)
                (trash_file_sources if prefix else active_file_sources).append(file_source)
            else:
                missing.append({"photo_id": photo["id"], "path": path})
        return rows

    photo_rows = photo_rows_for(active_photos, "")
    if include_trash:
        trash_photo_rows = photo_rows_for(trash_photos, "trash/")
    # Build files in documented order; manifest is emitted first, but hashes list
    # every other member and therefore can be prepared before streaming.
    file_items: list[tuple[str, bytes | None, int, int, str, Path | None]] = []

    def add_table(stem: str, rows: list[dict[str, Any]], columns: list[str], prefix: str = "") -> None:
        file_items.append((prefix + stem + ".csv", _csv(rows, columns), 0, 0, "", None))
        file_items.append((prefix + stem + ".json", _json(rows, columns), 0, 0, "", None))

    add_table("collections", c_rows, COLLECTION_COLUMNS)
    add_table("entries", e_rows, ENTRY_COLUMNS)
    add_table("photos", photo_rows, PHOTO_COLUMNS)
    for path, size, crc, sha, file_path in active_file_sources:
        file_items.append((path, None, size, crc, sha, file_path))
    if include_trash:
        add_table("entries", t_entries, ENTRY_COLUMNS, "trash/")
        add_table("photos", trash_photo_rows, PHOTO_COLUMNS, "trash/")
        for path, size, crc, sha, file_path in trash_file_sources:
            file_items.append((path, None, size, crc, sha, file_path))
    json_files = []
    for name, data, size, _crc, sha, _ in file_items:
        actual_size = len(data) if data is not None else size
        actual_sha = hashlib.sha256(data).hexdigest() if data is not None else sha
        json_files.append({"path": name, "byte_size": actual_size, "sha256": actual_sha})
    quantities: dict[tuple[str, str], list[Any]] = {}
    latest_spelling: dict[tuple[str, str], tuple[str, str]] = {}
    for entry in active_entries:
        if entry["quantity"] is None or entry["quantity"] == "":
            continue
        unit = entry["unit"].strip().casefold()
        key = (entry["collection_id"], unit)
        # Decimal strings must not pass through binary floating point.
        from decimal import Decimal

        current = quantities.setdefault(key, [Decimal(0), 0])
        try:
            current[0] += Decimal(entry["quantity"])
            current[1] += 1
        except Exception:
            continue
        latest_spelling[key] = (entry["updated_at"], entry["unit"])
    quantity_by_unit = [
        {
            "collection_id": cid,
            "unit": latest_spelling.get((cid, unit), ("", unit))[1],
            "total": format(total, "f"),
            "entry_count": count,
        }
        for (cid, unit), (total, count) in sorted(quantities.items())
    ]
    for item in quantity_by_unit:
        item["total"] = item["total"].rstrip("0").rstrip(".") if "." in item["total"] else item["total"]
    scope = "all" if collection_id is None else "selected"
    manifest = {
        "format": "kufang-capture-export",
        "format_version": 1,
        "exported_at": iso_time,
        "source": "server",
        "app_version": app_version,
        "scope": scope,
        "include_trash": include_trash,
        "collections": [{"id": c["id"], "name": c["name"], "storage_mode": "synced"} for c in collections],
        "counts": {
            "collections": len(collections),
            "entries": len(active_entries),
            "photos": len(active_photos),
            "photo_bytes": sum(p["byte_size"] for p in active_photos),
            "trash_entries": len(trash_entries) if include_trash else 0,
            "trash_photos": len(trash_photos) if include_trash else 0,
        },
        "quantity_by_unit": quantity_by_unit,
        "files": json_files,
        "missing_originals": missing,
    }
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    slug = "all" if not collection_id else _slug(collections[0]["name"])
    filename = f"kufang-capture-{slug}-{exported_at.strftime('%Y%m%d-%H%M%SZ')}.zip"
    dos = _dos_time(exported_at)

    def stream() -> Iterator[bytes]:
        offset = 0
        central = []
        all_items: list[tuple[str, bytes | None, int, int, str, Path | None]] = [
            (
                "manifest.json",
                manifest_bytes,
                len(manifest_bytes),
                zlib.crc32(manifest_bytes) & 0xFFFFFFFF,
                hashlib.sha256(manifest_bytes).hexdigest(),
                None,
            )
        ] + file_items
        for path, data, size, crc, _sha, disk_path in all_items:
            name = (ROOT + path).encode("utf-8")
            if data is not None:
                size, crc = len(data), zlib.crc32(data) & 0xFFFFFFFF
            local, central_record = _member_header(name, size, crc, dos, offset)
            yield local
            offset += len(local)
            if data is not None:
                yield data
                offset += len(data)
            elif disk_path:
                with disk_path.open("rb") as photo_file:
                    while chunk := photo_file.read(1024 * 1024):
                        yield chunk
                        offset += len(chunk)
            central.append(central_record)
        central_start = offset
        for record in central:
            yield record
            offset += len(record)
        central_size = offset - central_start
        count = len(central)
        if count > 0xFFFF or central_start >= 0xFFFFFFFF or central_size >= 0xFFFFFFFF:
            yield struct.pack(
                "<IQHHIIQQQQ", 0x06064B50, 44, 45, 45, 0, 0, count, count, central_size, central_start
            )
            yield struct.pack("<IIQI", 0x07064B50, 0, offset, 1)
            yield struct.pack(
                "<IHHHHIIH",
                0x06054B50,
                0,
                0,
                min(count, 0xFFFF),
                min(count, 0xFFFF),
                min(central_size, 0xFFFFFFFF),
                min(central_start, 0xFFFFFFFF),
                0,
            )
        else:
            yield struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, count, count, central_size, central_start, 0)

    return filename, stream()
