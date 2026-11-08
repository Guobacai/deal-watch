#!/bin/bash
# Install the Price Watcher service as a LaunchAgent: it starts when you log in and restarts if it stops.
# Settings are read from your environment now and saved into the agent, for example:
#   REMINDER_TIME=08:30 npm run service:install
# Supported: PORT, REMINDER_TIME, RUN_TIMEOUT_MINUTES, NOTIFICATIONS, DATA_DIR, DEDUPE_MINUTES
set -euo pipefail

LABEL="local.costco-price-watcher"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-4000}"

fail() { echo "Error: $*" >&2; exit 1; }
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

[[ "$(uname)" == "Darwin" ]] || fail "this only works on macOS."
NODE="$(command -v node)" || fail "node isn't on your PATH. Install Node.js 22 or newer first."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 22 or newer is needed (found $("$NODE" --version))."
[[ -d "$ROOT/node_modules/tsx" ]] || fail "dependencies aren't installed. Run: npm install"

# Replace an existing install.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Replacing the existing service…"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "something is already using port $PORT. If it's \`npm start\` in a Terminal window, stop it (Ctrl-C) and run this again."
fi

mkdir -p "$ROOT/logs" "$(dirname "$PLIST")"

ENV_XML="    <key>PATH</key><string>$(xml "$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin")</string>"$'\n'
for key in PORT REMINDER_TIME RUN_TIMEOUT_MINUTES NOTIFICATIONS DATA_DIR DEDUPE_MINUTES; do
  if [[ -n "${!key:-}" ]]; then
    ENV_XML+="    <key>$key</key><string>$(xml "${!key}")</string>"$'\n'
  fi
done

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>--import</string>
    <string>tsx</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
$ENV_XML  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$ROOT/logs/service.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$ROOT/logs/service.err.log")</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || fail "the generated $PLIST isn't valid."

launchctl bootstrap "$DOMAIN" "$PLIST"

echo -n "Starting"
for _ in $(seq 1 30); do
  if curl -fsS -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    echo "✓ Price Watcher is running at http://127.0.0.1:$PORT"
    echo "  It starts automatically when you log in, and restarts if it stops."
    echo "  Logs: $ROOT/logs/service.log (errors: service.err.log)"
    echo "  Settings file: $PLIST"
    exit 0
  fi
  echo -n "."
  sleep 0.5
done
echo
fail "the service didn't answer within 15 seconds. Look at $ROOT/logs/service.err.log"
