#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$ROOT"
DATA_DIR=""
HOST="127.0.0.1"
PORT="3210"
SERVICE="qq-agent-linux"
IMPORT_BRIDGE=""
CREDENTIAL_FILE=""
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --import-bridge) IMPORT_BRIDGE="$2"; shift 2 ;;
    --credential-file) CREDENTIAL_FILE="$2"; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || { printf 'Linux only\n' >&2; exit 1; }
[[ "$SERVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ "$INSTALL_DIR" = /* ]] || { printf 'Use an absolute installation path\n' >&2; exit 2; }
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
[[ "$DATA_DIR" = /* ]] || exit 2
for p in "$INSTALL_DIR" "$DATA_DIR" "$NODE_BIN"; do
  [[ "$p" != *[[:space:]%\"]* ]] || {
    printf 'Deployment paths must not contain whitespace, %% or quotes: %s\n' "$p" >&2
    exit 2
  }
done
[[ -x "$NODE_BIN" ]] || { printf 'Install Node.js >=22.13 and pass --node /path/to/node\n' >&2; exit 1; }
"$NODE_BIN" --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(':memory:').close();"
command -v systemctl >/dev/null
systemctl --user show-environment >/dev/null
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
if [[ "$ROOT" != "$INSTALL_DIR" ]]; then
  command -v rsync >/dev/null
  rsync -a --exclude=node_modules --exclude=data --exclude=.git --exclude=.env "$ROOT/" "$INSTALL_DIR/"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
cd "$INSTALL_DIR"
npm ci --omit=dev --ignore-scripts
WAS_ACTIVE=false
if systemctl --user is-active --quiet "$SERVICE.service"; then
  WAS_ACTIVE=true
  systemctl --user stop "$SERVICE.service"
fi
restore_service() {
  if [[ "$WAS_ACTIVE" == true ]]; then
    systemctl --user start "$SERVICE.service" || true
  fi
}
trap restore_service ERR
# Do not silently choose another port on a server.
"$NODE_BIN" --input-type=module -e '
import net from "node:net";
const s=net.createServer(); s.on("error",e=>{console.error(e.message);process.exit(1)});
s.listen(Number(process.argv[1]), process.argv[2], ()=>s.close());
' "$PORT" "$HOST"
ARGS=(--data-dir "$DATA_DIR" --host "$HOST" --port "$PORT")
[[ -z "$IMPORT_BRIDGE" ]] || ARGS+=(--import-bridge "$IMPORT_BRIDGE")
[[ -z "$CREDENTIAL_FILE" ]] || ARGS+=(--credential-file "$CREDENTIAL_FILE")
"$NODE_BIN" scripts/configure-linux.mjs "${ARGS[@]}"
export QQ_INSTALL_DIR="$INSTALL_DIR" QQ_DATA_DIR="$DATA_DIR" QQ_NODE="$NODE_BIN" QQ_SERVICE="$SERVICE"
"$NODE_BIN" scripts/install-service.mjs
systemd-analyze --user verify "$HOME/.config/systemd/user/$SERVICE.service"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"
trap - ERR
if [[ "$(loginctl show-user "$USER" -p Linger --value)" != yes ]]; then
  sudo loginctl enable-linger "$USER"
fi
systemctl --user --no-pager status "$SERVICE.service"
printf '\nConsole: http://%s:%s (observe mode)\nToken: %s/manage.sh token\n' "$HOST" "$PORT" "$INSTALL_DIR"
