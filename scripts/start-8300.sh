#!/usr/bin/env bash
# Start the idea board on the LAN. Detached so it survives the caller exiting.
#
# Secrets live in data/service.env (gitignored, chmod 600) so they survive a
# reboot; /tmp/idea-env is kept as a fallback for old setups. API keys are never
# written into data/settings.json — that file holds only non-secret config.
set -euo pipefail

cd "$(dirname "$0")/.."

for f in "$PWD/data/service.env" /tmp/idea-env; do
  if [ -f "$f" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
    break
  fi
done

export HOST=0.0.0.0
export PORT=8300
export OPENCODE_SESSION_ID=idea-generator-2-bsky-1

exec node server/index.ts
