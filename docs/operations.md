# Kufang Capture operations

Kufang Capture runs as the separate Compose project `kufang-capture` on `kufang-prod`. Its only
application files are under `/srv/kufang-capture/`; its persistent data volume is
`kufang-capture-data`. The app joins the existing `kufang-edge` network and publishes no host ports.
It has a 384 MiB memory limit, one CPU limit, a read-only root filesystem, and dropped Linux
capabilities. Images are built in CI or on a trusted workstation, never on the VPS.

## First-time host setup

Review and run the installer from a checked-out release or source tree:

```sh
sudo deploy/bin/install-host.sh
sudoedit /srv/kufang-capture/.env
```

The installer creates the `kufang-capture` system user (in the Docker group), `/srv/kufang-capture/`
with mode `0750`, `bin/`, `state/`, `compose.yaml`, and `.env` mode `0600` if it does not exist.
It never edits another project's files. Fill the two secret values in `.env`; generate the password
hash from the backend directory so the password is entered without echo:

```sh
cd backend
uv run python -m kufang_capture.hashpw
```

Set `CAPTURE_PASSWORD_HASH` to the resulting Argon2 hash. Set `CAPTURE_SESSION_SECRET` to a fresh,
high-entropy secret (for example, `openssl rand -hex 32`) and keep it only on the VPS. Keep
`CAPTURE_PUBLIC_ORIGIN=https://capture.kufang.org`. Do not copy `.env` into the public repository.

Install the CI SSH key restricted to the deployment command (already done for production):

```text
command="/srv/kufang-capture/bin/deploy",restrict ssh-ed25519 AAAA... github-actions-kufang-capture
```

The forced command accepts only `load` (image tarball on stdin), `deploy IMAGE_REF`, `status` and
`rollback`. It parses the incoming command as words and validates every image reference; it never
evaluates shell input. `load` accepts exactly one image tagged `kufang-capture:git-<sha>` and removes
anything else it was sent.

## Agent API token

Generate a token from at least 32 random bytes in a password manager and store it with the
authorized client. On a trusted workstation, hash it at a hidden prompt:

```sh
python3 -c 'import getpass, hashlib; print(hashlib.sha256(getpass.getpass("Agent token: ").encode()).hexdigest())'
```

Set `CAPTURE_AGENT_TOKEN_SHA256` to the resulting lowercase hex digest in the VPS
`/srv/kufang-capture/.env`. The client sends the original token as an HTTPS bearer credential.
Recreate the Capture service using its current image to load the environment:

```sh
cd /srv/kufang-capture
docker compose --env-file .env --env-file image.env up -d --no-deps --force-recreate capture
```

For rotation, replace the digest, recreate the service, and update the client's token. To
disable agent access, remove the variable or leave it empty and recreate the service.

## DNS

Review the single-record manifest with the `temple_inventory` `spaceship-dns` helper before applying
(`SPACESHIP_CREDENTIALS` points at the operator's credentials file; never print or copy it):

```sh
spaceship-dns plan deploy/dns/capture.kufang.org.json
spaceship-dns apply deploy/dns/capture.kufang.org.json --yes
```

The manifest manages only the `capture` A record; mail and other records are untouched.

## Deploying

**Normal path (CI).** Every push to `main` runs `.github/workflows/ci.yml`: frontend checks and
tests, backend tests, deploy-script tests and a gitleaks scan; then the `deploy` job (GitHub
environment `production`, branch `main` only) builds the image on the runner, streams it to the VPS
with `docker save | gzip | ssh … load`, runs `deploy kufang-capture:git-<sha12>`, and checks that
`https://capture.kufang.org/api/health` reports the new version. No registry is involved, so GHCR
package visibility does not matter.

**Manual path (operator workstation).** Build from a clean export of a commit, ship, deploy:

```sh
scripts/build-image                    # prints kufang-capture:git-<sha12>
docker save kufang-capture:git-<sha12> | gzip -1 | \
  ssh kufang-prod 'sudo -u kufang-capture /srv/kufang-capture/bin/deploy load'
ssh kufang-prod 'sudo -u kufang-capture /srv/kufang-capture/bin/deploy deploy kufang-capture:git-<sha12>'
```

For the very first deployment only, if Traefik has not issued the certificate yet, prefix the deploy
with `env FIRST_DEPLOY=1` (permits `curl -k` for the local probe). The container health check and the
HTTPS probe must both pass before the new image is recorded as current; otherwise the previous image
is restored.

**ERPNext guard.** Around any manual or infrastructure change, run
`scripts/prod-guard snapshot FILE` before and `scripts/prod-guard check FILE` after: it proves every
`kufang-production-*` and `kufang-edge-*` container kept its ID, start time and restart count and that
`https://kufang.org/api/method/ping` answers.

## Status, rollback, and snapshots

```sh
ssh kufang-prod 'sudo -u kufang-capture /srv/kufang-capture/bin/deploy status'
ssh kufang-prod 'sudo -u kufang-capture /srv/kufang-capture/bin/deploy rollback'
```

Deploys keep the current and previous app images and prune older `kufang-capture:git-*` images.

Each deploy and image rollback is serialized by `state/deploy.lock`. The existing host script
asks the running image to create `/data/snapshots/<UTC>-pre-deploy.sqlite3`, a plain SQLite backup
of the owner's database. The account-enabled image also writes a companion
`/data/snapshots/<UTC>-pre-deploy/` directory, with a more precise timestamp if the directory name
is already in use. The directory contains a manifest listing every required database. Each copy
uses SQLite's online backup API and passes an integrity check.

- `capture.sqlite3` holds the owner's data and hashed sessions in their original location.
- `auth.sqlite3` holds account metadata, hashed helper sessions, hashed join codes and login attempts.
- `users/<user_id>/capture.sqlite3` holds each helper's data, including disabled accounts.
  Owner and helper media stay in their respective `media/` directories under the volume.

The host script retains the three most recent owner files. The account-enabled snapshot utility
independently retains the three most recent companion directories. A snapshot failure stops
deployment before the image changes. Because the service stays up while the databases are copied,
the databases in one set can reflect slightly different times.

The account-enabled image migrates every registered database at startup. Both image versions use
the owner's original session table, so active owner sessions survive an image rollback. An image
rollback keeps the live database files in place. Helper data is accessible again when the service
returns to an account-enabled image.
A failed deploy restores the prior image configuration. Database restoration is a separate
operator decision.

For a manual database restore, use an account-enabled image and run as `kufang-capture` from
`/srv/kufang-capture`. Replace `SNAPSHOT_NAME` with the directory name for a full restore or the
SQLite filename for an owner-only data restore.

```sh
c="docker compose -p kufang-capture -f compose.yaml --env-file .env --env-file image.env"
$c stop capture
$c run --rm --no-deps -T --label traefik.enable=false capture \
  python -m kufang_capture.snapshot --restore /data/snapshots/SNAPSHOT_NAME
$c up -d --wait
```

Run the start command after the restore succeeds, then check `deploy status` and
`https://capture.kufang.org/api/health`. The restore verifies the selected snapshot before it
sets aside the live databases and their WAL and SHM sidecars under `/data/before-restore-*/`.
A full restore reinstates the account registry and sets aside databases for accounts added since
the snapshot. An owner-only data restore preserves the current helper accounts and their inventory.
Every restore clears all sessions and join codes in the installed copies. The owner signs in again
with the owner password and issues fresh join codes for helpers. Media remains on disk and may
have changed since the snapshot was taken.
Protect both the snapshots and the set-aside files as sensitive data. There are no scheduled
or off-host backups.

## Isolation guarantees

All Compose commands issued by the deploy tool name both project `kufang-capture` and
`compose.yaml`, whose declared name is checked before operation. The service has no published ports;
Traefik routes through the external `kufang-edge` network. The deployment tool does not call or alter
the ERPNext project or Traefik project, and images are never built on the VPS.
