#!/bin/bash
# Double-click this file to run the draft board locally.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install it from https://nodejs.org (choose the LTS version), then run this again."
  echo ""
  read -r -p "  Press Return to close."
  exit 1
fi

PORT="${PORT:-8787}"
node server.js &
SERVER_PID=$!

sleep 1
open "http://localhost:${PORT}"

echo ""
echo "  Close this window (or press Ctrl+C) to stop the draft board."
trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait $SERVER_PID
