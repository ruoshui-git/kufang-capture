#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  printf 'Run this installer with sudo.\n' >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/srv/kufang-capture
if ! id kufang-capture >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_DIR" --shell /bin/bash --groups docker kufang-capture
else
  usermod --home "$APP_DIR" --shell /bin/bash --append --groups docker kufang-capture
fi
install -d -o kufang-capture -g kufang-capture -m 0750 "$APP_DIR" "$APP_DIR/bin" "$APP_DIR/state"
install -o kufang-capture -g kufang-capture -m 0640 "$SOURCE_DIR/deploy/compose.yaml" "$APP_DIR/compose.yaml"
install -o root -g root -m 0755 "$SOURCE_DIR/deploy/bin/deploy" "$APP_DIR/bin/deploy"
if [[ ! -e "$APP_DIR/.env" ]]; then
  install -o kufang-capture -g kufang-capture -m 0600 "$SOURCE_DIR/deploy/env.example" "$APP_DIR/.env"
fi
chown kufang-capture:kufang-capture "$APP_DIR" "$APP_DIR/bin" "$APP_DIR/state"
printf 'Installed Kufang Capture under %s.\n' "$APP_DIR"
printf 'Next: edit %s/.env, then install the forced-command SSH key and transfer the first image.\n' "$APP_DIR"
