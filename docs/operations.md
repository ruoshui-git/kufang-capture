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

Install a CI SSH key restricted to the deployment command, for example:

```text
command="/srv/kufang-capture/bin/deploy",restrict ssh-ed25519 AAAA... ci-deploy
```

The forced command accepts only `deploy IMAGE_REF`, `status`, or `rollback`. It parses the incoming
command as words and validates the image reference; it never evaluates shell input.

## DNS and first deploy

Review the single-record manifest with the `temple_inventory` `spaceship-dns` helper before applying:

```sh
spaceship-dns plan deploy/dns/capture.kufang.org.json
spaceship-dns apply deploy/dns/capture.kufang.org.json
```

The manifest changes only `capture.kufang.org`'s A record. Build an image away from the VPS, then
transfer and load it using an operator SSH account that can run `docker load`:

```sh
docker save kufang-capture:git-<7-to-40-char-commit> | ssh kufang-prod docker load
ssh kufang-prod deploy kufang-capture:git-<commit-sha>
```

For the initial deployment only, if Traefik has not issued the certificate yet, the operator may set
`FIRST_DEPLOY=1` for the deploy command. This permits `curl -k` for the local health probe; subsequent
deploys require normal certificate verification. The container health check and HTTPS health probe
must both succeed before the script records the new image as current.

CI deploys immutable GHCR references by digest, for example
`ghcr.io/ruoshui-git/kufang-capture@sha256:<64-lowercase-hex-digest>`. The deploy key's forced
command accepts only that exact repository and digest form, or a locally loaded
`kufang-capture:git-<commit>` tag.

## Status, rollback, and snapshots

```sh
ssh kufang-prod status
ssh kufang-prod rollback
```

Each deploy is serialized by `state/deploy.lock`. If a database exists, the currently deployed image
uses SQLite's online backup API to create `/data/snapshots/<UTC>-pre-deploy.sqlite3`; the newest
three snapshots are retained. A failed health check restores the prior image configuration but never
restores a database automatically. Review the failure and application compatibility before restoring
data.

To restore a snapshot manually, first stop only this project's app, preserve a copy of the live DB,
then copy the chosen verified snapshot into the named volume using a one-off container from the
currently deployed image. For example, from `/srv/kufang-capture`:

```sh
docker compose -p kufang-capture -f compose.yaml --env-file .env --env-file image.env stop capture
docker compose -p kufang-capture -f compose.yaml --env-file .env --env-file image.env run --rm --no-deps -T \
  --entrypoint python capture -c "import shutil; shutil.copy2('/data/capture.sqlite3', '/data/capture.sqlite3.before-restore')"
docker compose -p kufang-capture -f compose.yaml --env-file .env --env-file image.env run --rm --no-deps -T \
  --entrypoint python capture -c "import shutil; shutil.copy2('/data/snapshots/<snapshot-name>', '/data/capture.sqlite3')"
docker compose -p kufang-capture -f compose.yaml --env-file .env --env-file image.env up -d --wait
```

Replace `<snapshot-name>` with the exact file name, then check `ssh kufang-prod status` and
`https://capture.kufang.org/api/health`. This is an operator-triggered deploy rollback aid, not a
backup service; there are no scheduled or off-host backups.

## Isolation guarantees

All Compose commands issued by the deploy tool name both project `kufang-capture` and
`compose.yaml`, whose declared name is checked before operation. The service has no published ports;
Traefik routes through the external `kufang-edge` network. The deployment tool does not call or alter
the ERPNext project or Traefik project, and images are never built on the VPS.
