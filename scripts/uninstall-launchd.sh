#!/bin/bash
# Stop the Price Watcher service and remove its LaunchAgent. Your data/ and logs/ are kept.
set -euo pipefail

LABEL="local.costco-price-watcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "Stopped the service."
else
  echo "The service wasn't running."
fi

if [[ -f "$PLIST" ]]; then
  rm -- "${PLIST:?}"
  echo "Removed $PLIST"
fi
echo "Your watch list and price history in data/ are untouched."
