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
    "item_id",
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
    "item_id",
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
        cids = [row["id"] for row in collections]
        if cids:
            marks = ",".join("?" for _ in cids)
            entries = [
                dict(row)
                for row in db.execute(
                    f"SELECT e.*,i.title,i.notes,i.expiration_date,i.dimensions,"
                    f"i.review_status AS item_review_status,"
                    f"i.updated_at AS item_updated_at FROM entries e JOIN items i ON i.id=e.item_id "
                    f"WHERE e.collection_id IN ({marks}) ORDER BY e.collection_id,e.sequence_number",
                    cids,
                )
            ]
            item_ids = sorted({entry["item_id"] for entry in entries})
            item_marks = ",".join("?" for _ in item_ids)
            photos = (
                [
                    dict(row)
                    for row in db.execute(
                        f"SELECT * FROM photos WHERE item_id IN ({item_marks}) "
                        f"ORDER BY item_id,sort_order,captured_at,id",
                        item_ids,
                    )
                ]
                if item_ids
                else []
            )
        else:
            entries, photos = [], []
    coll_order = {row["id"]: i for i, row in enumerate(collections)}
    entries.sort(key=lambda row: (coll_order[row["collection_id"]], row["sequence_number"]))
    first_order = {}
    for index, entry in enumerate(entries):
        first_order.setdefault(entry["item_id"], index)
    photos.sort(
        key=lambda row: (
            first_order.get(row["item_id"], 999999),
            row["sort_order"],
            row["captured_at"],
            row["id"],
        )
    )
    active_entries = [row for row in entries if row["deleted_at"] is None]
    active_item_ids = {row["item_id"] for row in active_entries}
    active_photos = [row for row in photos if row["deleted_at"] is None and row["item_id"] in active_item_ids]
    trash_entries = [row for row in entries if row["deleted_at"] is not None]
    trash_photos = [
        row for row in photos if row["deleted_at"] is not None or row["item_id"] not in active_item_ids
    ]

    def export_collection(row: dict[str, Any]) -> dict[str, Any]:
        photo_count = sum(
            1
            for photo in active_photos
            if any(
                entry["collection_id"] == row["id"] and entry["item_id"] == photo["item_id"]
                for entry in active_entries
            )
        )
        return {
            "collection_id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "status": row["status"],
            "storage_mode": row["storage_mode"],
            "next_sequence_number": row["next_sequence_number"],
            "entry_count": sum(1 for entry in active_entries if entry["collection_id"] == row["id"]),
            "photo_count": photo_count,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "archived_at": row["archived_at"],
        }

    c_rows = [export_collection(row) for row in collections]

    def entry_rows(
        source: list[dict[str, Any]], allowed_photos: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        count_by_item = {}
        for photo in allowed_photos:
            count_by_item[photo["item_id"]] = count_by_item.get(photo["item_id"], 0) + 1
        rows = []
        for entry in source:
            seq = entry["sequence_number"]
            rows.append(
                {
                    "entry_id": entry["id"],
                    "item_id": entry["item_id"],
                    "collection_id": entry["collection_id"],
                    "sequence_number": seq,
                    "sequence_label": f"#{seq:04d}",
                    "title": entry["title"],
                    "display_title": entry["title"].strip() or f"Entry #{seq:04d}",
                    "quantity": entry["quantity"],
                    "unit": entry["unit"],
                    "count_detail": entry["count_detail"],
                    "notes": entry["notes"],
                    "expiration_date": entry["expiration_date"],
                    "dimensions": entry["dimensions"],
                    "review_status": entry["item_review_status"],
                    "photo_count": count_by_item.get(entry["item_id"], 0),
                    "created_at": entry["created_at"],
                    "updated_at": max(entry["updated_at"], entry["item_updated_at"]),
                    "deleted_at": entry["deleted_at"],
                }
            )
        return rows

    e_rows = entry_rows(active_entries, active_photos)
    t_entries = entry_rows(trash_entries, trash_photos)
    missing = []
    active_file_sources = []
    trash_file_sources = []

    def photo_rows_for(source: list[dict[str, Any]], prefix: str):
        rows = []
        for photo in source:
            path = f"{prefix}photos/{photo['item_id']}/{photo['id']}.{_extension(photo)}"
            disk_path = data_dir / photo["storage_key"] if photo["storage_key"] else None
            if disk_path is None or not disk_path.is_file():
                missing.append({"photo_id": photo["id"], "path": path})
                disk_path = None
            rows.append(
                {
                    "photo_id": photo["id"],
                    "item_id": photo["item_id"],
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
            if disk_path is not None:
                active_file_sources_or_trash = trash_file_sources if prefix else active_file_sources
                active_file_sources_or_trash.append(
                    (path, photo["byte_size"], photo["crc32"], photo["sha256"], disk_path)
                )
        return rows

    photo_rows = photo_rows_for(active_photos, "")
    trash_photo_rows = photo_rows_for(trash_photos, "trash/") if include_trash else []
    file_items: list[tuple[str, bytes | None, int, int, str, Path | None]] = []

    def add_table(stem: str, rows: list[dict[str, Any]], columns: list[str], prefix: str = "") -> None:
        file_items.append((prefix + stem + ".csv", _csv(rows, columns), 0, 0, "", None))
        file_items.append((prefix + stem + ".json", _json(rows, columns), 0, 0, "", None))

    add_table("collections", c_rows, COLLECTION_COLUMNS)
    add_table("entries", e_rows, ENTRY_COLUMNS)
    add_table("photos", photo_rows, PHOTO_COLUMNS)
    file_items.extend(
        (path, None, size, crc, sha, disk_path) for path, size, crc, sha, disk_path in active_file_sources
    )
    if include_trash:
        add_table("entries", t_entries, ENTRY_COLUMNS, "trash/")
        add_table("photos", trash_photo_rows, PHOTO_COLUMNS, "trash/")
        file_items.extend(
            (path, None, size, crc, sha, disk_path) for path, size, crc, sha, disk_path in trash_file_sources
        )
    json_files = []
    for name, data, size, _crc, sha, _ in file_items:
        json_files.append(
            {
                "path": name,
                "byte_size": len(data) if data is not None else size,
                "sha256": hashlib.sha256(data).hexdigest() if data is not None else sha,
            }
        )
    quantities = {}
    latest_spelling = {}
    from decimal import Decimal

    for entry in active_entries:
        if entry["quantity"] is None or entry["quantity"] == "":
            continue
        unit = entry["unit"].strip().casefold()
        key = (entry["collection_id"], unit)
        total, count = quantities.get(key, (Decimal(0), 0))
        try:
            quantities[key] = (total + Decimal(entry["quantity"]), count + 1)
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
    for value in quantity_by_unit:
        value["total"] = value["total"].rstrip("0").rstrip(".") if "." in value["total"] else value["total"]
    manifest = {
        "format": "kufang-capture-export",
        "format_version": 2,
        "exported_at": iso_time,
        "source": "server",
        "app_version": app_version,
        "scope": "all" if collection_id is None else "selected",
        "include_trash": include_trash,
        "collections": [{"id": c["id"], "name": c["name"], "storage_mode": "synced"} for c in collections],
        "counts": {
            "collections": len(collections),
            "items": len(active_item_ids),
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
        all_items = [
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
