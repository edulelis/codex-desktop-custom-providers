#!/bin/bash
# patch-codex-app.sh — re-apply the request-layer provider-routing patch to ChatGPT.app.
#
# Fork: https://github.com/edulelis/Better-Codex-App-Custom-Provider-Support
# Local clone: ~/Repositories/Better-Codex-App-Custom-Provider-Support
#
# Safe to run from inside the ChatGPT/Codex desktop app itself: the password is
# requested first via the native macOS admin dialog, then the patch runs fully
# detached — the app is killed, patched, and reopened automatically.
#
# Usage:
#   ~/.codex/bin/patch-codex-app.sh            # pull, patch, reopen
#   ~/.codex/bin/patch-codex-app.sh --check    # dry-run only (no elevation)
#   ~/.codex/bin/patch-codex-app.sh --no-reopen
#   ~/.codex/bin/patch-codex-app.sh --no-pull
#
# Re-run this after every ChatGPT desktop app update (updates replace the patch).

set -u

REPO="$HOME/Repositories/Better-Codex-App-Custom-Provider-Support"
INSTALLER="patch_chatgpt_provider_routing.py"
APP="/Applications/ChatGPT.app"
LOG_DIR="$HOME/.codex/logs"
LOG="$LOG_DIR/patch-codex-app.log"
PYTHON="${PYTHON:-/opt/homebrew/bin/python3}"
# Node for npx: prefer nvm's current version, fall back to npx on PATH.
NODE_BIN=""
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
fi
if [[ -z "$NODE_BIN" ]] && command -v npx >/dev/null 2>&1; then
  NODE_BIN="$(dirname "$(command -v npx)")"
fi
BACKUP_DIR="$HOME/Applications/ChatGPT Patch Backups"

NO_REOPEN=0
NO_PULL=0
CHECK=0
INNER=0
for arg in "$@"; do
  case "$arg" in
    --no-reopen) NO_REOPEN=1 ;;
    --no-pull)   NO_PULL=1 ;;
    --check)     CHECK=1 ;;
    --inner)     INNER=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

if [[ $INNER -eq 1 ]]; then
  :  # inner phase dispatched at the end, after functions are defined
fi

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ---------- preflight ----------
if [[ ! -d "$REPO" || ! -f "$REPO/$INSTALLER" ]]; then
  log "ERROR: installer not found at $REPO/$INSTALLER"
  exit 1
fi
if [[ ! -d "$APP" ]]; then
  log "ERROR: $APP not found"
  exit 1
fi

# ---------- optional refresh of the fork ----------
if [[ $CHECK -eq 0 && $NO_PULL -eq 0 ]]; then
  if git -C "$REPO" fetch origin --quiet 2>>"$LOG"; then
    if git -C "$REPO" status --porcelain --branch | head -1 | grep -q '\[behind'; then
      if git -C "$REPO" pull --ff-only origin main >>"$LOG" 2>&1; then
        log "fork updated via git pull --ff-only"
      else
        log "WARN: pull failed, continuing with local copy"
      fi
    else
      log "fork already up to date"
    fi
  else
    log "WARN: git fetch failed (offline?), continuing with local copy"
  fi
fi

# ---------- inner phase: kill -> elevated patch -> reopen ----------
inner_phase() {
  log "inner phase started (pid $$, detached from caller)"
  sleep 2  # let the calling session/app terminate gracefully first

  # Elevated patch via the native macOS admin dialog. Runs as root:
  # root bypasses the App-Management/TCC EPERM that user-level writes hit on
  # the registered app bundle. The patcher stops app processes itself.
  local result
  result=$(osascript <<EOF 2>>"$LOG"
set shCmd to "export HOME=$HOME CODEX_HOME=$HOME/.codex PATH=$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; $PYTHON '$REPO/$INSTALLER' 2>&1; rc=\$?; chown -R $(id -u):$(id -g) '$BACKUP_DIR' 2>/dev/null; exit \$rc"
try
    do shell script shCmd with administrator privileges with prompt "Patch ChatGPT.app with custom provider routing?"
    return "PATCH-OK"
on error errMsg number errNum
    return "PATCH-FAIL num=" & errNum & " | " & errMsg
end try
EOF
) || result="PATCH-FAIL osascript crashed"
  echo "$result" | tail -3 | tee -a "$LOG"

  if [[ "$result" == *PATCH-OK* ]]; then
    log "patch applied successfully"
    if [[ $NO_REOPEN -eq 0 ]]; then
      sleep 1
      open -a "$APP"
      log "ChatGPT.app reopened"
    fi
    exit 0
  else
    log "ERROR: patch did not apply. Full log: $LOG"
    exit 1
  fi
}

# ---------- dry-run ----------
if [[ $CHECK -eq 1 ]]; then
  export HOME CODEX_HOME="$HOME/.codex" PATH="$NODE_BIN:/opt/homebrew/bin:/usr/bin:/bin"
  log "dry-run requested"
  "$PYTHON" "$REPO/$INSTALLER" --dry-run 2>&1 | tee -a "$LOG"
  exit $?
fi

# ---------- native admin password FIRST (validates + warms auth cache) ----------
if [[ $INNER -eq 0 ]]; then
  log "requesting admin authorization via native dialog"
  auth_probe=$(osascript -e 'do shell script "true" with administrator privileges with prompt "Patch ChatGPT.app needs administrator permission to modify the app bundle."' 2>&1)
  if [[ $? -ne 0 ]]; then
    log "ERROR: admin authorization denied or failed: $auth_probe"
    exit 1
  fi
  log "admin authorization granted"
fi

# ---------- decide: inline or detached ----------
# If we are running from inside ChatGPT.app (a Codex desktop session) or the
# app is currently running, detach first so the patch survives the kill.
if [[ $INNER -eq 0 ]]; then
  INSIDE_APP=0
  pid=$$
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null) || break
    case "$comm" in
      *ChatGPT.app*) INSIDE_APP=1; break ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [[ -z "$pid" || "$pid" == "1" || "$pid" == "0" ]] && break
  done
  APP_RUNNING=0
  pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 && APP_RUNNING=1

  if [[ $INSIDE_APP -eq 1 || $APP_RUNNING -eq 1 ]]; then
    log "detaching: app running=$APP_RUNNING, launched-from-app=$INSIDE_APP"
    nohup bash "${BASH_SOURCE[0]}" --inner --no-pull >>"$LOG" 2>&1 &
    disown
    echo "Patch running detached (log: $LOG)."
    echo "The ChatGPT app will be closed, patched, and reopened automatically."
    echo "If you launched this from a Codex session inside the app, that session"
    echo "will end now — this is expected."
    exit 0
  fi
fi

# App not running, not launched from it, or --inner: patch now.
inner_phase
