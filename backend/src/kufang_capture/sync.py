import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .db import connect, single_writer

TABLES = {"collection": "collections", "entry": "entries", "photo": "photos"}
COLLECTION_FIELDS = {
    "name": (str, 200),
    "description": (str, 20_000),
    "status": ("enum", {"active", "archived"}),
    "storage_mode": ("enum", {"synced"}),
    "next_sequence_number": ("positive_int", None),
    "sort_order": ("nullable_int", None),
    "sync_consented_at": ("nullable_timestamp", None),
    "last_exported_at": ("nullable_timestamp", None),
    "archived_at": ("nullable_timestamp", None),
}
ENTRY_FIELDS = {
    "title": (str, 200),
    "quantity": ("quantity", None),
    "unit": (str, 40),
    "count_detail": (str, 20_000),
    "notes": (str, 20_000),
    "expiration_date": ("date", None),
    "dimensions": (str, 2000),
    "review_status": ("enum", {"draft", "complete", "needs_review"}),
    "deleted_at": ("nullable_timestamp", None),
}
PHOTO_FIELDS = {
    "sort_order": (int, None),
    "original_filename": (str, 255),
    "mime_type": (str, 120),
    "byte_size": (int, None),
    "width": ("nullable_int", None),
    "height": ("nullable_int", None),
    "sha256": ("sha256", None),
    "crc32": ("crc32", None),
    "captured_at": ("timestamp", None),
    "capture_source": ("enum", {"native_camera", "photo_library", "camera_frame"}),
    "caption": (str, 2000),
    "is_cover": (bool, None),
    "deleted_at": ("nullable_timestamp", None),
}
CREATE_FIELDS = {
    "collection": {
        "id",
        "name",
        "description",
        "status",
        "storage_mode",
        "next_sequence_number",
        "sort_order",
        "sync_consented_at",
        "last_exported_at",
        "archived_at",
        "created_at",
        "updated_at",
    },
    "entry": {
        "id",
        "collection_id",
        "sequence_number",
        "title",
        "quantity",
        "unit",
        "count_detail",
        "notes",
        "expiration_date",
        "dimensions",
        "review_status",
        "deleted_at",
        "created_at",
        "updated_at",
    },
    "photo": {
        "id",
        "entry_id",
        "collection_id",
        "sort_order",
        "original_filename",
        "mime_type",
        "byte_size",
        "width",
        "height",
        "sha256",
        "crc32",
        "captured_at",
        "capture_source",
        "caption",
        "is_cover",
        "deleted_at",
        "created_at",
        "updated_at",
    },
}
MUTABLE_FIELDS = {"collection": COLLECTION_FIELDS, "entry": ENTRY_FIELDS, "photo": PHOTO_FIELDS}
QUANTITY_RE = re.compile(r"^-?\d+(\.\d+)?$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def public_record(row: sqlite3.Row | None, entity: str) -> dict[str, Any] | None:
    if row is None:
        return None
    record = dict(row)
    record["field_revisions"] = json.loads(record["field_revisions"])
    if entity == "photo":
        record["is_cover"] = bool(record["is_cover"])
        record["server_storage_key"] = record.pop("storage_key")
        record.pop("thumb_stored_at", None)
    return record


def _valid(field: str, value: Any, rule: tuple[Any, Any]) -> bool:
    kind, extra = rule
    if kind is str:
        return isinstance(value, str) and len(value) <= extra
    if kind == "enum":
        return isinstance(value, str) and value in extra
    if kind == "nullable_string":
        return value is None or (isinstance(value, str) and len(value) <= extra)
    if kind == "nullable_int":
        return value is None or (type(value) is int and value >= 0)
    if kind is int:
        return type(value) is int and value >= 0
    if kind == "positive_int":
        return type(value) is int and value >= 1
    if kind == "quantity":
        return value is None or (isinstance(value, str) and len(value) <= 30 and QUANTITY_RE.fullmatch(value))
    if kind == "date":
        if value is None:
            return True
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return False
        try:
            datetime.strptime(value, "%Y-%m-%d")
            return True
        except ValueError:
            return False
    if kind == "timestamp":
        return _valid_timestamp(value)
    if kind == "nullable_timestamp":
        return value is None or _valid_timestamp(value)
    if kind == "sha256":
        return isinstance(value, str) and SHA_RE.fullmatch(value) is not None
    if kind == "crc32":
        return type(value) is int and 0 <= value <= 0xFFFFFFFF
    if kind is bool:
        return type(value) is bool
    return False


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 40:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == datetime.now(UTC).utcoffset()


def _reject(code: str, message: str, mutation: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": mutation.get("id"),
        "status": "rejected",
        "server_revision": None,
        "record": None,
        "code": code,
        "message": message,
    }


def apply_batch(data_dir, mutations: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    results = []
    media_to_delete: list[str] = []
    with single_writer(), connect(data_dir) as db:
        for mutation in mutations:
            db.execute("BEGIN IMMEDIATE")
            try:
                prior = db.execute(
                    "SELECT result_json FROM applied_mutations WHERE mutation_id=?", (mutation.get("id"),)
                ).fetchone()
                if prior:
                    result = json.loads(prior[0])
                    result["status"] = "duplicate"
                    results.append(result)
                    db.commit()
                    continue
                purge_paths = []
                if mutation.get("op") == "purge":
                    entity = mutation.get("entity")
                    entity_id = mutation.get("entity_id")
                    if entity == "photo":
                        media = db.execute(
                            "SELECT storage_key FROM photos WHERE id=?", (entity_id,)
                        ).fetchone()
                        if media and media[0]:
                            purge_paths.append(media[0])
                        purge_paths.append(f"media/thumbnails/{entity_id[:2]}/{entity_id}")
                    elif entity == "entry":
                        purge_paths.extend(
                            row[0]
                            for row in db.execute(
                                "SELECT storage_key FROM photos WHERE entry_id=? AND storage_key IS NOT NULL",
                                (entity_id,),
                            )
                        )
                        purge_paths.extend(
                            f"media/thumbnails/{row[0][:2]}/{row[0]}"
                            for row in db.execute("SELECT id FROM photos WHERE entry_id=?", (entity_id,))
                        )
                result = _apply_one(db, mutation)
                if result["status"] == "applied":
                    media_to_delete.extend(purge_paths)
                db.execute(
                    "INSERT INTO applied_mutations(mutation_id,result_json,applied_at) VALUES(?,?,?)",
                    (mutation["id"], json.dumps(result), now()),
                )
                results.append(result)
                db.commit()
            except Exception:
                db.rollback()
                raise
        cursor = db.execute("SELECT COALESCE(MAX(seq),0) FROM changes").fetchone()[0]
    for storage_key in media_to_delete:
        (Path(data_dir) / storage_key).unlink(missing_ok=True)
    return results, cursor


def _apply_one(db: sqlite3.Connection, m: dict[str, Any]) -> dict[str, Any]:
    entity, op, entity_id = m.get("entity"), m.get("op"), m.get("entity_id")
    table = TABLES.get(entity)
    if table is None or op not in {"upsert", "delete", "restore", "purge"} or not isinstance(entity_id, str):
        return _reject("invalid_field", "Mutation shape is invalid", m)
    if (
        not isinstance(m.get("id"), str)
        or ID_RE.fullmatch(m["id"]) is None
        or ID_RE.fullmatch(entity_id) is None
        or not isinstance(m.get("fields", {}), dict)
    ):
        return _reject("invalid_field", "Mutation shape is invalid", m)
    fields = dict(m.get("fields", {}))
    collection_id = m.get("collection_id")
    if entity == "collection":
        collection_id = entity_id
    elif entity == "entry" and fields.get("collection_id"):
        collection_id = fields["collection_id"]
    elif entity == "photo" and fields.get("collection_id"):
        collection_id = fields["collection_id"]
    if (
        entity != "collection"
        and not db.execute("SELECT 1 FROM collections WHERE id=?", (collection_id,)).fetchone()
    ):
        return _reject("missing_parent", "Collection does not exist", m)
    if entity == "collection" and op in {"delete", "restore", "purge"}:
        return _reject("invalid_field", "Collections cannot be deleted through sync", m)
    current = db.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
    if op == "purge":
        if current is None or current["deleted_at"] is None:
            return _reject("invalid_field", "Only deleted records can be purged", m)
        db.execute(f"DELETE FROM {table} WHERE id=?", (entity_id,))
        db.execute(
            "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES(?,?,?,?)",
            (entity, entity_id, collection_id, "purged"),
        )
        return {"id": m["id"], "status": "applied", "server_revision": None, "record": None}
    if current is None:
        if op != "upsert" or m.get("base_revision") is not None:
            return _reject("missing_parent", "Record does not exist", m)
        if entity == "collection" and fields.get("storage_mode") != "synced":
            return _reject("collection_not_synced", "Only synced collections are accepted", m)
        allowed = CREATE_FIELDS[entity]
        fields = {key: value for key, value in fields.items() if key in allowed}
        fields["id"] = entity_id
        if entity == "collection":
            fields["storage_mode"] = "synced"
        if entity == "entry":
            fields["collection_id"] = collection_id
            if "sequence_number" not in fields:
                return _reject("invalid_field", "sequence_number is required", m)
            taken = db.execute(
                "SELECT id FROM entries WHERE collection_id=? AND sequence_number=?",
                (collection_id, fields["sequence_number"]),
            ).fetchone()
            if taken:
                collection = db.execute("SELECT * FROM collections WHERE id=?", (collection_id,)).fetchone()
                return {
                    "id": m["id"],
                    "status": "conflict",
                    "server_revision": None,
                    "record": public_record(collection, "collection"),
                    "code": "sequence_taken",
                }
        if entity == "photo":
            parent = db.execute(
                "SELECT collection_id FROM entries WHERE id=?", (fields.get("entry_id"),)
            ).fetchone()
            if parent is None:
                return _reject("missing_parent", "Entry does not exist", m)
            fields["collection_id"] = parent[0]
        for key, rule in MUTABLE_FIELDS[entity].items():
            if key in fields and not _valid(key, fields[key], rule):
                return _reject("invalid_field", f"Invalid {key}", m)
        required = {"created_at", "updated_at"}
        if entity == "entry":
            required |= {"collection_id", "sequence_number", "review_status"}
        if entity == "photo":
            required |= {
                "entry_id",
                "mime_type",
                "byte_size",
                "sha256",
                "crc32",
                "captured_at",
                "capture_source",
            }
        if entity == "collection":
            required |= {"name", "status"}
        if not required.issubset(fields):
            return _reject("invalid_field", "Create record is missing required fields", m)
        for key in required:
            if (
                key in fields
                and key in MUTABLE_FIELDS[entity]
                and not _valid(key, fields[key], MUTABLE_FIELDS[entity][key])
            ):
                return _reject("invalid_field", f"Invalid {key}", m)
        for key in ("created_at", "updated_at"):
            if not _valid_timestamp(fields.get(key)):
                return _reject("invalid_field", f"Invalid {key}", m)
        if entity == "entry" and (
            type(fields["sequence_number"]) is not int or fields["sequence_number"] < 1
        ):
            return _reject("invalid_field", "Invalid sequence_number", m)
        if entity == "collection" and (
            type(fields.get("next_sequence_number")) is not int or fields["next_sequence_number"] < 1
        ):
            return _reject("invalid_field", "Invalid next_sequence_number", m)
        field_revisions = {k: 1 for k in fields if k in MUTABLE_FIELDS[entity]}
        fields.update(revision=1, field_revisions=json.dumps(field_revisions))
        if entity == "photo":
            fields["is_cover"] = int(bool(fields.get("is_cover", False)))
        columns = list(fields)
        db.execute(
            f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
            [fields[k] for k in columns],
        )
        record = db.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
        db.execute(
            "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES(?,?,?,?)",
            (entity, entity_id, collection_id, "upsert"),
        )
        return {
            "id": m["id"],
            "status": "applied",
            "server_revision": 1,
            "record": public_record(record, entity),
        }
    if op in {"delete", "restore"}:
        fields["deleted_at"] = now() if op == "delete" else None
    fields = {key: value for key, value in fields.items() if key in MUTABLE_FIELDS[entity]}
    if op == "upsert":
        fields.pop("deleted_at", None)
    base = m.get("base_revision")
    if not isinstance(base, int):
        return _reject("invalid_field", "base_revision is required for updates", m)
    revisions = json.loads(current["field_revisions"])
    conflicts = [
        key
        for key, value in fields.items()
        if revisions.get(key, 0) > base
        and current[key] != value
        and not (entity == "collection" and key == "next_sequence_number")
    ]
    if conflicts:
        return {
            "id": m["id"],
            "status": "conflict",
            "server_revision": current["revision"],
            "record": public_record(current, entity),
            "code": "field_conflict",
            "conflicting_fields": conflicts,
        }
    for key, value in fields.items():
        if not _valid(key, value, MUTABLE_FIELDS[entity][key]):
            return _reject("invalid_field", f"Invalid {key}", m)
    if entity == "collection" and "next_sequence_number" in fields:
        fields["next_sequence_number"] = max(current["next_sequence_number"], fields["next_sequence_number"])
    changed = {key: value for key, value in fields.items() if current[key] != value}
    if changed:
        revision = current["revision"] + 1
        revisions.update({key: revision for key in changed})
        if entity == "photo" and "is_cover" in changed:
            changed["is_cover"] = int(changed["is_cover"])
        assignments = ",".join(f"{key}=?" for key in changed)
        db.execute(
            f"UPDATE {table} SET {assignments}, revision=?,field_revisions=?,updated_at=? WHERE id=?",
            [*changed.values(), revision, json.dumps(revisions), now(), entity_id],
        )
        db.execute(
            "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES(?,?,?,?)",
            (entity, entity_id, collection_id, op if op in {"delete", "restore"} else "upsert"),
        )
    record = db.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
    return {
        "id": m["id"],
        "status": "applied",
        "server_revision": record["revision"],
        "record": public_record(record, entity),
    }


def pull_changes(data_dir, cursor: int, limit: int) -> dict[str, Any]:
    with connect(data_dir) as db:
        latest = db.execute("SELECT COALESCE(MAX(seq),0) FROM changes").fetchone()[0]
        rows = db.execute(
            "SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?", (cursor, limit + 1)
        ).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        changes = []
        for change in rows:
            item = {"seq": change["seq"], "entity": change["entity"], "id": change["entity_id"]}
            if change["kind"] in {"purged", "removed"}:
                item[change["kind"]] = True
            else:
                row = db.execute(
                    f"SELECT * FROM {TABLES[change['entity']]} WHERE id=?", (change["entity_id"],)
                ).fetchone()
                if row is not None:
                    item["record"] = public_record(row, change["entity"])
                else:
                    item["purged"] = True
            changes.append(item)
    next_cursor = rows[-1]["seq"] if more and rows else latest
    return {"changes": changes, "cursor": next_cursor, "has_more": more}
