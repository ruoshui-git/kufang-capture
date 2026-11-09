# Export format (version 2)

The device exporter (`frontend/src/lib/export/`) and the server exporter (`backend/`) **must produce the same layout**. `tools/verify-export.py` validates any export. Changes to this file need a format_version bump.

**Version 2 (shared items).** An item can appear in several collections, each time as its own entry with its own number and count. Photos belong to the item. Compared with version 1, `entries` gains `item_id`, and `photos` replaces `entry_id,collection_id` with `item_id`, stored under `photos/<item_id>/`. Data created before version 2 has `item_id = entry_id`, so its photo paths are unchanged. `tools/verify-export.py` still accepts version 1 archives.

## Archive

- File name: `kufang-capture-<scope>-<YYYYMMDD-HHMMSS>Z.zip`. Scope is `all` or a slug of the single collection name, ASCII, max 40 chars.
- ZIP entries use method **STORE** (0), with no compression and no re-encoding. Names are UTF-8 (general-purpose bit 11). **ZIP64** records are used when any size or offset exceeds 0xFFFFFFFF, or when the entry count exceeds 0xFFFF. Each DOS timestamp is the entry's `exported_at` in UTC. Entries appear in the order listed below.
- Every path is under one root directory, `capture-export/`.

```text
capture-export/
  manifest.json
  collections.csv   collections.json
  entries.csv       entries.json
  photos.csv        photos.json
  photos/<item_id>/<photo_id>.<ext>
  trash/                              # only when include_trash = true
    entries.csv  entries.json
    photos.csv   photos.json
    photos/<item_id>/<photo_id>.<ext>
```

- **Active set**: an entry is active when `deleted_at` is null. A photo is active when its own `deleted_at` is null and its item has at least one active entry in the export.
- **Trash set**: deleted entries; every photo of an item that has no active entry in the export; and deleted photos of items that do. It is excluded by default.
- **Each photo appears once** per archive (in the active or the trash set), even when its item has entries in several exported collections.
- **Extension**: `image/jpeg` → `jpg`, `image/heic` → `heic`, `image/heif` → `heif`, `image/png` → `png`, `image/webp` → `webp`, `image/gif` → `gif`. Any other type uses the lowercase extension of `original_filename`, if it is 1–5 alphanumerics, and otherwise `bin`.
- Photo files are the **exact original bytes**. Their SHA-256 equals `photos.csv.sha256`.

## Ordering

- Collections by `created_at`, then `id`.
- Entries by collection order, then `sequence_number`.
- Photos by the order of their item's first entry, then `sort_order`, then `captured_at`.

## CSV rules

UTF-8 with a BOM, CRLF line endings, RFC 4180 quoting (a field is quoted when it contains a comma, a quote, CR or LF, and inner quotes are doubled). Values are raw, so nothing is coerced into a formula, number or date. Empty and null are both written as an empty cell; JSON keeps the difference. Booleans are written as `true`/`false`. Timestamps are ISO 8601 UTC.

### collections.csv

`collection_id,name,description,status,storage_mode,next_sequence_number,entry_count,photo_count,created_at,updated_at,archived_at`

`entry_count` and `photo_count` count the active set. A shared photo counts in each collection that has an active entry for its item.

### entries.csv

`entry_id,item_id,collection_id,sequence_number,sequence_label,title,display_title,quantity,unit,count_detail,notes,expiration_date,dimensions,review_status,photo_count,created_at,updated_at,deleted_at`

- `title`, `notes`, `expiration_date`, `dimensions` and `review_status` come from the shared item, so rows with the same `item_id` agree. `quantity`, `unit` and `count_detail` are this collection's count.
- `updated_at` is the later of the entry's and the item's `updated_at`.

- `sequence_label` is `#0042`.
- `display_title` is the title, or `Entry #0042` when no title is set.
- `quantity` is the raw decimal string; it is empty when not recorded, and an empty quantity is **not** zero.
- `photo_count` is the number of the item's photos in the same set as the row (active or trash).

### photos.csv

`photo_id,item_id,path,original_filename,mime_type,byte_size,sha256,width,height,sort_order,caption,is_cover,capture_source,captured_at,created_at,deleted_at`

`path` is relative to `capture-export/`, e.g. `photos/<item_id>/<photo_id>.jpg`. `capture_source` is one of `native_camera`, `photo_library` or `camera_frame`. A `camera_frame` photo is an app-encoded video frame, not a native still.

The trash CSVs use the same columns. Their paths begin with `trash/photos/`.

## JSON files

Each JSON file is an array of objects with the same keys as its CSV, using real JSON types: numbers, booleans, and `null` for null. The JSON files are the lossless form.

## manifest.json

```json
{
  "format": "kufang-capture-export",
  "format_version": 2,
  "exported_at": "2026-11-08T07:00:00.000Z",
  "source": "device",
  "app_version": "0.1.0+<git-sha>",
  "scope": "all",
  "include_trash": false,
  "collections": [{ "id": "01J...", "name": "Temple 2 / A04", "storage_mode": "local_only" }],
  "counts": {
    "collections": 1, "items": 15, "entries": 15, "photos": 42, "photo_bytes": 123456789,
    "trash_entries": 0, "trash_photos": 0
  },
  "quantity_by_unit": [
    { "collection_id": "01J...", "unit": "boxes", "total": "12", "entry_count": 4 }
  ],
  "files": [{ "path": "entries.csv", "byte_size": 1234, "sha256": "..." }],
  "missing_originals": []
}
```

- `source` is `device` or `server`. `scope` is `all` or `selected`.
- `counts.items` is the number of distinct `item_id` values among active entries; `counts.photos` counts distinct active photos.
- `missing_originals` is always `[]` for device exports. For server exports it lists `{photo_id, path}` for any photo whose original has not been uploaded yet. Those photos still appear in `photos.csv`, but their files are absent.
- `files` lists every archive member except `manifest.json`, CSV/JSON and photos alike, with its SHA-256.
- `quantity_by_unit` sums active entries per collection and per normalized unit (trimmed, case-folded; the displayed unit is the most recent spelling). Units are never combined with each other.

## Verification

`python3 tools/verify-export.py EXPORT.zip [--originals DIR]` checks:
- the layout
- the manifest counts and the file hashes
- the CSV foreign keys: every `entries.collection_id` is in `collections`; every active `photos.item_id` is the `item_id` of an active entry; every trash `photos.item_id` is the `item_id` of some entry in either set; each `photo_id` appears once; rows sharing an `item_id` agree on the item fields
- version 1 archives with the version 1 rules (`photos.entry_id` in `entries`)
- that each photo's bytes match its sha256 and byte_size
- that CSV and JSON agree
- STORE-only compression

It exits nonzero with a list of every problem it found.
