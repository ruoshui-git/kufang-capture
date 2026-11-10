# REST and sync contract (schema 2)

This contract is owned by the orchestrator. The server stores **only** collections whose `storage_mode` is `synced`. Local Only data never reaches these endpoints.

All paths are under `/api`. JSON uses the snake_case field names from `frontend/src/lib/types.ts`. Errors look like `{"detail": "<code>", "message": "<human text>"}`.

## Auth (single user)

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/auth/login` | `{"password": "..."}` → `204`, sets the session cookie. `401 invalid_password`. `429 too_many_attempts` with `Retry-After`. |
| POST | `/api/auth/logout` | → `204`, clears the cookie and deletes the server session |
| GET | `/api/auth/session` | → `{"authenticated": bool, "expires_at": ts \| null}` (never 401) |

- **Cookie.** It is called `__Host-kc_session` when `CAPTURE_PUBLIC_ORIGIN` is https, and `kc_session` in http dev. It is HttpOnly, SameSite=Strict, Path=/, and also Secure when on https. The value is a random 32-byte token. The server stores only its SHA-256, in the `sessions` table. A session lasts 30 days, sliding, and is renewed when less than 15 days remain.
- **Password.** It is checked against the argon2id `CAPTURE_PASSWORD_HASH`. In dev, when the hash is unset, `CAPTURE_DEV_PASSWORD` is accepted, but only when the origin is http://127.0.0.1 or localhost.
- **Login backoff.** It is counted per client IP, using Traefik's `X-Forwarded-For` (uvicorn runs with proxy headers). After 5 failures within 15 minutes, the server returns 429 with exponential delays capped at 15 minutes.
- **CSRF.** Every unsafe method (POST, PUT, PATCH, DELETE) needs the header `X-Capture-Request: 1`. When an `Origin` header is present, it must equal `CAPTURE_PUBLIC_ORIGIN`; otherwise the request fails with `403 csrf_failed`.
- **Session required.** Every endpoint except `/api/health`, `/api/auth/*` and the static files requires a session. Without one the response is `401 auth_required`.

## Sync

**Schema 2 (shared items).** Records are `collection`, `item`, `entry` and `photo`. An `item` holds what is shared by every collection that has it: `title`, `notes`, `expiration_date`, `dimensions`, `review_status` and its photos. An `entry` is the item's place in one collection: `collection_id`, `item_id`, `sequence_number`, `quantity`, `unit`, `count_detail` and `deleted_at`. A photo belongs to an item (`item_id`); photo records have no `collection_id`. Data migrated from schema 1 keeps `item.id = entry.id`, and a never-shared entry created later also uses its own id as `item_id`.

**Version guard.** `POST /api/sync/batch` requires `"schema": 2` in the body, and `GET /api/sync/changes` requires the query parameter `schema=2`. Without it, both answer `409 client_outdated` and write nothing. A schema-1 client keeps its outbox (items are cleared only on acknowledgment) and syncs again after it updates and migrates.

The server keeps per-record integer `revision` (that is, the client's `server_revision`), `field_revisions` (`{field: revision}`), and a global, monotonically increasing change `seq` used as the pull cursor.

### `POST /api/sync/batch`

```json
{ "schema": 2, "device_id": "01J...", "mutations": [ { "id": "01J…mutation", "entity": "collection|item|entry|photo",
  "entity_id": "01J…", "collection_id": "01J…", "op": "upsert|delete|restore|purge",
  "base_revision": null, "fields": { } } ] }
```

The client sends at most 200 mutations per batch, ordered collection, then item, then entry, then photo, and by outbox `created_at` within each entity. The server applies them in order, and each one in its own transaction.

**Client outbox rules.** A batch carries at most one mutation per record, and no record is sent while an earlier mutation for it is unacknowledged. Local edits are merged into a queued mutation only until its first send starts; after that the mutation id may already be applied, so later edits go into a new mutation. When a mutation is acknowledged (`applied` or `duplicate`), each later queued mutation for the same record is rebased to the acknowledged `server_revision` if every one of its fields was either written by the acknowledged mutation or has `field_revisions[f] <=` its old base. Otherwise its base is kept, so a change from another device still conflicts. A device therefore never conflicts with its own edits.

Each mutation gets one result: `{ "id", "status", "server_revision", "record", "code"?, "message"? }`.
- `applied`: the change was stored. `record` is the full server record afterwards.
- `duplicate`: the mutation id was seen before and was `applied` then. The stored result is returned again (idempotency). A mutation id whose stored result is `conflict` or `rejected` returns that result again with its **original** status and `"duplicate": true`, so a retry is never mistaken for success.
- `conflict`: `record` is the current server record and `code` is one of the conflict codes below. Nothing was written.
- `rejected`: the mutation is invalid. `code` is, for example, `collection_not_synced`, `missing_parent` or `invalid_field`. Nothing was written. The client shows it as `Sync error`.

The response also carries `cursor`, the latest change seq.

**Field rules.**
- **Create** (`base_revision` null and an unknown id) inserts the full record. A collection create must have `storage_mode: "synced"`, otherwise it is rejected with `collection_not_synced`.
- **Parents.** An entry create needs its `collection_id` and `item_id` to exist, and a photo create needs its `item_id`; otherwise the result is `rejected` with `missing_parent`. An item create needs the mutation's `collection_id` to be a server collection (any collection with an entry for the item). An entry create for an item that already has an entry in the same collection is `rejected` with `item_already_in_collection`.
- **Update** compares fields. For each field f in `fields`: if `field_revisions[f] > base_revision` and the server value differs from the incoming value, the result is `conflict` with code `field_conflict`, and `conflicting_fields` is listed in the result. Otherwise all fields are applied, `revision` is incremented, and `field_revisions[f]` is set to the new revision for every changed field. Editing the same record twice before a sync therefore arrives as one coalesced mutation carrying the latest values.
- **Server-owned and immutable fields** are ignored: `revision`, `server_revision`, `sync_state`, `upload_state`, `server_storage_key`, `id`, `collection_id`/`item_id` after create, `sequence_number` after create, and `sha256`/`byte_size`/`crc32`/`mime_type` after create.
- **`next_sequence_number`** on a collection is merged as `max(server, incoming)` and never conflicts. A client queues the collection's `next_sequence_number` whenever it allocates a number, and on pull keeps `max(incoming, local, 1 + highest local sequence_number in the collection)`, so a pulled counter never lowers the local one.
- **Entry create with a taken `sequence_number`** (another entry in the same collection already has it) returns `conflict` with code `sequence_taken` and `record` = the collection, which carries the server's `next_sequence_number`. The client reallocates a fresh local number for this never-synced entry and retries. This can happen only with two devices; numbers that have been shared are never renumbered.
- **`delete`/`restore`** set or clear `deleted_at`, following the same revision rules.
- **`purge`** permanently removes an entry or photo that is already deleted, together with its media. When the last entry of an item is purged, the item and all its photos and media are purged too, each recorded as a `purged` change.
- **Unknown fields** for an entity (for example a schema-1 `entry_id` on a photo, or `title` on an entry) are `rejected` with `invalid_field`.

### `GET /api/sync/changes?cursor=N&limit=500`

Returns `{ "changes": [ { "seq": 12, "entity": "entry", "id": "01J…", "record": { … } } ], "cursor": 57, "has_more": false }`.

- Records are full server records.
- A purged entity is sent as `{"seq", "entity", "id", "purged": true}`.
- A collection whose server copy was removed is sent as `{"seq", "entity": "collection", "id", "removed": true}`. Items left with no entry are purged in the same step and sent as purged items and photos.
- Changes for items and photos carry an empty `collection_id` internally; clients decide by the local entries that reference the item.

The client merges each record unless the entity has a pending outbox item or an unresolved conflict. In that case it keeps the local values for the fields that are pending or in conflict and adopts the rest. A logged-in desktop browser therefore receives every synced collection. It never sees Local Only collections.

**Local Only wins locally.** A client never overwrites or deletes local data that belongs to a Local Only collection because of a pulled change: a collection `removed`/record for a local Local Only collection, and an item or photo change (record or purge) for an item that any local Local Only entry references, are ignored.

### Photo bytes

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/photos/{id}/original` | Raw body; see below |
| HEAD | `/api/photos/{id}/original` | `200` with `ETag` = sha256 when stored and verified, `404` otherwise. Used to resume after the app is killed. |
| PUT | `/api/photos/{id}/thumbnail` | Optional client JPEG, at most 1 MB, replaceable |
| GET | `/api/photos/{id}/original`, `/thumbnail` | Authed; `Cache-Control: private, max-age=31536000, immutable`; `ETag` |

`PUT …/original` sends the raw body with these headers:
- `Content-Type`: the photo's mime type
- `Content-Length`
- `X-Content-SHA256`: lowercase hex
- `X-Capture-Request: 1`

The photo's metadata must already be synced: otherwise `409 photo_metadata_missing`. The header hash must equal the metadata `sha256`: otherwise `422 checksum_mismatch`.

The server streams the body to a temp file in the media volume while computing SHA-256, CRC-32 and the size. Bodies over `MAX_PHOTO_BYTES` get `413`. The server verifies all three against the metadata, fsyncs, and renames the file atomically to `media/originals/<id[0:2]>/<id>`.

The response is `201` (or `200` if it was already stored with the same hash), with `{ "photo_id", "sha256", "byte_size", "server_storage_key" }`. Only then does the client mark the photo `uploaded` (shown as "Backed up"). If free disk space is below `MIN_FREE_BYTES`, the server answers `507 server_storage_low` before reading the body.

## Collections (desktop export and server-copy removal)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/collections` | Server collections, each with active `entry_count`, `photo_count`, `stored_photo_bytes` and `missing_originals`. Photo figures count the active photos of items with an active entry in the collection, so a shared photo counts in each collection. |
| DELETE | `/api/collections/{id}/server-copy` | Requires the header `X-Confirm-Name` to equal the collection name (URL-encoded UTF-8). Deletes the collection and its entries, purges items no remaining entry references (with their photos and media), records the `removed` and `purged` changes, and returns `204`. Items still referenced by another collection are kept. |

## Exports (server, streamed)

`GET /api/exports/all.zip?include_trash=0|1` and `GET /api/exports/collections/{id}.zip?include_trash=0|1` stream the archive. The layout is exactly as in [export-format.md](export-format.md), with `source: "server"`. They use STORE mode, built from the stored crc32 and size values, with no temp file. A photo whose original was never uploaded is listed in `manifest.json` under `missing_originals` (the photo id and path) and is not included. The response carries `Content-Disposition: attachment; filename="…"`.

## Clarifications (from the v1 server implementation)

- **Batch response.** The response is `{ "results": [...], "cursor": N }`. A `field_conflict` result also carries `conflicting_fields`, and records expose `revision` and `field_revisions`.
- **Idempotency.** It covers every outcome, including deterministic `conflict` and `rejected` results. A client that changes a rejected or conflicting operation must send it under a **new** mutation id.
- **Changes cursor.** While `has_more` is true, `cursor` is the last sequence returned on that page. On the final page, it is the latest sequence. Advance to it; no page is skipped.
- **Migration 0003 (schema 2).** Runs in one transaction. Each entry yields an item with the same id; the item copies the entry's shared fields, `revision`, and the `field_revisions` of the shared fields; the entry keeps its own revision and per-collection `field_revisions`. Photos keep their id and media, with `item_id` = their old `entry_id`.
- **Photo storage key.** After upload, photo records expose `server_storage_key` and `stored_at`. The server's internal storage path is never exposed.
- **`photo_bytes` in server exports.** It counts the metadata `byte_size` of every active photo, including those listed in `missing_originals`.
- **Trash export.** `trash/entries.csv` also lists active entries that own deleted photos, so every `trash/photos.csv` row has a valid entry reference.
- **Client IP.** Login backoff uses the **rightmost** `X-Forwarded-For` hop, which is the peer that Traefik observed. The app is reachable only through Traefik.
- **Unknown routes.** Every `/api` path except `/api/health` and `/api/auth/*` requires a session, including unknown paths. Unauthenticated callers get `401` and learn nothing about which routes exist.
