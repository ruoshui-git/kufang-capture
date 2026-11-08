# Kufang Capture agent guide

Shared Codex/Claude guide. The product and architecture source of truth is [docs/spec.md](docs/spec.md); the owner decisions listed below take precedence over it.

**This repository is PUBLIC.** Never commit secrets, private keys, passwords, tokens, session secrets, `.env` files or `credentials/`. Hostnames and public IPs are fine. If you need a secret at runtime, read it from the environment or from an operator file that is gitignored.

## Owner decisions (2026-11-08)

- The domain is `https://capture.kufang.org`.
- No server backups (nightly or off-VPS). This is a helper tool. A pre-deploy SQLite snapshot is kept only for rollback. Spec acceptance item 13 is waived.
- The repository is public, `ruoshui-git/kufang-capture`. CI deploys with a forced-command SSH key.

## Invariants

- **Local first.** Every change commits a durable IndexedDB transaction before the UI reports `Saved on this device`. New Entry, capture, navigation and editing never wait on the network.
- **Local Only never transmits.** No metadata or photo of a `local_only` collection may reach the server, not even in logs, error reports or analytics. Opting into sync is explicit and needs consent before older photos are uploaded.
- **Originals are sacred.** Store and export the exact bytes the capture route produced. Thumbnails are separate derived files. Never resize, re-encode or strip original bytes.
- **Sequence numbers are immutable and never reused.** Allocation and `next_sequence_number` increment happen in one transaction. Deleting or restoring never renumbers.
- **Deletes are soft.** Entry and photo deletion sets `deleted_at`, offers Undo and appears in Recently Deleted. Irreversible clearing is guarded by a fresh export and an exact-name confirmation.
- **Blank is not zero.** Quantities are raw decimal strings, and summaries sum per unit only, never `5 boxes + 12 pieces = 17`.
- **Server acknowledgment and hash verification come before `Backed up`.** The outbox is cleared only on acknowledgment.
- **Camera honesty.** Show lens, zoom, focus or torch controls only when the browser exposes them through `enumerateDevices`/`getCapabilities`. Label digital crop as digital. Never claim a real-device result without evidence from the user.
- **Independence.** Nothing here depends on Frappe, ERPNext, temple_inventory, MariaDB or Redis.
- **English UI**, help and docs. User-entered text may be in any language.

## Repository map

| Path | Contents |
|---|---|
| `frontend/` | Svelte 5 (runes) + Vite + TypeScript static PWA, Tailwind v4, Dexie 4 |
| `frontend/src/lib/types.ts`, `repo.ts` | Shared domain and repository contracts (orchestrator-owned) |
| `frontend/src/lib/db/` | Dexie implementation of `Repo` |
| `frontend/src/lib/{photos,export,sync,camera,summary}/` | Domain modules |
| `frontend/src/{app,routes,components}/` | Shell, screens, UI components |
| `backend/` | FastAPI + stdlib sqlite3 (WAL), managed with uv |
| `deploy/` | Containerfile, compose, VPS deploy script, DNS manifest |
| `tools/` | `verify-export.py` and other operator tools |
| `docs/` | spec, API contract, export format, design, acceptance matrix, progress, iPhone checklist, operations |

## Working rules

- TypeScript is strict. Format with Prettier (`.prettierrc.json`: no semicolons, single quotes, 110 columns). Python follows Ruff defaults with 4-space indent, 110 columns, and type hints.
- Prefer small, concrete modules over abstractions without behavior. Reuse `formatSequence`/`entryDisplayTitle` from `types.ts`.
- Add focused tests for every behavior and invariant you change. Do not weaken assertions to make tests pass.
- Contracts (`types.ts`, `repo.ts`, `docs/api.md`, `docs/export-format.md`) change only through the orchestrator. Propose the change in your report.
- Before user-facing changes, read [docs/design.md](docs/design.md) (intent, layouts, copy) and
  [docs/design-system.md](docs/design-system.md) (tokens and component rules). Style only with the CSS
  variables in `frontend/src/styles/tokens.css` and the shared component classes: no raw colours, no
  off-scale spacing, type sizes or radii. `pnpm lint:design` enforces this in CI.

## Development (native WSL2; no Docker for routine work)

Node, pnpm and uv are native Linux binaries in `~/.local/bin`. **Never** use the Windows copies under `/mnt/c`. Work only on the ext4 checkout `/home/ruoshui/code/kufang-capture`.

| Task | Command |
|---|---|
| Frontend dev server (proxies `/api` → 8000) | `cd frontend && pnpm dev` |
| Backend dev server | `cd backend && uv run uvicorn kufang_capture.main:app --reload --port 8000` |
| Frontend install | `cd frontend && pnpm install` |
| Backend install | `cd backend && uv sync` |

The local dev DB and media live in `backend/data/` (gitignored). Local dev uses `CAPTURE_DEV_PASSWORD=dev` (public, local only).

## Validation

Use `scripts/heavy` to serialize heavy commands (builds, Playwright, image builds) between parallel agents.

| Check | Command (from the directory shown) |
|---|---|
| Vitest | `frontend/`: `pnpm test` |
| Types | `frontend/`: `pnpm check` |
| Format | `frontend/`: `pnpm format:check` |
| Design tokens | `frontend/`: `pnpm lint:design` |
| Build | `frontend/`: `../scripts/heavy pnpm build` |
| Backend tests | `backend/`: `uv run pytest -q` |
| Ruff | `backend/`: `uv run ruff check . && uv run ruff format --check .` |
| E2E (Playwright in Docker) | `frontend/`: `../scripts/heavy pnpm test:e2e` (see `frontend/tests/e2e/README.md`) |
| Export check | repo root: `python3 tools/verify-export.py FILE.zip` |

## Parallel work and Codex

- One orchestrator owns git (Codex's sandbox keeps `.git` read-only), integration, deploys and shared docs.
- Parallel tasks get disjoint owned paths. Never edit files outside your owned list. Write the shared-doc changes you need to `/tmp/codex-runs/NAME-docs.md`.
- Screenshots and evidence go to `/tmp/codex-runs/NAME-shots/` or a test output directory, never to committed paths.
- Codex procedure: [docs/agents/codex.md](docs/agents/codex.md).

## Git and deploy

- `main` is trunk and uses Conventional Commits with a "why" body. CI on `main` builds `ghcr.io/ruoshui-git/kufang-capture` and deploys by digest. See [docs/operations.md](docs/operations.md).
- Production lives on host `kufang-prod` (shared with ERPNext). Our footprint is the compose project `kufang-capture`, the `/srv/kufang-capture/`, the volume `kufang-capture-data` and the Traefik router `kufang-capture`.
- **Never** run compose, restart, rebuild or modify `kufang-production` (ERPNext) or `kufang-edge` (Traefik). Only attach to the `kufang-edge` network.
- Never run `docker compose down -v`. Never build images on the VPS (2 vCPU / 3.7 GiB, shared).
- DNS changes are limited to the `capture` A record. Never touch MX, SPF, DKIM, DMARC or other records.
- Other VPS, DNS, GitHub settings or destructive actions require owner approval.
