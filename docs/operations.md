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

Each deploy is serialized by `state/deploy.lock`. If a database exists, the currently deployed image
uses SQLite's online backup API to create `/data/snapshots/<UTC>-pre-deploy.sqlite3`; the newest
three snapshots are retained. A failed health check restores the prior image configuration but never
restores a database automatically. Review the failure and application compatibility before restoring
data.

To restore a snapshot manually, stop only this app, keep a copy of the live database **and its
WAL/SHM files**, remove the WAL/SHM files (a stale write-ahead log must never be replayed onto a
restored database), copy the snapshot in, and start again. Run as `kufang-capture` in
`/srv/kufang-capture`:

```sh
c="docker compose -p kufang-capture -f compose.yaml --env-file .env --env-file image.env"
$c stop capture
$c run --rm --no-deps -T --label traefik.enable=false --entrypoint python capture -c "
import pathlib, shutil
d = pathlib.Path('/data'); keep = d / 'before-restore'; keep.mkdir(exist_ok=True)
for n in ('capture.sqlite3', 'capture.sqlite3-wal', 'capture.sqlite3-shm'):
    if (d / n).exists(): shutil.copy2(d / n, keep / n); (d / n).unlink()
shutil.copy2(d / 'snapshots' / '<snapshot-name>', d / 'capture.sqlite3')"
$c up -d --wait
```

Replace `<snapshot-name>` with the exact file name, then check `deploy status` and
`https://capture.kufang.org/api/health`. This is an operator-triggered deploy rollback aid, not a
backup service; there are no scheduled or off-host backups.

## Isolation guarantees

All Compose commands issued by the deploy tool name both project `kufang-capture` and
`compose.yaml`, whose declared name is checked before operation. The service has no published ports;
Traefik routes through the external `kufang-edge` network. The deployment tool does not call or alter
the ERPNext project or Traefik project, and images are never built on the VPS.
