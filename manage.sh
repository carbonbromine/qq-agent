#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" && -f "$ROOT/.deployment-node" ]]; then
  IFS= read -r NODE_BIN < "$ROOT/.deployment-node" || true
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || {
  printf 'Deployed Node.js runtime is unavailable. Re-run deploy.sh or set NODE_BIN.\n' >&2
  exit 1
}
exec "$NODE_BIN" scripts/manage.mjs "$@"
