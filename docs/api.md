# REST and sync contract (schema 2)

This contract is owned by the orchestrator. The server stores **only** collections whose `storage_mode` is `synced`. Local Only data never reaches these endpoints.

All paths are under `/api`. JSON uses the snake_case field names from `frontend/src/lib/types.ts`. Errors look like `{"detail": "<code>", "message": "<human text>"}`.

## Accounts and authentication

All session and People responses use `Cache-Control: no-store`. Timestamps are ISO 8601 UTC strings.

| Method | Path | Body and response |
|---|---|---|
| POST | `/api/auth/login` | `{"password":"..."}` → `204` with the owner session cookie. `401 invalid_password` or `429 too_many_attempts` with `Retry-After`. |
| POST | `/api/auth/join` | `{"code":"ABCD-1234","device_label":"iPhone"}` → `204` with a helper session cookie. Omit the label or pass `null` to leave it unnamed. A string label is trimmed and allows up to 80 characters. `401 invalid_join_code` covers wrong, expired, used and superseded codes. `422 invalid_device_label` signals a malformed label. `429 too_many_attempts` includes `Retry-After`. |
| POST | `/api/auth/logout` | No body → `204`. Revokes this session and clears its cookie. |
| GET | `/api/auth/session` | `200 {"authenticated":true,"expires_at":"2026-12-25T18:00:00.000Z","user":{"id":"owner","name":"Owner","is_owner":true}}` or `200 {"authenticated":false,"expires_at":null,"user":null}`. A helper's `id` is an uppercase ULID and `is_owner` is false. |

- **Cookie.** HTTPS uses `__Host-kc_session` with Secure. HTTP dev uses `kc_session`. Both are HttpOnly, SameSite=Strict and Path=/. SQLite stores the SHA-256 of the random 32-byte token. A successful sign-in revokes the browser's previous session. `GET /api/auth/session` renews both the cookie and the stored expiry. The owner session lasts 30 days and renews with less than 15 days left. A helper session lasts 180 days and renews with less than 150 days left.
- **Owner password.** The server checks `CAPTURE_PASSWORD_HASH` using Argon2id. With the hash unset, `CAPTURE_DEV_PASSWORD` is available on loopback HTTP. The route stops accepting attempts from an IP after five failures from that IP in a rolling 15-minute window. It checks one password at a time. Throttled requests return `429 too_many_attempts` with `Retry-After`.
- **Join code.** Eight characters are displayed as `XXXX-XXXX`. Input ignores case, whitespace and dashes. It treats O as 0 and I or L as 1. Only a successful POST consumes a code. Each code expires after ten minutes. The join route stops accepting attempts after 10 failures from one IP or 100 total in a rolling 15-minute window, independent of password failures. The browser reads the code from the `/join#CODE` fragment and submits it only after confirmation.
- **CSRF.** POST, PUT, PATCH and DELETE require `X-Capture-Request: 1`. If present, `Origin` must match `CAPTURE_PUBLIC_ORIGIN`. Failure returns `403 csrf_failed`. Login, join, and People create and update accept JSON objects up to 4 KiB. Larger bodies return `413 request_too_large`. Invalid JSON or a value other than an object returns `422 invalid_request`.
- **Session required.** Protected routes return `401 auth_required` for missing, expired, revoked and disabled sessions. If a helper database fails to open or migrate at startup, that helper's session check, protected requests and sign-in with a valid join code return `503 account_unavailable`. Health, auth and static files are public. The Agent API uses its separate bearer credential.

### Account binding

Send `X-Capture-Account: <bound account ID>` on sync, photo, collections, server-copy and export requests. An owner session may omit it for compatibility with older clients. A helper session without it receives `409 {"detail":"account_required"}`. A supplied value that differs from the current session's ID receives `409 {"detail":"account_mismatch"}`. These errors occur before reading or writing account data. Auth endpoints do not require this header. A non-owner session receives `403 {"detail":"owner_required"}` on People routes, even without the binding header.

The client persists the device binding and stops data requests if the session belongs to a different account. For photo and export requests, use a credentialed fetch that carries the binding header. Use `cache: "no-store"` on photo fetches, including downloads and thumbnails, to bypass older HTTP cache entries created before account binding. Photo responses use `Cache-Control: private, no-store` and `Vary: Cookie, X-Capture-Account`.

## People (owner only)

| Method | Path | Body and response |
|---|---|---|
| GET | `/api/people` | `200` with an array of Person objects, including the owner first and disabled helpers. |
| POST | `/api/people` | `{"name":"Volunteer"}` → `201` with the new Person. Creating a person leaves the account without an active join code. |
| PATCH | `/api/people/{id}` | `{"name":"New name"}`, `{"disabled":true}`, `{"disabled":false}`, or both fields → `200` with the updated Person. Disabling revokes all its sessions and invalidates its active code. Enabling allows the owner to issue a fresh code. |
| POST | `/api/people/{id}/code` | No body → `200 {"code":"ABCD-1234","expires_at":"2026-11-25T18:10:00.000Z","url":"https://capture.kufang.org/join#ABCD-1234"}`. Replaces any previously issued unused code for that person. Use the returned URL as the QR payload. |

A Person object has this shape.

```json
{
  "id": "01KAZS4644YQB55B1X87GHGC00",
  "name": "Volunteer",
  "is_owner": false,
  "disabled": false,
  "created_at": "2026-11-25T18:00:00.000Z",
  "last_seen_at": null,
  "last_change_at": null,
  "rooms": 0,
  "entries": 0,
  "photos": 0,
  "missing_originals": 0,
  "device_count": 0
}
```

`rooms` counts all synced collections. `entries` and `photos` count active records. `missing_originals` counts active photos without an acknowledged original whose item has at least one active entry. Each photo counts once. `device_count` counts active, unexpired sessions. `last_seen_at` records sign-in and later activity at one-minute granularity and stays visible after logout or disable. `last_change_at` is the latest persisted change timestamp where available.

Names are trimmed, 1–40 Unicode characters long and unique case-insensitively. The owner can rename any account. API errors are `404 person_not_found`, `409 name_taken`, `409 owner_protected` for setting the owner's disabled status or issuing an owner code, `409 person_disabled` for issuing a code to a disabled helper, `422 invalid_name`, and `422 invalid_request` for invalid JSON, a non-boolean `disabled` or an empty or unknown-field PATCH. There is no delete operation.

## Sync

**Schema 2 (shared items).** Records are `collection`, `item`, `entry` and `photo`. An `item` holds what is shared by every collection that has it: `title`, `notes`, `expiration_date`, `dimensions`, `review_status` and its photos. An `entry` is the item's place in one collection: `collection_id`, `item_id`, `sequence_number`, `quantity`, `unit`, `count_detail` and `deleted_at`. A photo belongs to an item (`item_id`); photo records have no `collection_id`. Data migrated from schema 1 keeps `item.id = entry.id`, and a never-shared entry created later also uses its own id as `item_id`.

**Additive fields (migration 0004, still schema 2).** A `collection` has `folder` (string, at most 200 characters, `''` = no folder). An `entry` has `entry_notes` (string, at most 20 000 characters, notes for that collection only) and `starred_at` (nullable timestamp; a star belongs to the entry, not the item). They are optional on create and default to `''`, `''` and `null`, so a client built before them keeps syncing; pulled records always include them. Clients merge them like any other field.

**Version guard.** `POST /api/sync/batch` requires `"schema": 2` in the body, and `GET /api/sync/changes` requires the query parameter `schema=2`. Without it, both answer `409 client_outdated` and write nothing. A schema-1 client keeps its outbox (items are cleared only on acknowledgment) and syncs again after it updates and migrates.

The server keeps per-record integer `revision` (that is, the client's `server_revision`), `field_revisions` (`{field: revision}`), and an account-specific, monotonically increasing change `seq` used as the pull cursor.

### `POST /api/sync/batch`

```json
{ "schema": 2, "device_id": "01J...", "mutations": [ { "id": "01J…mutation", "entity": "collection|item|entry|photo",
  "entity_id": "01J…", "collection_id": "01J…", "op": "upsert|delete|restore|purge",
  "base_revision": null, "fields": { } } ] }
```

The request body must be a JSON object and is limited to 8 MiB. Larger bodies return `413 request_too_large`. Invalid JSON or a value other than an object returns `422 invalid_request`. The client sends at most 200 mutations per batch, ordered collection, then item, then entry, then photo, and by outbox `created_at` within each entity. The server applies them in order, and each one in its own transaction.

**Client outbox rules.** A batch carries at most one mutation per record. Later changes wait until the earlier mutation has a result. The client merges local edits into a queued row up to its first send. An unsent create stays an upsert and carries the final value of `deleted_at`, so an entry or photo can be created directly in trash. On an existing record, an edit merges into the last queued delete or restore while preserving that operation. The last explicit delete or restore wins. Purges stay separate.

A sent mutation keeps its id and payload on retry, including across a temporary switch to Local Only. Sync pauses those rows until the user consents to sync again. An acknowledged create supplies the base for its follow-up edits. For updates, the client rebases fields that the acknowledgment wrote or whose server field revision is at most the follow-up's base. It sends separately any fields that must keep their older base for conflict detection.

Children wait for their parent create to be acknowledged or sent earlier in the same batch. A child with a stored missing-parent rejection waits for acknowledged parents and retries with a fresh id. If that retry still reports a missing parent, the row stays on the device with a sync error. When a field conflict rejects a combined operation, the client queues the fields that did not conflict and uses an explicit delete or restore if the user chooses their own value for `deleted_at`.

Edits to fields with an unresolved conflict wait for the user's choice. **Use server** applies the server values and removes those fields from queued edits in the same local transaction. Unrelated queued fields keep their original base revisions for conflict detection.

A device that explicitly re-enables sync after using Local Only can recover a server copy that disappeared in the meantime. When the server reports that an opted-in record is missing, the client queues a full create with a fresh mutation id and a null base revision. Recreated photo metadata clears the old upload acknowledgment and queues the original again. If a previously shared entry's sequence number is occupied on the server, the client keeps the original number and reports a sync error.

The client repairs a legacy upsert carrying a lost delete. It recovers a legacy restore when the device still intends to restore the record and either a partial edit carries that restore or the server confirms that the record was deleted at the mutation's base revision. An acknowledged legacy upsert remains acknowledged. Any lifecycle correction uses its own mutation id.

The client pushes metadata between photo originals and pulls changes regularly during the upload queue. Originals in trash follow the same upload rules. A 401 or 507 stops the current cycle. A 507 pauses uploads for five minutes across tabs and restarts. Sync Now can retry immediately. The client reports an error if neither the server nor the device has the original. Foreground cycles use a Web Lock where available and an IndexedDB lease across tabs. A tab can reclaim an expired lease and retry unfinished work. `client_outdated` stops automatic sync for the open app until Sync Now or an app reload.

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

The client merges each record unless the entity has a pending outbox item or an unresolved conflict. In that case it keeps the local values for the fields that are pending or in conflict and adopts the rest. A logged-in desktop browser therefore receives every synced collection in its account. It never sees Local Only collections.

**Local Only wins locally.** A client never overwrites or deletes local data that belongs to a Local Only collection because of a pulled change: a collection `removed`/record for a local Local Only collection, and an item or photo change (record or purge) for an item that any local Local Only entry references, are ignored.

If a pulled entry shares an item with a Local Only collection, the synced placement shows a sync error. Edits to its own server-acknowledged entry, such as quantity, continue to sync. Shared item fields, photo metadata and originals remain on the device.

A removal or purge keeps the affected records and originals on the device if it would discard an unacknowledged change, an unresolved conflict, or a locally stored original. This includes originals previously marked as backed up, even when the photo purge arrives on an earlier page than the collection removal. The client shows “Removed on the server; kept on this device.” The retained records keep their storage mode so shared placements stay consistent. Their originals still use device storage and remain available for export and explicit local clearing. Queued edits to an item or photo with a surviving synced placement move to that placement's collection, using a fresh mutation id if already sent.

### Photo bytes

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/photos/{id}/original` | Raw body; see below |
| HEAD | `/api/photos/{id}/original` | `200` with `ETag` = sha256 when stored and verified, `404` otherwise. Used to resume after the app is killed. |
| PUT | `/api/photos/{id}/thumbnail` | Optional client JPEG, PNG or WebP of at most 1 MiB. A new upload replaces the thumbnail |
| GET | `/api/photos/{id}/original`, `/thumbnail` | Session and account binding required as above. Response includes `ETag`. If a thumbnail is missing, its URL serves the stored original when available. |
| HEAD | `/api/photos/{id}/thumbnail` | Same status and headers as thumbnail GET, with an empty body. |

`PUT …/original` sends the raw body with these headers:
- `Content-Type`: the photo's mime type
- `Content-Length`
- `X-Content-SHA256`: lowercase hex
- `X-Capture-Request: 1`

The photo's metadata must already be synced: otherwise `409 photo_metadata_missing`. The header hash must equal the metadata `sha256`: otherwise `422 checksum_mismatch`.

The server streams the body to a temp file in the media volume while computing SHA-256, CRC-32 and the size. Bodies over `MAX_PHOTO_BYTES` get `413`. The server verifies all three against the metadata, fsyncs, and renames the file atomically to `media/originals/<id[0:2]>/<id>`. Original and thumbnail uploads recheck metadata under the writer lock before installing the file. If the metadata was removed while the upload streamed, the server discards the temp file and answers `409 photo_metadata_missing`.

The response is `201` (or `200` if it was already stored with the same hash), with `{ "photo_id", "sha256", "byte_size", "server_storage_key" }`. Only then does the client mark the photo `uploaded` (shown as "Backed up"). If free disk space is below `MIN_FREE_BYTES`, the server answers `507 server_storage_low` before reading the body.

## Collections (desktop export and server-copy removal)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/collections` | Server collections, each with active `entry_count`, `photo_count`, `stored_photo_bytes` and `missing_originals`. Photo figures count the active photos of items with an active entry in the collection, so a shared photo counts in each collection. |
| DELETE | `/api/collections/{id}/server-copy` | Requires the header `X-Confirm-Name` to equal the collection name (URL-encoded UTF-8). Deletes the collection and its entries, purges items no remaining entry references (with their photos and media), records the `removed` and `purged` changes, and returns `204`. Items still referenced by another collection are kept. |

## Exports (server, streamed)

`GET /api/exports/all.zip?include_trash=0|1` and `GET /api/exports/collections/{id}.zip?include_trash=0|1` stream the signed-in account's archive. The layout is exactly as in [export-format.md](export-format.md), with `source: "server"`. They use STORE mode, built from the stored crc32 and size values, with no temp file. A photo whose original was never uploaded is listed in `manifest.json` under `missing_originals` (the photo id and path) and is not included. The response carries `Content-Disposition: attachment; filename="…"`.

## Agent API

The read-only Agent API lives under `/api/agent/v1` and uses
`Authorization: Bearer <token>`. A missing or malformed server token hash disables the namespace
with `404`. A missing or invalid bearer returns `401 {"detail":"agent_auth_required"}`.
Repeated failures from one IP return `429` with `Retry-After`. Session credentials apply to the
app routes and bearer credentials apply to the Agent API. Every Agent API route accepts
`GET` and `HEAD`. Other methods return `405` with `Allow: GET, HEAD` when the namespace is
enabled. Responses use `Cache-Control: no-store`.

- `GET /api/agent/v1/users` returns `{"schema":1,"server_version": "...","users":[{"id":"owner","name":"Owner","disabled":false,"cursor":0}]}`.
  Includes every account, with `disabled: true` for disabled helpers. Their data is still readable
  with the Agent API bearer. Each user's `cursor` is the latest sequence in that account's change
  log. An unknown user ID returns `404 {"detail":"user_not_found"}`.
- `GET /api/agent/v1/users/{user_id}/changes?cursor=N&limit=500` returns
  `{"schema":1,"changes":[...],"cursor":M,"has_more":false,"latest":L,"server_time":"..."}`.
  The cursor defaults to zero and the page limit is clamped to 1–1000 change-log rows. The server
  reads one SQLite snapshot and keeps the last row per `(entity,id)` in that page, ordered by
  sequence. Change objects use the same full `record`, `purged`, or `removed` format as app sync.
  Records reflect that snapshot and a record can appear again on a later page. Advance using the
  response cursor. A cursor greater than `latest` returns `409 {"detail":"cursor_ahead"}`.
- `GET|HEAD /api/agent/v1/users/{user_id}/photos/{photo_id}/original` returns `Content-Type`,
  `Content-Length`, `ETag` with the quoted SHA-256 and `X-Content-SHA256` with the unquoted hash.
  GET returns the original bytes. A missing original returns `404 {"detail":"photo_not_stored"}`.
  Photo IDs are uppercase ULIDs.
- `GET /api/agent/v1/users/{user_id}/summary` returns counts for `collections`, `items`,
  `entries`, `deleted_entries`, `photos`, `deleted_photos`, and `missing_originals`.
  The entries and photos counts cover active rows. The missing count covers active photos with no
  recorded original upload whose item has at least one active entry. Each photo counts once.
  `missing_originals_details` lists up to 200 of those photos in ID order, each with `photo_id`,
  `item_id`, and `entries` containing the active placements' `collection_name` and `sequence_number`.
  `last_change_at` reflects the latest persisted record update or sync purge timestamp, or
  `null` when no timestamp is available. Server-copy removals recorded since migration 0005 also contribute.

## Clarifications (from the v1 server implementation)

- **Batch response.** The response is `{ "results": [...], "cursor": N }`. A `field_conflict` result also carries `conflicting_fields`, and records expose `revision` and `field_revisions`.
- **Idempotency.** It covers every outcome, including deterministic `conflict` and `rejected` results. A client that changes a rejected or conflicting operation must send it under a **new** mutation id.
- **Changes cursor.** While `has_more` is true, `cursor` is the last sequence returned on that page. On the final page, it is the latest sequence. Advance to it; no page is skipped.
- **Migration 0003 (schema 2).** Runs in one transaction. Each entry yields an item with the same id; the item copies the entry's shared fields, `revision`, and the `field_revisions` of the shared fields; the entry keeps its own revision and per-collection `field_revisions`. Photos keep their id and media, with `item_id` = their old `entry_id`.
- **Photo storage key.** After upload, photo records expose `server_storage_key` and `stored_at`. The server's internal storage path is never exposed.
- **`photo_bytes` in server exports.** It counts the metadata `byte_size` of every active photo, including those listed in `missing_originals`.
- **Trash export.** `trash/entries.csv` also lists active entries that own deleted photos, so every `trash/photos.csv` row has a valid entry reference.
- **Client IP.** Login backoff uses the **rightmost** `X-Forwarded-For` hop, which is the peer that Traefik observed. The app is reachable only through Traefik.
- **Unknown routes.** Unknown app API paths require a session. Unauthenticated callers get `401` and learn nothing about which routes exist.
