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
if [[ "$1" == compose ]]; then
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

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  CONFIG="$TMP/config"
  mkdir -p "$CONFIG"
  cp "$ROOT/deploy/compose.yaml" "$CONFIG/compose.yaml"
  printf 'CAPTURE_PASSWORD_HASH=dummy\nCAPTURE_SESSION_SECRET=dummy\n' > "$CONFIG/.env"
  printf 'IMAGE=kufang-capture:git-1234567\n' > "$CONFIG/image.env"
  (cd "$CONFIG" && docker compose -p kufang-capture -f compose.yaml --env-file image.env config >/dev/null)
fi

printf 'deploy tests passed\n'
