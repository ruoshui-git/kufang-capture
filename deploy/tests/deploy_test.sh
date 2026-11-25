#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HOST="$TMP/host"
STUBS="$TMP/stubs"
mkdir -p "$HOST/bin" "$HOST/state" "$STUBS"
cp "$ROOT/deploy/compose.yaml" "$HOST/compose.yaml"
cp "$ROOT/deploy/bin/deploy" "$HOST/bin/deploy"
chmod +x "$HOST/bin/deploy"
printf 'CAPTURE_PASSWORD_HASH=test\nCAPTURE_SESSION_SECRET=test\n' > "$HOST/.env"
cat > "$STUBS/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$STUBS/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
[[ "${FAIL_HEALTH:-0}" != 1 ]]
EOF
cat > "$STUBS/date" <<'EOF'
#!/usr/bin/env bash
# Exercise deploy and rollback sharing the installed script's second-based stamp.
printf '20261125T101010Z\n'
EOF
cat > "$STUBS/docker" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$TEST_LOG"
if [[ "$1" == inspect ]]; then
  [[ "${FAIL_HEALTH:-0}" == 1 ]] && printf 'running unhealthy\n' || printf 'running healthy\n'
  exit 0
fi
if [[ "$1" == volume && "$2" == inspect ]]; then
  [[ "${DB_EXISTS:-0}" == 1 ]]
  exit
fi
if [[ "$1" == image && "$2" == inspect ]]; then exit 0; fi
if [[ "$1" == pull ]]; then exit 0; fi
if [[ "$1" == load ]]; then cat >/dev/null; printf 'Loaded image: %s\n' "${LOAD_REF:-kufang-capture:git-abcdef0}"; exit 0; fi
if [[ "$1" == compose ]]; then
  if [[ " $* " == *" capture python -m kufang_capture.snapshot "* ]]; then
    [[ "${SNAPSHOT_FAIL:-0}" == 0 ]] || exit 1
    destination="${!#}"
    [[ "$destination" == /data/snapshots/*-pre-deploy.sqlite3 ]] || exit 2
    python3 -m kufang_capture.snapshot --data-dir "$TEST_DATA" "$TEST_DATA/${destination#/data/}"
    exit $?
  fi
  if [[ " $* " == *" capture python -c "* ]]; then
    code="${!#}"
    python3 -c "${code//\/data/$TEST_DATA}"
    exit $?
  fi
  for arg in "$@"; do
    if [[ "$arg" == up && "${DOCKER_UP_FAIL:-0}" == 1 ]]; then exit 1; fi
  done
  exit 0
fi
exit 0
EOF
chmod +x "$STUBS"/*
export PATH="$STUBS:$PATH"
export TEST_LOG="$TMP/docker.log"
export TEST_DATA="$TMP/data"
export PYTHONPATH="$ROOT/backend/src"
mkdir -p "$TEST_DATA/snapshots"
REF_A=kufang-capture:git-1234567
REF_B=kufang-capture:git-abcdef0

if "$HOST/bin/deploy" deploy 'kufang-capture:git-1234567;touch /tmp/should-not-exist' 2>/dev/null; then
  printf 'invalid reference was accepted\n' >&2
  exit 1
fi
if SSH_ORIGINAL_COMMAND='deploy kufang-capture:git-1234567;touch /tmp/should-not-exist' \
  "$HOST/bin/deploy" 2>/dev/null; then
  printf 'shell metacharacters from SSH_ORIGINAL_COMMAND were accepted\n' >&2
  exit 1
fi
[[ ! -e /tmp/should-not-exist ]]

"$HOST/bin/deploy" deploy "$REF_A"
[[ "$(cat "$HOST/state/current")" == "$REF_A" ]]
grep -F "deploy $REF_A ok" "$HOST/state/history" >/dev/null

if FAIL_HEALTH=1 HEALTH_WAIT_SECONDS=1 "$HOST/bin/deploy" deploy "$REF_B" 2>/dev/null; then
  printf 'health failure did not fail deployment\n' >&2
  exit 1
fi
[[ "$(sed -n 's/^IMAGE=//p' "$HOST/image.env")" == "$REF_A" ]]
grep -F "deploy $REF_B failed" "$HOST/state/history" >/dev/null

status="$("$HOST/bin/deploy" status)"
[[ "$status" == *"Current: $REF_A"* ]]
[[ "$status" == *"Previous: $REF_A"* ]]
[[ "$status" == *"Recent history:"* ]]

python3 - "$TEST_DATA" <<'PYTHON'
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
helper = "01J00000000000000000000001"
with sqlite3.connect(root / "auth.sqlite3") as db:
    db.execute("CREATE TABLE users(id TEXT, is_owner INTEGER)")
    db.executemany("INSERT INTO users VALUES(?,?)", [("owner", 1), (helper, 0)])
for path in (root / "capture.sqlite3", root / "users" / helper / "capture.sqlite3"):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE marker(test INTEGER)")
PYTHON
for day in 21 22 23; do
  cp "$TEST_DATA/capture.sqlite3" "$TEST_DATA/snapshots/202611${day}T101010Z-pre-deploy.sqlite3"
done

if DB_EXISTS=1 SNAPSHOT_FAIL=1 "$HOST/bin/deploy" deploy "$REF_B"; then
  printf 'snapshot failure did not stop deployment\n' >&2
  exit 1
fi
[[ "$(sed -n 's/^IMAGE=//p' "$HOST/image.env")" == "$REF_A" ]]
DB_EXISTS=1 "$HOST/bin/deploy" deploy "$REF_B"
DB_EXISTS=1 "$HOST/bin/deploy" rollback
[[ "$(cat "$HOST/state/current")" == "$REF_A" ]]
if DB_EXISTS=1 SNAPSHOT_FAIL=1 "$HOST/bin/deploy" rollback; then
  printf 'snapshot failure did not stop rollback\n' >&2
  exit 1
fi
[[ "$(sed -n 's/^IMAGE=//p' "$HOST/image.env")" == "$REF_A" ]]
mapfile -t legacy < <(find "$TEST_DATA/snapshots" -maxdepth 1 -type f -name '*-pre-deploy.sqlite3')
[[ ${#legacy[@]} -eq 3 && ! -e "$TEST_DATA/snapshots/20261121T101010Z-pre-deploy.sqlite3" ]]
python3 - "$TEST_DATA/snapshots/20261125T101010Z-pre-deploy.sqlite3" <<'PYTHON'
import sqlite3
import sys

with sqlite3.connect(sys.argv[1]) as db:
    assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    db.execute("SELECT * FROM marker").fetchall()
PYTHON
mapfile -t snapshots < <(find "$TEST_DATA/snapshots" -mindepth 1 -maxdepth 1 -type d)
[[ ${#snapshots[@]} -eq 2 ]]
for archive in "${snapshots[@]}"; do
  [[ -f "$archive/capture.sqlite3" &&
     -f "$archive/auth.sqlite3" &&
     -f "$archive/manifest.json" &&
     -f "$archive/users/01J00000000000000000000001/capture.sqlite3" ]]
done

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  CONFIG="$TMP/config"
  mkdir -p "$CONFIG"
  cp "$ROOT/deploy/compose.yaml" "$CONFIG/compose.yaml"
  printf 'CAPTURE_PASSWORD_HASH=dummy\nCAPTURE_SESSION_SECRET=dummy\n' > "$CONFIG/.env"
  printf 'IMAGE=kufang-capture:git-1234567\n' > "$CONFIG/image.env"
  (cd "$CONFIG" && docker compose -p kufang-capture -f compose.yaml --env-file image.env config >/dev/null)
fi

printf 'deploy tests passed\n'

# load: accepts exactly one kufang-capture:git-<sha> tag from stdin, refuses anything else
if ! printf 'tar' | gzip | LOAD_REF=kufang-capture:git-abcdef0 SSH_ORIGINAL_COMMAND=load "$HOST/bin/deploy" >/dev/null; then
  printf 'valid image load was refused\n' >&2
  exit 1
fi
if printf 'tar' | LOAD_REF=evil/image:latest SSH_ORIGINAL_COMMAND=load "$HOST/bin/deploy" 2>/dev/null; then
  printf 'foreign image tag was accepted by load\n' >&2
  exit 1
fi
grep -q 'image rm evil/image:latest' "$TEST_LOG" || { printf 'refused image was not removed\n' >&2; exit 1; }
printf 'load tests passed\n'
