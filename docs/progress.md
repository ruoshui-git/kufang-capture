# Progress

Status words follow [acceptance-matrix.md](acceptance-matrix.md). Real-iPhone results are recorded only from the owner.

## 2026-11-09: shared items across collections

- **Feature:** "Import from another collection" links an entry into a second collection of the same storage mode. Photos, title, notes, expiration, dimensions and review status are shared; quantity, unit, count detail, number and deletion stay per collection. Contracts: `types.ts` (`Item`), `docs/api.md` schema 2, `docs/export-format.md` version 2.
- **Upgrade safety:** Dexie v4 and SQLite `0003_items.sql` keep every id (item id = entry id) and photo path, and rewrite pending outbox changes. The server migration was rehearsed on a copy of the production database: all rows matched, foreign keys clean. Older app versions get `409 client_outdated` and keep their outbox (tested against the deployed engine, `aaf5608`).
- **Bug fixed on the way:** a pulled `removed`/`purged` change could delete local data of a collection that had since been switched to Local Only.
- **Tests:** 101 frontend (Vitest), 24 backend (pytest), 10 verifier, end-to-end 35 passed / 7 project-specific skips.
- **Needs the owner's iPhone:** checklist section G (upgrade with existing data, offline import, shared edits).

## 2026-11-08: all three phases implemented, deployed and verified (except on a real device)

**Live:** https://capture.kufang.org. Every push to `main` runs unit, backend, design-lint, gitleaks and end-to-end tests (Chromium and WebKit) before deploying.

### Phase 0: bootstrap, audit, spike
- **Repository:** public repo `ruoshui-git/kufang-capture`, built with a native WSL toolchain (Node 26, pnpm 12, uv). Agent guides, Codex wave scripts, and guards for clean-export checks, clean-export image builds and the ERPNext before/after check.
- **Infrastructure:** read-only audit in [infrastructure-audit.md](infrastructure-audit.md). The only DNS change was the record `capture A 40.160.103.88`.
- **Host:** the `kufang-capture` user and `/srv/kufang-capture`, secrets kept only on the VPS (0600), a forced-command CI key, and the GitHub `production` environment.

### Phase 1: reachable HTTPS milestone
Announced. Collections, the inline Entry List, Detail and viewer, system and fast camera, autosave, delete/Undo, offline shell and device ZIP export.

### Phase 2: backend, sync, export
- **Server:** single-password auth (argon2id, `__Host-` session cookie, CSRF checks, login backoff, deny-by-default API). Idempotent batch sync with field-level conflicts and `sequence_taken`. Hash-verified streamed photo storage with a low-disk guard. Streamed STORE/ZIP64 server exports.
- **Sync engine:** foreground only (start, reconnect, visibility, interval, Sync Now). Outbox items drain only on acknowledgement. HEAD-based upload resume, a conflict store, and Local Only excluded at the request builder.
- **UI:** sign-in, status in words, consent before uploading an existing Local Only collection, server-copy removal, guarded clear, and a desktop `/server` export page.
- **Verified in production:** a synced round trip in which the server's stored original matches the device original's SHA-256 and the status reaches "Backed up".

### Phase 3: hardening, tests, polish
- **End-to-end suite:** iPhone-sized Chromium with a fake camera, desktop Chromium, and WebKit. Chromium: 27 passed. WebKit: 10 passed. Not-applicable cases are skipped.
- **Unit tests:** 80 frontend (Vitest) and 18 backend (pytest).
- **Design system:** [design-system.md](design-system.md), with tokens in `src/styles/tokens.css`, enforced by `pnpm lint:design` in CI. Raw component colours went from 48 to 0.
- **Performance:** with 300 entries, the longest task was 52 ms and the longest frame interval 19.5 ms (desktop Chromium).

## Bugs found by review and testing (all fixed, with regression tests)

| Area | Bug | Fix |
|---|---|---|
| Capture | Rapid shutter presses could get duplicate photo order or two covers (read outside the transaction) | Read inside the write transaction |
| Capture | The iOS picker resolved empty 700 ms after focus returned, which could drop a slow camera result | Timer removed |
| Inline edit | After New Entry, a delayed focus on the title could steal Quantity typing (quantity lost) | Focus moves only if it has not moved since the tap; dirty fields are protected; saves are serialized |
| Storage | Photos failed where IndexedDB cannot hold Blobs (Safari Private Browsing, WebKit ephemeral profiles) | Tagged raw-byte fallback with identical bytes |
| Sync | After reconnecting, uploads waited out their retry backoff (minutes) | Reconnect and Sync Now retry immediately |
| Sync | A wrong password showed "session ended" | Precise sign-in messages |
| Thumbnails | A new photo showed a placeholder until reload | Local-original stand-in, then swap to the thumbnail |
| Deploy | The health check accepted `unhealthy`; snapshot containers could receive Traefik traffic | Exact health check; snapshot containers excluded from Traefik |
| Ops | The restore recipe could replay a stale SQLite WAL | WAL/SHM files set aside first |
| Server | `HEAD /` returned 405; the API allow-list could skip auth for new routes | HEAD supported; deny-by-default auth |
| Build | tsconfig `include` was mangled, so some `.ts` files were never type-checked | Restored, and latent errors fixed |

## Needs the owner's iPhone

Follow [iphone-test-checklist.md](iphone-test-checklist.md):
- installed-PWA offline launch
- camera comparison and the Diagnostics report (which lens, zoom, focus and torch controls iOS actually exposes)
- interruption by a call
- airplane-mode durability
- 300-entry smoothness on the device
- real sync after killing the app mid-upload
