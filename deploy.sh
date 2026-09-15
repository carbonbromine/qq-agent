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
BACKUP_ENABLED=true

usage() {
  cat <<'EOF'
Usage: bash deploy.sh [options]

Options:
  --install-dir PATH     Application directory (default: repository directory)
  --data-dir PATH        Persistent data directory (default: INSTALL_DIR/data)
  --host ADDRESS         Console bind address (default: 127.0.0.1)
  --port PORT            Console port (default: 3210)
  --service NAME         systemd user service name (default: qq-agent-linux)
  --node PATH            Existing Node.js >=22.13 binary
  --import-bridge PATH   Import legacy Bridge config on first install
  --credential-file PATH Import DEEPSEEK_API_KEY on first install
  --no-backup            Skip the pre-deployment code snapshot
  -h, --help             Show this help
EOF
}

require_value() {
  (($# >= 2)) || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
}

while (($#)); do
  case "$1" in
    --install-dir) require_value "$@"; INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) require_value "$@"; DATA_DIR="$2"; shift 2 ;;
    --host) require_value "$@"; HOST="$2"; shift 2 ;;
    --port) require_value "$@"; PORT="$2"; shift 2 ;;
    --service) require_value "$@"; SERVICE="$2"; shift 2 ;;
    --node) require_value "$@"; NODE_BIN="$2"; shift 2 ;;
    --import-bridge) require_value "$@"; IMPORT_BRIDGE="$2"; shift 2 ;;
    --credential-file) require_value "$@"; CREDENTIAL_FILE="$2"; shift 2 ;;
    --no-backup) BACKUP_ENABLED=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || { printf 'Linux only\n' >&2; exit 1; }
[[ "$SERVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || {
  printf 'Port must be an integer from 1 to 65535\n' >&2
  exit 2
}
[[ "$INSTALL_DIR" = /* ]] || { printf 'Use an absolute installation path\n' >&2; exit 2; }
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
[[ "$DATA_DIR" = /* ]] || { printf 'Use an absolute data path\n' >&2; exit 2; }
for p in "$INSTALL_DIR" "$DATA_DIR"; do
  [[ "$p" != *[[:space:]%\"]* ]] || {
    printf 'Deployment paths must not contain whitespace, %% or quotes: %s\n' "$p" >&2
    exit 2
  }
done
if [[ "$ROOT" != "$INSTALL_DIR" && "$INSTALL_DIR" == "$ROOT/"* ]]; then
  printf 'Installation path must not be nested inside the source repository\n' >&2
  exit 2
fi
command -v systemctl >/dev/null
systemctl --user show-environment >/dev/null
command -v rsync >/dev/null
mkdir -p "$INSTALL_DIR" "$DATA_DIR"

LOCK_DIR="$DATA_DIR/.deploy.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf 'Another deployment may be running. Remove stale lock only after checking: %s\n' "$LOCK_DIR" >&2
  exit 1
fi
cleanup_lock() {
  rm -rf -- "$LOCK_DIR"
}
trap cleanup_lock EXIT

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
NODE_BIN="$("$NODE_BIN" -p 'process.execPath')"
[[ "$NODE_BIN" != *[[:space:]%\"]* ]] || { printf 'Node path contains unsupported characters\n' >&2; exit 2; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

for required in package.json package-lock.json src/server.js src/auto-update.js scripts/auto-update.mjs scripts/configure-linux.mjs scripts/install-service.mjs scripts/manage.mjs manage.sh; do
  [[ -f "$ROOT/$required" ]] || {
    printf 'Source repository is incomplete: missing %s\n' "$required" >&2
    exit 1
  }
done
"$NODE_BIN" --check "$ROOT/src/server.js"
"$NODE_BIN" --check "$ROOT/scripts/configure-linux.mjs"
"$NODE_BIN" --check "$ROOT/scripts/install-service.mjs"
bash -n "$ROOT/manage.sh"

RSYNC_PRESERVE=(
  --exclude=/.git/
  --exclude=/.runtime/
  --exclude=/.deployment.json
  --exclude=/.deployment-node
  --exclude=/.dbg/
  --exclude='/debug-*.md'
  --exclude=/.env
  --exclude='/.env.*'
  --exclude='*.log'
)
if [[ "$DATA_DIR" == "$INSTALL_DIR/"* ]]; then
  DATA_REL="${DATA_DIR#"$INSTALL_DIR"/}"
  RSYNC_PRESERVE+=(--exclude="/$DATA_REL/")
else
  RSYNC_PRESERVE+=(--exclude=/data/)
fi
RSYNC_SOURCE=("${RSYNC_PRESERVE[@]}" --exclude=/node_modules/)

WAS_ACTIVE=false
if systemctl --user is-active --quiet "$SERVICE.service"; then
  WAS_ACTIVE=true
fi

ROLLBACK_DIR=""
if [[ "$BACKUP_ENABLED" == true && -f "$INSTALL_DIR/package.json" ]]; then
  BACKUP_ROOT="$DATA_DIR/deploy-backups"
  ROLLBACK_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$ROLLBACK_DIR/app"
  rsync -a "${RSYNC_PRESERVE[@]}" "$INSTALL_DIR/" "$ROLLBACK_DIR/app/"
  printf 'Created rollback snapshot: %s\n' "$ROLLBACK_DIR"
fi

UNIT_FILE="$HOME/.config/systemd/user/$SERVICE.service"
UPDATE_SERVICE="${SERVICE}-update"
UPDATE_UNIT_FILE="$HOME/.config/systemd/user/$UPDATE_SERVICE.service"
UPDATE_TIMER_FILE="$HOME/.config/systemd/user/$UPDATE_SERVICE.timer"
mkdir -p "$LOCK_DIR/state"
HAD_CONFIG=false
HAD_ACCESS_FILE=false
HAD_UNIT=false
HAD_DEPLOYMENT_JSON=false
HAD_DEPLOYMENT_NODE=false
HAD_UPDATE_UNIT=false
HAD_UPDATE_TIMER=false
WAS_UPDATE_TIMER_ENABLED=false
WAS_UPDATE_TIMER_ACTIVE=false
if [[ -f "$DATA_DIR/config.json" ]]; then
  HAD_CONFIG=true
  cp -p "$DATA_DIR/config.json" "$LOCK_DIR/state/config.json"
fi
if [[ -f "$DATA_DIR/console-access.txt" ]]; then
  HAD_ACCESS_FILE=true
  cp -p "$DATA_DIR/console-access.txt" "$LOCK_DIR/state/console-access.txt"
fi
if [[ -f "$UNIT_FILE" ]]; then
  HAD_UNIT=true
  cp -p "$UNIT_FILE" "$LOCK_DIR/state/service.unit"
fi
if [[ -f "$UPDATE_UNIT_FILE" ]]; then
  HAD_UPDATE_UNIT=true
  cp -p "$UPDATE_UNIT_FILE" "$LOCK_DIR/state/update.service"
fi
if [[ -f "$UPDATE_TIMER_FILE" ]]; then
  HAD_UPDATE_TIMER=true
  cp -p "$UPDATE_TIMER_FILE" "$LOCK_DIR/state/update.timer"
fi
if systemctl --user is-enabled --quiet "$UPDATE_SERVICE.timer" 2>/dev/null; then
  WAS_UPDATE_TIMER_ENABLED=true
fi
if systemctl --user is-active --quiet "$UPDATE_SERVICE.timer" 2>/dev/null; then
  WAS_UPDATE_TIMER_ACTIVE=true
fi
if [[ -f "$INSTALL_DIR/.deployment.json" ]]; then
  HAD_DEPLOYMENT_JSON=true
  cp -p "$INSTALL_DIR/.deployment.json" "$LOCK_DIR/state/deployment.json"
fi
if [[ -f "$INSTALL_DIR/.deployment-node" ]]; then
  HAD_DEPLOYMENT_NODE=true
  cp -p "$INSTALL_DIR/.deployment-node" "$LOCK_DIR/state/deployment-node"
fi

rollback_deployment() {
  local status=$?
  trap - ERR INT TERM
  set +e
  printf '\nDeployment failed; restoring the previous installation...\n' >&2
  systemctl --user stop "$SERVICE.service" >/dev/null 2>&1
  systemctl --user disable --now "$UPDATE_SERVICE.timer" >/dev/null 2>&1
  if [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR/app" ]]; then
    rsync -a --delete "${RSYNC_PRESERVE[@]}" "$ROLLBACK_DIR/app/" "$INSTALL_DIR/"
  fi
  if [[ "$HAD_CONFIG" == true ]]; then
    cp -p "$LOCK_DIR/state/config.json" "$DATA_DIR/config.json"
  else
    rm -f -- "$DATA_DIR/config.json"
  fi
  if [[ "$HAD_ACCESS_FILE" == true ]]; then
    cp -p "$LOCK_DIR/state/console-access.txt" "$DATA_DIR/console-access.txt"
  else
    rm -f -- "$DATA_DIR/console-access.txt"
  fi
  if [[ "$HAD_UNIT" == true ]]; then
    mkdir -p "$(dirname "$UNIT_FILE")"
    cp -p "$LOCK_DIR/state/service.unit" "$UNIT_FILE"
  else
    rm -f -- "$UNIT_FILE"
  fi
  if [[ "$HAD_UPDATE_UNIT" == true ]]; then
    cp -p "$LOCK_DIR/state/update.service" "$UPDATE_UNIT_FILE"
  else
    rm -f -- "$UPDATE_UNIT_FILE"
  fi
  if [[ "$HAD_UPDATE_TIMER" == true ]]; then
    cp -p "$LOCK_DIR/state/update.timer" "$UPDATE_TIMER_FILE"
  else
    rm -f -- "$UPDATE_TIMER_FILE"
  fi
  if [[ "$HAD_DEPLOYMENT_JSON" == true ]]; then
    cp -p "$LOCK_DIR/state/deployment.json" "$INSTALL_DIR/.deployment.json"
  else
    rm -f -- "$INSTALL_DIR/.deployment.json"
  fi
  if [[ "$HAD_DEPLOYMENT_NODE" == true ]]; then
    cp -p "$LOCK_DIR/state/deployment-node" "$INSTALL_DIR/.deployment-node"
  else
    rm -f -- "$INSTALL_DIR/.deployment-node"
  fi
  systemctl --user daemon-reload
  if [[ "$WAS_UPDATE_TIMER_ENABLED" == true ]]; then
    systemctl --user enable --now "$UPDATE_SERVICE.timer" >/dev/null 2>&1
  elif [[ "$WAS_UPDATE_TIMER_ACTIVE" == true ]]; then
    systemctl --user start "$UPDATE_SERVICE.timer" >/dev/null 2>&1
  fi
  if [[ "$WAS_ACTIVE" == true ]]; then
    systemctl --user start "$SERVICE.service"
  else
    systemctl --user disable --now "$SERVICE.service" >/dev/null 2>&1
  fi
  exit "$status"
}
trap rollback_deployment ERR INT TERM

if [[ "$WAS_ACTIVE" == true ]]; then
  systemctl --user stop "$SERVICE.service"
fi
if [[ "$ROOT" != "$INSTALL_DIR" ]]; then
  rsync -a --delete "${RSYNC_SOURCE[@]}" "$ROOT/" "$INSTALL_DIR/"
fi

cd "$INSTALL_DIR"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm || true)"
[[ -n "$NPM_BIN" && -x "$NPM_BIN" ]] || { printf 'npm is required\n' >&2; exit 1; }
"$NPM_BIN" ci --omit=dev --ignore-scripts

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
systemd-analyze --user verify "$UPDATE_UNIT_FILE"
systemd-analyze --user verify "$UPDATE_TIMER_FILE"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"
systemctl --user enable --now "$UPDATE_SERVICE.timer"
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
trap - ERR INT TERM
if [[ "${QQ_AGENT_SOURCE_REVISION:-}" =~ ^[0-9a-f]{40}$ ]]; then
  REVISION="$QQ_AGENT_SOURCE_REVISION"
elif command -v git >/dev/null && git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
  REVISION="$(git -C "$ROOT" rev-parse HEAD)"
  if ! git -C "$ROOT" diff --quiet --ignore-submodules HEAD --; then
    REVISION="${REVISION}-dirty"
  fi
else
  REVISION="source-$(date -u +%Y%m%dT%H%M%SZ)"
fi
printf '%s\n' "$REVISION" > "$DATA_DIR/deployed-revision"
chmod 600 "$DATA_DIR/deployed-revision"
systemctl --user --no-pager status "$SERVICE.service"
MODE="$("$NODE_BIN" -e 'const c=require(process.argv[1]);process.stdout.write(c.runtime.mode)' "$DATA_DIR/config.json")"
printf '\nConsole: http://%s:%s (%s mode)\nToken: %s/manage.sh token\n' "$HOST" "$PORT" "$MODE" "$INSTALL_DIR"
[[ -z "$ROLLBACK_DIR" ]] || printf 'Rollback snapshot: %s\n' "$ROLLBACK_DIR"
