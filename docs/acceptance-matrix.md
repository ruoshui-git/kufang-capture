# Acceptance matrix

This tracks spec §9. Status words are used strictly:

- **Impl**: the code exists.
- **Auto**: automated tests cover it and pass.
- **Deployed**: it is running at https://capture.kufang.org.
- **Device**: it was verified on the owner's iPhone, with evidence.

`—` means not yet, and `n/a` means not applicable. A real-device result is recorded only from the owner's report. See [iphone-test-checklist.md](iphone-test-checklist.md).

| # | Criterion | Impl | Auto | Deployed | Device | Notes |
|---|---|---|---|---|---|---|
| 1 | Install via Add to Home Screen; launch offline | — | — | — | — | PWA manifest and service worker exist (wave 1) |
| 2 | Create `Temple 2 / A04`, 15 entries with 1–5 photos, no names | — | — | — | — | |
| 3 | Edit #3 from the list after #15; append 2 photos from the row; thumbnails, scroll and linkage | — | — | — | — | |
| 4 | In-app camera burst vs native fallback; lens, zoom and focus only if exposed | — | — | — | — | Diagnostics report gives the evidence |
| 5 | Camera works after relaunch and after an incoming call | — | — | — | — | |
| 6 | Airplane mode: 20+ photos, force-close, all data still there | — | — | — | — | |
| 7 | Local Only never uploads, offline ZIP works; Synced retries until Backed up, no duplicates | — | — | — | — | |
| 8 | Kill mid-upload and resume with nothing lost | — | — | — | — | |
| 9 | Two edits before sync: server gets the latest state, correct revisions | — | — | — | — | |
| 10 | 300+ entries: smooth scrolling and thumbnails | — | — | — | — | |
| 11 | Incomplete/unsynced counts, per-unit quantities; delete and undo of photo and entry; numbers never reused | partial | partial | — | — | Data layer done and tested (wave 1) |
| 12 | Export: CSV foreign keys, image counts, ordering, hashes, late photos on the correct entry | partial | partial | — | — | Exporter and verifier done and tested (wave 1) |
| 13 | Consistent SQLite + media backup, restore, off-VPS copy | n/a | n/a | n/a | n/a | **Waived by owner on 2026-11-08** (helper tool, no backups). A pre-deploy SQLite snapshot exists for rollback only. |
| 14 | No ERPNext service, route, volume or DB affected | — | — | — | n/a | `scripts/prod-guard` before and after every deploy |
| 15 | Desktop export of a synced collection; Local Only data not visible there | — | — | — | n/a | |
| 16 | Archive/export one room, start another; clear is guarded against unexported or pending data | partial | partial | — | — | Clear guard in the data layer (wave 1) |
| 17 | First HTTPS milestone announced without pausing, then work continues | — | n/a | — | n/a | |
