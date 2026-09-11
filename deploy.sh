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
NODE_BIN="${NODE_BIN:-}"
NODE_VERSION="${QQ_AGENT_NODE_VERSION:-22.23.2}"

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
for p in "$INSTALL_DIR" "$DATA_DIR"; do
  [[ "$p" != *[[:space:]%\"]* ]] || {
    printf 'Deployment paths must not contain whitespace, %% or quotes: %s\n' "$p" >&2
    exit 2
  }
done
command -v systemctl >/dev/null
systemctl --user show-environment >/dev/null
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
if [[ "$ROOT" != "$INSTALL_DIR" ]]; then
  command -v rsync >/dev/null
  rsync -a --exclude=node_modules --exclude=data --exclude=.git --exclude=.env --exclude=.runtime "$ROOT/" "$INSTALL_DIR/"
fi

node_ready() {
  [[ -n "$1" && -x "$1" ]] || return 1
  "$1" --input-type=module -e '
    const [major,minor]=process.versions.node.split(".").map(Number);
    if (major<22 || (major===22 && minor<13)) process.exit(1);
    const {DatabaseSync}=await import("node:sqlite");
    new DatabaseSync(":memory:").close();
  ' >/dev/null 2>&1
}

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if ! node_ready "$NODE_BIN"; then
  command -v curl >/dev/null
  command -v sha256sum >/dev/null
  command -v tar >/dev/null
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) printf 'Unsupported CPU architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  RUNTIME_DIR="$INSTALL_DIR/.runtime"
  ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  TMP_DIR="$(mktemp -d)"
  printf 'Installing Node.js v%s for %s...\n' "$NODE_VERSION" "$NODE_ARCH"
  curl -fsSLo "$TMP_DIR/$ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/$ARCHIVE"
  curl -fsSLo "$TMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "$TMP_DIR" && grep "  $ARCHIVE$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$RUNTIME_DIR"
  tar -xJf "$TMP_DIR/$ARCHIVE" -C "$RUNTIME_DIR"
  rm -rf "$TMP_DIR"
  NODE_BIN="$RUNTIME_DIR/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node"
fi
node_ready "$NODE_BIN" || { printf 'Node.js >=22.13 with node:sqlite is required\n' >&2; exit 1; }
[[ "$NODE_BIN" != *[[:space:]%\"]* ]] || { printf 'Node path contains unsupported characters\n' >&2; exit 2; }
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
  else
    systemctl --user disable --now "$SERVICE.service" >/dev/null 2>&1 || true
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
if [[ "$(loginctl show-user "$USER" -p Linger --value)" != yes ]]; then
  sudo loginctl enable-linger "$USER"
fi
case "$HOST" in
  0.0.0.0) HEALTH_HOST=127.0.0.1 ;;
  ::|\[::\]) HEALTH_HOST='[::1]' ;;
  *) HEALTH_HOST="$HOST" ;;
esac
HEALTHY=false
for _ in {1..50}; do
  if "$NODE_BIN" -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
      "http://$HEALTH_HOST:$PORT/healthz"; then
    HEALTHY=true
    break
  fi
  sleep 0.2
done
[[ "$HEALTHY" == true ]] || { printf 'Service health check failed\n' >&2; exit 1; }
trap - ERR
systemctl --user --no-pager status "$SERVICE.service"
MODE="$("$NODE_BIN" -e 'const c=require(process.argv[1]);process.stdout.write(c.runtime.mode)' "$DATA_DIR/config.json")"
printf '\nConsole: http://%s:%s (%s mode)\nToken: %s/manage.sh token\n' "$HOST" "$PORT" "$MODE" "$INSTALL_DIR"
