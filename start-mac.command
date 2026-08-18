#!/bin/bash
# Double-click this to run the draft board on macOS.
# If Node.js isn't installed it falls back to the standalone HTML file, which
# needs nothing at all -- so this should always get you a working board.
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js isn't installed on this computer."
  echo ""
  if [ -f "DraftBoard-offline.html" ]; then
    echo "  That's fine - opening the standalone version instead."
    echo "  It does everything except copy picks to a Google Sheet."
    echo ""
    open "DraftBoard-offline.html"
  else
    echo "  Open DraftBoard-offline.html in your browser, or install Node.js"
    echo "  from https://nodejs.org if you want the Google Sheet backup."
  fi
  echo ""
  read -r -p "  Press Return to close."
  exit 0
fi

echo ""
echo "  Starting the draft board..."
echo "  Your browser will open at http://localhost:${PORT}"
echo ""
echo "  Keep this window open during the draft. Close it to stop."
echo ""

node server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

sleep 1.5
open "http://localhost:${PORT}"
wait $SERVER_PID
