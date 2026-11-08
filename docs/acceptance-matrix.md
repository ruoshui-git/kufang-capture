# Acceptance matrix

This tracks spec §9. Status words are used strictly:

- **Impl**: the code exists.
- **Auto**: automated tests cover it and pass, in CI on every push (Vitest; Playwright on the real stack in iPhone-sized Chromium, desktop Chromium and WebKit).
- **Deployed**: it is running at https://capture.kufang.org and was checked there.
- **Device**: it was verified on the owner's iPhone, with evidence.

"Pending" under Device means the step is in [iphone-test-checklist.md](iphone-test-checklist.md) and no real-device result exists yet. **Emulation is not a real iPhone.** Nothing here claims real-device success.

| # | Criterion | Impl | Auto | Deployed | Device | Evidence and notes |
|---|---|---|---|---|---|---|
| 1 | Add to Home Screen; launch offline | ✅ | ✅ | ✅ | pending | e2e `§9 #1`: service worker reload offline, plus a persistent-profile restart (Chromium and WebKit). Production smoke: offline reload. |
| 2 | `Temple 2 / A04`, 15 entries × 1–5 photos, no names | ✅ | ✅ | ✅ | pending | e2e `§9 #2/#3` (Chromium and WebKit) |
| 3 | Edit #3 from the list after #15; 2 photos from its row; thumbnails, scroll and linkage | ✅ | ✅ | ✅ | pending | Same test: no navigation, scroll held within ±40px, IndexedDB linkage |
| 4 | Camera burst vs native fallback; lens, zoom and focus only if exposed | ✅ | partial | ✅ | pending | e2e `§9 #4`: 5 rapid fake-camera captures stored as `camera_frame`; controls render only from reported capabilities (unit tests). Real lens, zoom, focus, quality and tap counts need the iPhone and Diagnostics → Copy report. |
| 5 | Camera after relaunch and an incoming call | ✅ | partial | ✅ | pending | Tracks stop when the page is hidden and resume via "Tap to resume" (unit tests). An iOS call interruption can only be tested on the device. |
| 6 | Airplane mode: 20+ photos, force-close, all present | ✅ | ✅ | ✅ | pending | e2e `§9 #6`: offline, 3 entries / 20+ photos, persistent restart, byte hash match (Chromium and WebKit) |
| 7 | Local Only never uploads, offline ZIP works; Synced retries to Backed up without duplicates | ✅ | ✅ | ✅ | pending | e2e `§9 #7` request audit (no local ids in any `/api` request); sync e2e (6 originals hash-verified, no duplicates on repeated Sync Now). Production: synced round trip with ETag = original SHA-256. |
| 8 | Kill mid-upload, resume, nothing lost | ✅ | ✅ | ✅ | pending | e2e: context closed mid-PUT, reopened, HEAD-based resume, single stored original with matching hash (Chromium and WebKit). Unit: stale `uploading` reset. |
| 9 | Two edits before sync: latest state only, correct revision | ✅ | ✅ | ✅ | — | e2e: two offline edits arrive as one server revision with the final values; unit test on the fake server |
| 10 | 300+ entries scroll smoothly | ✅ | ✅ | ✅ | pending | e2e `§9 #10` with the Diagnostics generator (300 entries): max long task 52 ms, max frame interval 19.5 ms (desktop Chromium). Needs an iPhone check. |
| 11 | Incomplete/unsynced counts, per-unit totals; delete and undo; numbers never reused | ✅ | ✅ | ✅ | pending | e2e `§9 #11`; unit tests for decimal per-unit sums and sequence allocation |
| 12 | Export: CSV foreign keys, counts, ordering, hashes, late photos on the right entry | ✅ | ✅ | ✅ | pending | e2e `§9 #12` runs `tools/verify-export.py` and compares original hashes. Production: exported ZIP verified, photo bytes identical. |
| 13 | SQLite + media backup, restore, off-VPS copy | n/a | n/a | n/a | n/a | **Waived by the owner, 2026-11-08** (helper tool). A pre-deploy SQLite snapshot exists for rollback only. |
| 14 | No ERPNext service, route, volume or DB affected | ✅ | ✅ | ✅ | n/a | `scripts/prod-guard` showed identical container IDs, start times and restart counts, plus a healthy `kufang.org` ping, around every manual deploy and after CI deploys. Separate project, network attachment only, no published ports. |
| 15 | Desktop export of a synced collection; Local Only not visible | ✅ | ✅ | ✅ | n/a | e2e desktop: `/server` lists only server collections; ZIP verified |
| 16 | Archive/export, new room, clear guarded | ✅ | ✅ | ✅ | pending | e2e `§9 #16`: clear blocked before export, exact-name confirmation, other collection unaffected |
| 17 | First HTTPS milestone announced; work continued | ✅ | n/a | ✅ | n/a | Phase 1 announced 2026-11-08 (push notification and chat); Phases 2–3 continued without pausing |

## Known limitations (honest list)

- **Camera hardware:** lens, zoom, torch and focus controls appear only if iOS WebKit reports them. Which ones it reports is unknown until Diagnostics runs on the iPhone. Fast-camera photos are video frames, not native stills. The System camera route stores the exact file iOS returns.
- **No Background Sync:** uploads run while the app is open: at startup, on reconnect, when the app becomes visible, every 30 seconds, or on Sync Now.
- **Local Only data lives only on the device.** iOS may evict website storage under pressure. Export ZIPs to Files regularly; Settings reminds you.
- **Private browsing:** where the browser cannot store Blobs in IndexedDB (Safari Private Browsing), photos are stored as raw bytes instead. Same data, more memory used during capture.
- **No server backups,** by owner decision.
