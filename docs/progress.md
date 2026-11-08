# Progress

Status words follow [acceptance-matrix.md](acceptance-matrix.md). Real-iPhone results are recorded only from the owner.

## 2026-11-08: Phase 0 (bootstrap, audit, spike)

- **Repository:** public repo `ruoshui-git/kufang-capture`. Native WSL toolchain installed user-level: Node 26, pnpm 12, uv. Includes `AGENTS.md`/`CLAUDE.md`, Codex wave scripts, and the `scripts/check-head` and `scripts/build-image` guards.
- **Infrastructure:** read-only audit in [infrastructure-audit.md](infrastructure-audit.md). The DNS record `capture A 40.160.103.88` was added, and nothing else changed.
- **Host:** the `kufang-capture` system user, `/srv/kufang-capture`, the `.env` and login password (0600, on the VPS only) and a forced-command CI key. The GitHub `production` environment holds the deploy secrets.
- **First deploy:** a Let's Encrypt certificate for capture.kufang.org was issued on the first deploy. `scripts/prod-guard` showed that ERPNext and the Traefik containers were unchanged.

## Waves

| Wave | Scope | State |
|---|---|---|
| 1 | Dexie data layer, ZIP exporter + verifier, app shell + design system + Collections, FastAPI skeleton + deploy tooling | Committed and deployed (shell only) |
| 2 | Inline Entry List, Detail + viewer, camera (system + fast), Diagnostics, Settings | Camera and Detail committed; Entry List in progress |
| 3 | Backend auth/sync/uploads/exports; frontend sync engine; sync/account UI, export, guarded clear | Backend started early |
| 4 | Playwright end-to-end tests, performance (300+ entries), polish, hardening | — |

## Orchestrator review fixes so far

- **Photo ordering:** `addPhotos` read the existing photos outside its transaction. Rapid fast-camera captures could get duplicate sort orders or two covers. Fixed, with a test.
- **Deploy health check:** the deploy script matched the substring `healthy`, so `unhealthy` passed. Fixed.
- **Snapshot containers:** they inherited the Traefik labels and could have received live traffic. They are now excluded.
- **iOS picker:** it resolved with nothing 700 ms after focus returned. That could drop a slow iOS camera result, so the timer was removed and a test added.
- **HEAD requests:** `HEAD /` returned 405 in production. Fixed.
- **GHCR images:** the VPS cannot pull a private GHCR image, so CI now streams the image over the forced-command key.
