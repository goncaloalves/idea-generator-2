#!/usr/bin/env bash
# Start the idea board on the LAN. Detached so it survives the caller exiting.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f /tmp/idea-env ]; then
  set -a
  # shellcheck disable=SC1091
  . /tmp/idea-env
  set +a
fi

export HOST=0.0.0.0
export PORT=8300
export OPENCODE_SESSION_ID=idea-generator-2-bsky-1

exec node server/index.ts
