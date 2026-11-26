import asyncio
import hashlib
import os
import sqlite3
import stat
import tempfile
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from io import FileIO
from pathlib import Path
from weakref import WeakValueDictionary

from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect
from starlette.responses import FileResponse, JSONResponse, Response

from .db import connect, single_writer
from .sync import now

CHUNK_SIZE = 1024 * 1024
PARTIAL_MAX_AGE = 7 * 24 * 60 * 60
THUMB_TYPES = {"image/jpeg", "image/png", "image/webp"}
ORIGINAL_FIELDS = ("item_id", "sha256", "byte_size", "crc32", "mime_type")


def _photo(data_dir: Path, photo_id: str):
    with connect(data_dir) as db:
        return db.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()


def _upload_metadata(data_dir: Path, photo_id: str) -> sqlite3.Row | None:
    with connect(data_dir) as db:
        return db.execute(
            "SELECT photos.*, (SELECT COALESCE(MAX(seq), 0) FROM changes) AS upload_cursor "
            "FROM photos WHERE id=?",
            (photo_id,),
        ).fetchone()


def _recheck_upload_metadata(db: sqlite3.Connection, record: sqlite3.Row) -> sqlite3.Row:
    # A new row can reuse the same photo id after a device re-enables sync.
    current = db.execute(
        "SELECT * FROM photos WHERE id=? AND NOT EXISTS ("
        "SELECT 1 FROM changes WHERE seq>? AND entity='photo' AND entity_id=? AND kind='purged')",
        (record["id"], record["upload_cursor"], record["id"]),
    ).fetchone()
    if current is None:
        raise HTTPException(409, detail="photo_metadata_missing")
    if any(current[key] != record[key] for key in ORIGINAL_FIELDS):
        raise HTTPException(422, detail="checksum_mismatch")
    return current


def _original_metadata(
    request: Request, data_dir: Path, max_bytes: int, *, resumable: bool = False
) -> sqlite3.Row:
    record = _upload_metadata(data_dir, request.path_params["photo_id"])
    if record is None:
        raise HTTPException(409, detail="photo_metadata_missing")
    if request.headers.get("x-content-sha256") != record["sha256"]:
        raise HTTPException(422, detail="checksum_mismatch")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if resumable:
        if content_type != "application/offset+octet-stream":
            raise HTTPException(415, detail="unsupported_chunk_type")
    elif content_type and content_type != record["mime_type"].lower():
        raise HTTPException(422, detail="checksum_mismatch")
    if record["byte_size"] > max_bytes:
        raise HTTPException(413, detail="photo_too_large")
    return record


def _destination(data_dir: Path, photo_id: str) -> Path:
    return data_dir / "media" / "originals" / photo_id[:2] / photo_id


def _partial_dir(data_dir: Path) -> Path:
    return data_dir / "media" / "tmp" / "partial"


def _partial_path(data_dir: Path, record: sqlite3.Row) -> Path:
    return _partial_dir(data_dir) / f"{record['id']}.{record['sha256']}"


def remove_partial_uploads(data_dir: Path, photo_id: str, *, keep: Path | None = None) -> None:
    for path in _partial_dir(data_dir).glob(f"{photo_id}.*"):
        if path != keep:
            path.unlink(missing_ok=True)


def _expire_partials(directory: Path) -> None:
    cutoff = time.time() - PARTIAL_MAX_AGE
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                try:
                    if entry.stat().st_mtime < cutoff:
                        os.unlink(entry.path)
                except FileNotFoundError:
                    pass
    except FileNotFoundError:
        pass


def _file_stat(path: Path) -> os.stat_result | None:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    return info if stat.S_ISREG(info.st_mode) else None


def _partial_size(path: Path) -> int:
    info = _file_stat(path)
    return info.st_size if info else 0


def _original_result(record: sqlite3.Row, storage_key: str) -> dict[str, str | int]:
    return {
        "photo_id": record["id"],
        "sha256": record["sha256"],
        "byte_size": record["byte_size"],
        "server_storage_key": storage_key,
    }


def _original_is_stored(record: sqlite3.Row, destination: Path) -> bool:
    info = _file_stat(destination) if record["stored_at"] else None
    return info is not None and info.st_size == record["byte_size"]


def _install_original(
    data_dir: Path,
    source: Path,
    destination: Path,
    record: sqlite3.Row,
    authorize: Callable[[], None],
    *,
    resumable: bool = False,
) -> tuple[dict[str, str | int], int]:
    photo_id = record["id"]
    with single_writer(), connect(data_dir) as db:
        authorize()
        db.execute("BEGIN IMMEDIATE")
        current = _recheck_upload_metadata(db, record)
        if resumable and _original_is_stored(current, destination):
            remove_partial_uploads(data_dir, photo_id)
            return _original_result(current, current["storage_key"]), 200
        os.replace(source, destination)
        directory_fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        stored = now()
        key = str(destination.relative_to(data_dir))
        db.execute(
            "UPDATE photos SET stored_at=?,storage_key=?,updated_at=?,revision=revision+1 WHERE id=?",
            (stored, key, stored, photo_id),
        )
        db.execute(
            "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES('photo',?,?, 'upsert')",
            (photo_id, ""),
        )
        db.commit()
        remove_partial_uploads(data_dir, photo_id)
    return _original_result(record, key), 201


async def upload_original(
    request: Request, data_dir: Path, max_bytes: int, min_free_bytes: int, authorize: Callable[[], None]
):
    record = _original_metadata(request, data_dir, max_bytes)
    if shutil_free(data_dir) < min_free_bytes:
        raise HTTPException(507, detail="server_storage_low")
    photo_id = record["id"]
    tmp_dir = data_dir / "media" / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    destination = _destination(data_dir, photo_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if record["stored_at"]:
        with single_writer(), connect(data_dir) as db:
            authorize()
            db.execute("BEGIN IMMEDIATE")
            current = _recheck_upload_metadata(db, record)
            if _original_is_stored(current, destination):
                remove_partial_uploads(data_dir, photo_id)
                return _original_result(current, current["storage_key"])
    digest = hashlib.sha256()
    crc = 0
    size = 0
    fd, temp_name = tempfile.mkstemp(prefix="upload-", dir=tmp_dir)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as output:
            async for chunk in request.stream():
                if not chunk:
                    continue
                for offset in range(0, len(chunk), CHUNK_SIZE):
                    piece = chunk[offset : offset + CHUNK_SIZE]
                    size += len(piece)
                    if size > max_bytes:
                        raise HTTPException(413, detail="photo_too_large")
                    digest.update(piece)
                    crc = zlib.crc32(piece, crc)
                    output.write(piece)
            output.flush()
            os.fsync(output.fileno())
        if (
            size != record["byte_size"]
            or digest.hexdigest() != record["sha256"]
            or crc & 0xFFFFFFFF != record["crc32"]
        ):
            raise HTTPException(422, detail="checksum_mismatch")
        result, _ = _install_original(data_dir, temp_path, destination, record, authorize)
        return result
    finally:
        temp_path.unlink(missing_ok=True)


@dataclass
class _PartialUpload:
    lock: asyncio.Lock
    owner: object | None = None


# Active requests hold a strong reference, so completed uploads leave no registry entries.
_partial_uploads: WeakValueDictionary[Path, _PartialUpload] = WeakValueDictionary()


def _upload_offset_mismatch(path: Path) -> JSONResponse:
    size = _partial_size(path)
    return JSONResponse(
        {"detail": "upload_offset_mismatch", "offset": size},
        status_code=409,
        headers={"Upload-Offset": str(size)},
    )


def _verify_partial(output: FileIO, record: sqlite3.Row) -> bool:
    output.seek(0)
    digest = hashlib.sha256()
    crc = size = 0
    while chunk := output.read(CHUNK_SIZE):
        size += len(chunk)
        digest.update(chunk)
        crc = zlib.crc32(chunk, crc)
    return size == record["byte_size"] and digest.hexdigest() == record["sha256"] and crc == record["crc32"]


async def patch_original(
    request: Request, data_dir: Path, max_bytes: int, min_free_bytes: int, authorize: Callable[[], None]
) -> Response:
    record = _original_metadata(request, data_dir, max_bytes, resumable=True)
    offset = request.headers.get("upload-offset", "")
    if not offset.isascii() or not offset.isdecimal():
        raise HTTPException(422, detail="invalid_upload_offset")
    photo_id = record["id"]
    destination = _destination(data_dir, photo_id)
    path = _partial_path(data_dir, record)
    upload = _partial_uploads.setdefault(path.parent / photo_id, _PartialUpload(asyncio.Lock()))
    owner = object()

    async with upload.lock:
        with single_writer(), connect(data_dir) as db:
            authorize()
            current = _recheck_upload_metadata(db, record)
            _expire_partials(path.parent)
            if shutil_free(data_dir) < min_free_bytes:
                raise HTTPException(507, detail="server_storage_low")
            if _original_is_stored(current, destination):
                remove_partial_uploads(data_dir, photo_id)
                return JSONResponse(_original_result(current, current["storage_key"]))
            path.parent.mkdir(parents=True, exist_ok=True)
            remove_partial_uploads(data_dir, photo_id, keep=path)
            start = _partial_size(path)
            if start > record["byte_size"]:
                path.unlink(missing_ok=True)
                start = 0
            upload.owner = owner
            if (offset.lstrip("0") or "0") != str(start):
                return _upload_offset_mismatch(path)
            content_length = request.headers.get("content-length", "").lstrip("0")
            if (
                content_length.isascii()
                and content_length.isdecimal()
                and (len(content_length) > len(str(CHUNK_SIZE)) or int(content_length) > CHUNK_SIZE)
            ):
                raise HTTPException(413, detail="chunk_too_large")
            output = FileIO(path, "a+")

    size = start
    disconnected = False
    with output:
        try:
            try:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    async with upload.lock:
                        if upload.owner is not owner:
                            return _upload_offset_mismatch(path)
                        if not os.fstat(output.fileno()).st_nlink:
                            # A purge or a successful PUT can unlink the open partial.
                            with connect(data_dir) as db:
                                _recheck_upload_metadata(db, record)
                            return _upload_offset_mismatch(path)
                        size += len(chunk)
                        if size - start > CHUNK_SIZE:
                            output.truncate(start)
                            raise HTTPException(413, detail="chunk_too_large")
                        if size > record["byte_size"]:
                            path.unlink(missing_ok=True)
                            raise HTTPException(422, detail="checksum_mismatch")
                        if output.write(chunk) != len(chunk):
                            raise OSError("Short write to original upload")
            except ClientDisconnect:
                disconnected = True
        finally:
            os.fsync(output.fileno())

        async with upload.lock:
            if upload.owner is not owner:
                return _upload_offset_mismatch(path)
            if disconnected or size < record["byte_size"]:
                return Response(status_code=204, headers={"Upload-Offset": str(size)})
            # Hash from disk in bounded pieces while other photos can keep uploading.
            if not await asyncio.to_thread(_verify_partial, output, record):
                path.unlink(missing_ok=True)
                raise HTTPException(422, detail="checksum_mismatch")
            destination.parent.mkdir(parents=True, exist_ok=True)
            result, status = _install_original(data_dir, path, destination, record, authorize, resumable=True)
            return JSONResponse(result, status_code=status)


def shutil_free(data_dir: Path) -> int:
    import shutil

    return shutil.disk_usage(data_dir).free


async def upload_thumbnail(request: Request, data_dir: Path, authorize: Callable[[], None]):
    photo_id = request.path_params["photo_id"]
    record = _upload_metadata(data_dir, photo_id)
    if record is None:
        raise HTTPException(404, detail="photo_not_found")
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if mime not in THUMB_TYPES:
        raise HTTPException(415, detail="unsupported_thumbnail_type")
    target = data_dir / "media" / "thumbnails" / photo_id[:2] / photo_id
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="thumb-", dir=target.parent)
    temp = Path(temp_name)
    size = 0
    try:
        with os.fdopen(fd, "wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 1024 * 1024:
                    raise HTTPException(413, detail="thumbnail_too_large")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        with single_writer(), connect(data_dir) as db:
            authorize()
            db.execute("BEGIN IMMEDIATE")
            _recheck_upload_metadata(db, record)
            os.replace(temp, target)
            db.execute("UPDATE photos SET thumb_stored_at=? WHERE id=?", (now(), photo_id))
            db.commit()
    finally:
        temp.unlink(missing_ok=True)
    return {"photo_id": photo_id, "byte_size": size}


def get_photo(data_dir: Path, photo_id: str, thumbnail: bool):
    record = _photo(data_dir, photo_id)
    if record is None:
        raise HTTPException(404, detail="photo_not_found")
    if thumbnail:
        path = data_dir / "media" / "thumbnails" / photo_id[:2] / photo_id
        mime = None
    else:
        path = data_dir / record["storage_key"] if record["storage_key"] else Path("/")
        mime = record["mime_type"]
    if thumbnail and not path.is_file() and record["storage_key"]:
        # Serve the original while a client thumbnail is unavailable.
        path = data_dir / record["storage_key"]
        mime = record["mime_type"]
        thumbnail = False
    if not path.is_file():
        raise HTTPException(404, detail="photo_not_stored")
    etag = record["sha256"] if not thumbnail else hashlib.sha256(path.read_bytes()).hexdigest()
    return FileResponse(path, media_type=mime, headers={"ETag": f'"{etag}"'})


def head_original(data_dir: Path, photo_id: str):
    record = _photo(data_dir, photo_id)
    path = data_dir / record["storage_key"] if record is not None and record["storage_key"] else None
    if path is None or not _original_is_stored(record, path):
        offset = 0
        if record is not None:
            partial = _file_stat(_partial_path(data_dir, record))
            if (
                partial is not None
                and partial.st_mtime >= time.time() - PARTIAL_MAX_AGE
                and partial.st_size <= record["byte_size"]
            ):
                offset = partial.st_size
        raise HTTPException(404, detail="photo_not_stored", headers={"Upload-Offset": str(offset)})
    return {
        "ETag": f'"{record["sha256"]}"',
        "Content-Type": record["mime_type"],
        "Content-Length": str(record["byte_size"]),
    }
