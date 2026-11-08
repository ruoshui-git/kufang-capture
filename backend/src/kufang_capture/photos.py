import hashlib
import os
import tempfile
import zlib
from pathlib import Path

from fastapi import HTTPException, Request
from starlette.responses import FileResponse

from .db import connect, single_writer
from .sync import now

CHUNK_SIZE = 1024 * 1024
THUMB_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _photo(data_dir: Path, photo_id: str):
    with connect(data_dir) as db:
        return db.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()


async def upload_original(request: Request, data_dir: Path, max_bytes: int, min_free_bytes: int):
    photo_id = request.path_params["photo_id"]
    record = _photo(data_dir, photo_id)
    if record is None:
        raise HTTPException(409, detail="photo_metadata_missing")
    claimed_hash = request.headers.get("x-content-sha256", "")
    if claimed_hash != record["sha256"]:
        raise HTTPException(422, detail="checksum_mismatch")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type and content_type != record["mime_type"].lower():
        raise HTTPException(422, detail="checksum_mismatch")
    if record["byte_size"] > max_bytes:
        raise HTTPException(413, detail="photo_too_large")
    if shutil_free(data_dir) < min_free_bytes:
        raise HTTPException(507, detail="server_storage_low")
    media = data_dir / "media"
    tmp_dir = media / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    destination = media / "originals" / photo_id[:2] / photo_id
    destination.parent.mkdir(parents=True, exist_ok=True)
    if record["stored_at"] and destination.is_file():
        if destination.stat().st_size == record["byte_size"]:
            return {
                "photo_id": photo_id,
                "sha256": record["sha256"],
                "byte_size": record["byte_size"],
                "server_storage_key": record["storage_key"],
            }
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
        os.replace(temp_path, destination)
        directory_fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        stored = now()
        with single_writer(), connect(data_dir) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "UPDATE photos SET stored_at=?,storage_key=?,updated_at=?,revision=revision+1 WHERE id=?",
                (stored, str(destination.relative_to(data_dir)), stored, photo_id),
            )
            db.execute(
                "INSERT INTO changes(entity,entity_id,collection_id,kind) VALUES('photo',?,?, 'upsert')",
                (photo_id, record["collection_id"]),
            )
            db.commit()
        return {
            "photo_id": photo_id,
            "sha256": digest.hexdigest(),
            "byte_size": size,
            "server_storage_key": str(destination.relative_to(data_dir)),
        }
    finally:
        temp_path.unlink(missing_ok=True)


def shutil_free(data_dir: Path) -> int:
    import shutil

    return shutil.disk_usage(data_dir).free


async def upload_thumbnail(request: Request, data_dir: Path):
    photo_id = request.path_params["photo_id"]
    record = _photo(data_dir, photo_id)
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
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    with connect(data_dir) as db:
        db.execute("UPDATE photos SET thumb_stored_at=? WHERE id=?", (now(), photo_id))
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
    cache = "private, max-age=31536000, immutable"
    if thumbnail and not path.is_file() and record["storage_key"]:
        # No client thumbnail was uploaded: serve the original so lists still show the photo,
        # but only cache briefly so a later thumbnail upload takes over.
        path = data_dir / record["storage_key"]
        mime = record["mime_type"]
        thumbnail = False
        cache = "private, max-age=300"
    if not path.is_file():
        raise HTTPException(404, detail="photo_not_stored")
    etag = record["sha256"] if not thumbnail else hashlib.sha256(path.read_bytes()).hexdigest()
    response = FileResponse(path, media_type=mime, headers={"ETag": f'"{etag}"', "Cache-Control": cache})
    return response


def head_original(data_dir: Path, photo_id: str):
    record = _photo(data_dir, photo_id)
    if record is None or not record["storage_key"]:
        raise HTTPException(404, detail="photo_not_stored")
    path = data_dir / record["storage_key"]
    if not path.is_file():
        raise HTTPException(404, detail="photo_not_stored")
    return {"ETag": f'"{record["sha256"]}"', "Cache-Control": "private, max-age=31536000, immutable"}
