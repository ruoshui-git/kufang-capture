# Kufang Capture — Product and Architecture Specification

Status: Implementation-ready design, not yet implemented or deployed  
Target: A single-operator, English-language, mobile-first inventory collection PWA  
Preferred URL: `https://capture.kufang.org` (the product name and domain must match)  
Primary device: iPhone 15 Pro Max, installed to the iOS Home Screen  
Potential hosting: Existing production VPS, in an **isolated** Docker Compose project  
Development: WSL2 Linux filesystem; native development commands; Docker for deployment  

## 1. Product goal

Build an extremely fast field-capture application for physical inventory counts across approximately 10–20 storage rooms. This is **not** a replacement for ERPNext's entire stock-management workflow. It is a purpose-built, durable collection and review tool that can later export evidence and observations for AI processing and import into ERPNext or another destination.

**Core principle:** Capture first; organize later. Never wait for a server round trip to create or edit a record.

The user must be able to:

- Create a **Collection** representing a room or an independently named counting session.
- Add an **Entry** with zero or more photos, quantity, unit, and optional notes, in any order.
- Take several pictures in a row while remaining on the same entry.
- Navigate instantly to earlier entries; add or reorder photos; revise quantities and notes.
- Work primarily within an **inline-editable Entry List**: recent photo previews, add-photo actions, editable title, quantity, unit, and notes, without navigating into Detail.
- Give each entry a stable sequential number within its collection and an optional custom title.
- Delete accidental photos and entries with a recoverable undo/trash workflow.
- Browse a compact list with recent thumbnails and field previews; search and filter locally.
- Continue working during intermittent or absent internet connectivity.
- Choose **Local Only** or **Sync to Server** per collection; every edit is saved locally immediately, with nonblocking synchronization only where explicitly enabled.
- Download complete raw data **and original captured photo files**, with stable links between entries and photo files.
- See useful counts without incorrectly combining different units.

The application interface, field labels, errors, help, and developer documentation should be **English**. User-entered notes and later AI results can contain Chinese or other languages.

## 2. Information model

### Collection

Represents a counting area/session, not necessarily a formal ERPNext warehouse.

Fields:

- `id`: stable client-generated UUID/ULID
- `name`: required, e.g. `Temple 2 / A04`
- `description`: optional
- `status`: `active` or `archived`
- `created_at`, `updated_at`
- `sort_order`: optional
- `storage_mode`: `local_only` or `synced`, with an explicit opt-in before uploading any pre-existing local data
- `next_sequence_number`: monotonically increasing allocation counter; deleted numbers are never reused

Collections may be freely renamed and revisited. Archiving never deletes their entries. Allow a user to archive/export one room and then start another without losing previous history accidentally. The app does **not** infer that the same item captured in two collections is a distinct product.

### Entry

Represents an observation at physical-count time. It is **not** yet an ERPNext Item or SKU.

- `id`: stable client-generated UUID/ULID
- `collection_id`: required
- `sequence_number`: immutable, monotonic within the collection, e.g. `#0042` (not a primary key; don't renumber after deletion)
- `title`: optional user-defined label; default display is `Entry #0042`, not a forced name
- `quantity`: nullable decimal; do not require a value to start an entry
- `unit`: short, editable text; remember last-used value (`pieces`, `boxes`, `packs`, etc.)
- `count_detail`: optional free text for e.g. `3 boxes, 24 packs each, plus 2 loose packs`
- `notes`: optional multiline text, supports voice dictation via the iOS keyboard
- `expiration_date`: optional structured date; absence means unknown/unrecorded, **not** "no expiration"
- `dimensions`: optional free text initially; no mandatory dimensions workflow
- `review_status`: `draft`, `complete`, or `needs_review`
- `created_at`, `updated_at`; client modification revision
- `deleted_at`: soft delete / undo and Recently Deleted, including restore

No forced Item Group, manufacturer, model, barcode, price, cost, valuation, or ERPNext code at capture time. Those belong to later enrichment or import.

### Photo

Each Entry has a one-to-many relationship with photos.

- `id`: stable client-generated UUID/ULID
- `entry_id`, `sort_order`
- `original_filename`, `mime_type`, `byte_size`, `width`, `height`
- `sha256`: calculated for corruption detection / optional deduplication
- `captured_at`, `created_at`
- `original_blob`: locally queued before upload; original server file stored separately from metadata
- `thumbnail_blob`: derived locally/server-side without modifying the original
- `server_storage_key`, `sync_state`
- `caption`: optional
- `is_cover`: one cover image per entry; default to first photo
- `deleted_at`: recoverable soft delete until the trash retention or a confirmed purge

Deleting one photo should offer undo and not silently delete other photos or the entry. The list preview shows the last 2–3 photos **by capture time**, even if a separate cover photo is selected. Files should not be public or guessable from their URL.

## 3. UX and navigation

### Screen A: Collections

- Title: `Collections`
- Compact cards: collection name, entry count, photo count, incomplete entry count, last updated
- Prominent `New Collection` action, with a clear `Local Only` / `Sync to Server` choice (default to the user's last choice)
- Tap anywhere on a card to open; allow edit/archive from overflow menu
- Overall summary: collections and entries, not an invented global quantity
- Archived collections remain accessible and exportable; collection deletion or clearing is a separate guarded operation

### Screen B: Collection entry list — **primary working screen**

- Header: collection name and counts (`Entries`, `Photos`, `Needs Review`)
- Fixed, thumb-reachable `+ New Entry` action
- **Every row/card must be useful without opening Detail:** immutable `Entry #0001`, optional inline-editable custom title, inline-editable numeric quantity and unit, inline-editable short note, and an optional expandable text area for longer notes/count details
- Show the **2–3 most recently captured photos** as small tappable thumbnails (plus `+N` for the remainder), not just an old cover image. Tapping a thumbnail opens a full-screen viewer without requiring a visit to Detail.
- Each row contains a prominent **Add Photo** camera action that appends to **that specific row**; optional Add from Photos and an overflow menu for actions including Delete
- Allow changing the title/quantity/notes and adding photos in arbitrary order and on arbitrary older entries; do not make the user advance through a mandatory capture wizard
- Create a new entry directly from the list, assign the next number, and keep it in a usable inline-editing state; entering the Detail screen is never mandatory for ordinary counting
- Show photo count, last-modified time if helpful, and clear local/sync state, without overcrowding the row
- Newest-first by default; allow oldest-first; preserve scroll position when returning from detail
- Search across sequence number, title/notes/count detail; filter `All`, `Incomplete`, `Pending Sync`, `Recently Deleted` as applicable
- Tap a deliberate `Details` affordance or noninteractive portion of row to open Detail; tapping inputs, photos, or Add Photo must **never** navigate unexpectedly
- Provide a clear delete action, confirmation appropriate to risk, immediate Undo toast, and restore from Recently Deleted
- Large list remains smooth through virtualization / incremental rendering
- Maintain scroll position and keyboard focus during autosave, photo return, and background synchronization

### Screen C: Entry detail / capture

- Create entry immediately and **commit it locally** before opening a camera
- Large `Add Photo` / camera action, with thumbnail strip or 2–3 column gallery
- User can take multiple photos without finishing the entry
- Thumbnail tap opens full-screen zoom; allow reorder, cover selection, caption, delete with undo
- Quantity and Unit inline and easy to change; free-form count details below
- Notes inline, no separate modal; optional expiration and dimensions behind `More details`
- No manual `Save` required; clearly distinguish `Saved on this device`, `Syncing`, `Backed up`, and `Sync error`
- Primary navigation: `Back to List`, `Previous`, `Next`, `+ New Entry`
- Creation should not require photos or quantity. Flag incomplete entries in the list instead of blocking work.
- Detail is primarily for the complete photo gallery and advanced fields; all routine actions also work in the list

### Delete, archive, and clear

- Deleting an entry or photo is a soft delete with an immediate Undo action and a **Recently Deleted** recovery view. Hide deleted entries from active counts; restoring brings back their original sequence numbers and linked images.
- Do not reuse sequence numbers or silently renumber other entries after deletion.
- Make collection archiving easy. Clearing/irreversibly deleting a completed collection must require a **verified, user-accessible export or backup**, explicit confirmation of the target collection, and a clear warning about unsynced photos.
- Do not equate successful server sync with proof of a separate off-VPS backup. Provide a conservative default: archive rather than purge.

### Camera interaction — must be tested on the user's actual iPhone

**Fast mode (preferred if quality is adequate):** Use a persistent in-app camera preview via `getUserMedia` while the entry remains open. Tap the shutter repeatedly, each capture instantly appending a thumbnail. No share sheet, no switch to Photos, no new page per capture. This mode may be limited to video-stream frame resolution and iOS PWA camera quirks; do not promise original iPhone Camera app resolution.

**Lens, zoom, and focus controls:** Enumerate and present available camera devices only when the browser actually exposes them. Use `getCapabilities()` / `applyConstraints()` to offer hardware zoom, focus distance, torch, or other controls **only when supported by the current iPhone/iOS WebKit implementation**. Provide intuitive zoom gestures where feasible; label software/digital crop separately from optical zoom. Do **not** promise direct access to all three physical rear lenses, native tap-to-focus, full photographic zoom, or the same quality as the iPhone Camera app from an ordinary PWA.

**High-quality native fallback:** An `input type="file" accept="image/*" capture="environment"` action launches native capture; receive the returned file bytes without resizing/re-encoding and append to the same entry. Also allow `Add from Photos` for later additions. iOS may reopen its camera UI for each picture; compare real interaction cost.

The developer must prototype both capture routes **before** committing to the camera architecture. Measure: taps between two photos of the same entry; returned pixel dimensions; sharpness of labels; permission behavior; installed-PWA reliability; ability to resume after interruption.

If browser limitations prevent reliable quality or lens controls, select the best working PWA fallback and **report the exact missing features**. A truly native AVFoundation camera interface would require a separate iOS app/native integration and a macOS/Xcode build workflow; it is **not** silently in scope for this WSL2-based PWA.

"Original" means the exact unmodified bytes received from the selected capture route. Never overwrite or replace these with thumbnails, AI-edited images, or background-removed versions. If Fast mode captures a JPEG from a video frame, be explicit that its source is a camera frame, not a full-resolution native iPhone still image.

## 4. Summary semantics

- `Entries`: number of capture rows, not necessarily number of distinct products/SKUs
- `Photos`: total linked photos
- `Incomplete`: entries missing photos or count, or explicitly flagged
- `Quantity`: display per entry and optional subtotals **by unit**
- Never add `5 boxes + 12 pieces` into a misleading single quantity of `17`
- Deduplicating the same product across rooms is a later processing step

## 5. Offline-first architecture

### Frontend

- Svelte + Vite + TypeScript, as a static SPA (no Node server needed in production)
- Tailwind CSS or equivalent small design system
- PWA manifest and service worker caching the application shell for offline launch
- IndexedDB (e.g. Dexie) stores Collections, Entries, Photos/Blobs, a durable mutation outbox, and sync state
- All list/detail reads come from local storage; server state syncs into it **only for sync-enabled collections**
- Every local change uses a durable IndexedDB transaction before a `Saved on this device` indicator
- Text edits debounce locally by about 200–400 ms; photo capture persists its Blob before reporting success
- Client generates IDs before any network access; uploads and writes are idempotent

### Synchronization

- **Local Only is a first-class privacy/storage mode, not merely a lost network connection.** In this mode no collection data or original images are transmitted to the server. Export to the iPhone Files app/share destination is the primary backup mechanism.
- **Sync to Server is an explicit opt-in**, per collection, permitting authenticated backup and subsequent export from a computer; for a temporarily offline synced collection, queue changes and upload only when possible.
- Changing an existing Local Only collection to Synced must ask consent before sending its older photos. Changing Synced to Local Only stops future uploads but **does not automatically erase previously uploaded server copies**; offer a separately confirmed removal workflow if needed.
- Never block `New Entry`, photo capture, navigation, or editing on a server response
- Queue mutations and photo uploads; retry on transient failure with backoff
- Process in foreground while the app is open, on startup, when connectivity returns, and when it becomes visible again
- **Do not depend on Background Sync on iOS**. A closed/suspended PWA may not upload until reopened.
- Keep clear states (`Local Only`, `Saved Locally`, `8 Photos Pending · 24 MB`, `Backed Up`, `Sync Error`) plus a manual `Sync Now` button when relevant
- Require server acknowledgment and stored-file integrity checks before marking media `Backed up`
- Keep local unsynced data until acknowledged; never clear the outbox merely after a request is sent
- Allow corrections to earlier records without duplicating them on the server
- Detect rare conflicting edits from two devices using revisions; present a conflict instead of silently losing one
- Show local storage usage/quota and warn if offline media accumulates or storage is nearly full
- Provide a recoverable local export for unsynced data (at least one collection per ZIP) as a contingency

**Important:** iOS IndexedDB is quota-limited and can be evicted under storage pressure. Local Only is not equivalent to durable backup; strongly prompt periodic export to Files or external storage. Test actual airplane-mode capture and re-sync on the installed PWA.

## 6. Backend and deployment

Recommended production components:

| Component | Choice | Notes |
| --- | --- | --- |
| Frontend | Static Svelte/Vite build | Tiny static container served through existing Traefik |
| API | FastAPI + Python | REST/JSON for data, multipart upload/streaming for original photos |
| Database | **SQLite (WAL mode)** | Metadata, revisions, collections, entries, photo references; sufficient for a single user and this workload |
| Binary storage | Dedicated persistent server directory/volume | Original photo bytes + separately generated thumbnails; do not put photos in SQL columns |
| Proxy/TLS | Existing Traefik | Same-origin `https://capture.kufang.org`, `/api` and app under one origin |
| Deployment | Separate Docker Compose project | No dependency on Frappe, Redis, ERPNext, MariaDB, or Node at runtime |

Do **not** introduce PostgreSQL by default. SQLite with WAL, a single API service/worker configuration, and a carefully managed persistent database file is enough. Use proper transactions, foreign keys, write serialization/retries where appropriate, and SQLite's supported online backup/snapshot procedure. The original photo library lives in a separate persistent filesystem volume. Do not simply copy a live SQLite database file without considering WAL consistency. The static frontend should be served without a production Node server.

Potential REST endpoints (agent may refine):

- `GET/POST /api/collections`; `PATCH /api/collections/{id}`
- `GET/POST /api/entries`; `PATCH /api/entries/{id}`; soft-delete/restore
- `POST /api/entries/{id}/photos` with client photo ID and content checksum
- `PATCH /api/photos/{id}` for order, caption and cover
- `GET /api/sync` for revision/cursor-based incremental pulls
- `POST /api/sync/batch` for idempotent mutations with acknowledged revisions
- `GET /api/exports` or `POST /api/exports` for full/per-collection export jobs

Operations must be authorized server-side. Use HTTPS, secure HTTP-only session cookies, password hashing, CSRF protections as appropriate, photo access control, upload validation and bounded file sizes. Initial single-user auth is enough. Avoid complicated roles and public signup.

For the existing VPS: first inspect available RAM, free disk, current production services, Traefik routing, certificate issuance, and backup coverage. Estimate media space (e.g. 1,000 entries × 2 images × 3 MB ≈ 6 GB **before backups**). Use explicit new volumes and an isolated Compose project. Do not modify, replace, or stop current ERPNext production services without an explicit migration/deployment decision.

Production must support nightly consistent database + media backups to a destination **outside the same VPS disk**, and a tested restore procedure. Backups should be versioned and encrypted where appropriate. Also support an on-demand, user-controlled ZIP download from a desktop computer for synced collections; this does not eliminate the need for off-server backups.

### Development and infrastructure bootstrap

- **Work in WSL2** on its native Linux/ext4 filesystem, e.g. `/home/<wsl-user>/code/kufang-capture`, **not** in `/mnt/c` or the existing Frappe dev container. Use VS Code's Remote-WSL integration if editing from Windows.
- Develop with `pnpm` (Vite/Svelte) and a local Python environment (`uv` or `venv`, `uvicorn --reload`). Run SQLite locally. **Do not require Docker for each source edit or live reload.** Docker Compose belongs to production and optionally a pre-deployment smoke test.
- At startup, inspect the existing `temple_inventory` project **read-only** for relevant deployment notes, `AGENTS.md`, SSH host aliases, established Traefik network conventions, Spaceship CLI configuration, and approved secret references. Reuse the operator's existing credentials **only via normal configured tools and files**. Never print, copy into this repo, embed in prompts, log, commit, or export API keys or private SSH keys.
- Inspect current DNS records, production Compose stacks, host resource use, TLS, and backups before writing. Add the **web subdomain record** needed for `capture.kufang.org` (usually `A`, `AAAA`, or `CNAME`) using the already configured Spaceship API/CLI if available. **Do not modify MX records, SPF/DKIM, or unrelated DNS records** for a web-only subdomain.
- Route this app via the existing Traefik using a separate Compose project, distinct service names, images, env file, volumes, backups, and rollback plan. Preserve all ERPNext/Frappe routes, certificates, networking, volumes, and database state. Avoid rebuilding or restarting that stack.
- The iPhone camera/PWA needs a secure HTTPS origin, so make the domain reachable early for real-device testing. If access, DNS permissions, or SSH authorization is missing, stop at that blocker and ask the user; do not circumvent access restrictions.

## 7. Export contract

The app must export either all collections or a selected collection, independent of any specific inventory system.

Preferred export: a ZIP with at least:

```text
capture-export/
  manifest.json
  collections.csv
  entries.csv
  photos.csv
  photos/
    <entry-id>/
      <photo-id>.<original-extension>
      ...
```

- Stable UUIDs join Collections → Entries → Photos
- `photos.csv` includes `photo_id`, `entry_id`, relative path, original filename, media type, byte size, hash, order, caption, cover flag
- Original photos are exported without recompression; thumbnails may be an optional separate directory
- Include original sequence numbers, optional custom titles, and the collection's storage mode in metadata; retain photo associations even for entries modified long after initial capture
- Preserve raw quantity + unit + count details; no guessed arithmetic or altered expiration dates
- `manifest.json` includes format version, export time, selected collections, record/photo counts, and hashes
- Provide CSV and JSON forms of structured data where practical; do not require any proprietary reader
- Verify one full ZIP round-trip and compare original-file hashes before counting the app ready
- Local Only collections must export directly from local IndexedDB/Blobs without contacting the server; synced collections may additionally export from desktop through the authenticated web app
- Export the collection's active entries by default, and optionally include a separately labeled trash manifest for recoverable/deleted material
- Future ERPNext exports are optional **adapters**: separate Item Catalog and Opening Stock templates, reviewed by Manager/Admin before import; no automatic stock writes in v1

## 8. v1 scope and explicit exclusions

**Must ship:** collection CRUD; immutable per-collection entry numbers; optional custom names; **inline editable Entry List** with quantity, notes, latest three photo thumbnails, and Add Photo per row; recoverable entry/photo deletion; multiple original photos; fast camera interaction and honest hardware-controls fallback; photo viewer; auto-save; offline shell/local persistence; Local Only / Sync to Server choice; reliable foreground sync/status for synced collections; local and desktop ZIP+CSV+media export; auth; off-VPS backups for server data; installed iOS PWA test.

**Can follow after field testing:** voice transcription beyond iOS keyboard dictation; structured dimension/expiry prompts; barcode detection; OCR; AI item naming; duplicate detection; batch operations; visual search; item catalog; stock movements; multi-user role management; direct ERPNext API integration.

Do **not** implement a full warehouse ERP, stock ledger, purchasing, cost accounting, or shipment flow. Do not silently equate an Entry with an ERPNext Item.

## 9. Acceptance tests on a real iPhone

1. Install via Safari Add to Home Screen; launch successfully with the network off after initial installation.
2. Create `Temple 2 / A04`, then 15 entries with 1–5 photos each, without entering names.
3. From the **list without entering Detail**, modify quantity, unit, notes, and optional title on entry #3 after reaching #15, append two photos with its row's Add Photo button, and verify recent thumbnails, stable scroll, and correct linkage.
4. Use the in-app camera for multiple back-to-back photos; record taps and time; compare fast mode vs native fallback, inspect label sharpness, and test any exposed lens selection, zoom, and focus controls. Document unavailable capabilities rather than hiding them.
5. Confirm camera permissions and capture work after closing/relaunching the installed PWA and after an incoming call.
6. In airplane mode, create/modify entries and capture at least 20 photos; force-close/reopen and confirm every entry and photo remains locally available.
7. Create a Local Only collection; verify that no photo or metadata ever uploads, and that full local ZIP export works while offline. Create a distinct Synced collection; restore connectivity and verify uploads retry until `Backed Up`, without duplicates.
8. Kill the app mid-upload and resume; no photo or field changes disappear.
9. Edit the same record twice before sync; the server receives only the latest intended state, with correct revision handling.
10. Test with 300+ entries in one collection; list scrolling and thumbnail rendering remain smooth.
11. Show explicit incomplete and unsynced counts and an accurate per-unit quantity breakdown. Delete an accidental photo and entry, undo and restore both, and ensure the next entry number is never reused.
12. Export a collection and all data. Confirm CSV foreign keys, image counts, ordering, bytes/hashes, and that later-added photos appear on the correct entry.
13. Verify **consistent SQLite + photo backup and full restoration**, not merely SQL metadata; confirm off-VPS backup exists.
14. Confirm no production ERPNext service, route, volume, or database is affected by build/deploy.
15. From a desktop computer, export a synced collection, including original photos; confirm Local Only data is not visible there until manually exported or expressly opted into sync.
16. After archiving/exporting one room, create another; attempt to clear the old one and verify the app safeguards against unbacked-up or pending photos.
17. Verify Claude announces the first live HTTPS milestone **without pausing implementation**, and continues through the acceptance matrix, except for genuine permission or safety blockers.

## 10. Required execution sequence and progress reporting

**Phase 0 — WSL2 bootstrap, read-only infrastructure audit, camera and storage spike**

- Create the independent WSL2 repository and native dev environment; read existing `temple_inventory` documentation/config only as needed to discover operational context, without modifying that repository
- Read-only check of DNS, VPS, free disk, proxy routing, backups, and usable configured SSH and Spaceship access; plan isolated deployment and a rollback
- Minimal Svelte capture screen on actual iPhone using an HTTPS test origin, installed as PWA
- Prototype `getUserMedia` continuous camera vs native file-capture input
- Save multiple images/notes in IndexedDB, quit/reopen, test offline and photo quality
- Decide camera design from observed results, not API assumptions; where user testing is needed, report it and continue with the best available implementation

**Phase 1 — Reachable HTTPS milestone and minimal usable capture PWA**

- Add DNS and standalone Traefik/Compose routing to make **`https://capture.kufang.org` accessible**, without modifying existing ERPNext services
- Deploy a minimal functional PWA with Collections, **inline Entry List**, numbered entries, photos, quantity/notes/title edits, auto-save, deletion with Undo, and local persistence
- Provide an initial local ZIP export, at least basic offline install support, and a working camera method with fallback
- **Immediately send the user a milestone message when the URL is really reachable**, including what is implemented and what remains. **Do not stop, wait for approval, or end the agent's task at this milestone. Continue implementing the following phases autonomously.**

**Phase 2 — Lightweight backend, optional sync, and export**

- FastAPI + **SQLite WAL** + original media directory; idempotent API, authentication, uploads, revisions, and recoverable trash
- User-selectable **Local Only / Sync to Server** per collection, explicit opt-in, reliable foreground synchronization and status
- Full desktop and phone export; safe collection archiving/clearing; off-VPS backups with verified restore
- Test offline/online switching and isolation between local-only and synced records

**Phase 3 — Production polish, camera validation, and acceptance**

- Performance, camera reliability and available zoom/lens/focus controls, keyboard ergonomics, thumbnail behavior, error recovery, and security; verify on a real iPhone when accessible
- Run meaningful automated tests and server smoke checks; provide manual iPhone test checklist for anything the agent cannot physically validate
- Apply final deployment updates; report passing/failing acceptance criteria, residual limitations, and recovery instructions
- Optional structured expiry/dimensions can be added if inexpensive; AI enrichment is a future feature, not a blocker for release

**Continuous execution rule:** Phases are delivery milestones, not automatic stop points. Do not request confirmation after routine progress messages. Stop and ask only for missing authorization, blocked credentials, high-risk destructive changes, or user-dependent real-device observations that cannot be safely simulated. Do not claim a real-device test occurred if it did not.

## 11. Agent implementation brief

> Build **Kufang Capture** as an independent, English-only, offline-first iPhone PWA according to this specification. Develop **natively in WSL2**, outside the existing Frappe container, and use Docker Compose for isolated VPS deployment. Discover deployment context and already configured credentials from `temple_inventory` without leaking or copying secrets. Preserve all existing production services; create only the necessary `capture.kufang.org` web DNS record and **do not change unrelated MX/email records**. The main work surface is an **inline-editable Entry List**, with stable natural numbers, optional titles, recent photos, add-photo per row, quantities, notes, soft delete/restore, and no required visit to Detail. Every change saves first to local IndexedDB; each collection may be **Local Only** or explicitly **Synced**. Use static Svelte/Vite, FastAPI, **SQLite WAL**, and persistent original media. Implement a high-efficiency camera and a native-capture fallback, with honest iPhone WebKit lens/zoom/focus limitations. Export portable ZIP+CSV+JSON and original photo bytes. Make `https://capture.kufang.org` usable as an **early Phase 1 milestone; notify the user immediately upon confirming that it works, then CONTINUE automatically through all remaining implementation, test, deployment, and backup phases without waiting for another prompt**. Pause only for genuine permission, irreversible-risk, or unavailable real-device validation blockers. Provide concise progress updates, evidence-based acceptance tests, and limitations; do not pretend desktop emulation is an iPhone field test.

