#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$HOME/.local/bin/node"
exec "$NODE_BIN" scripts/manage.mjs "$@"
