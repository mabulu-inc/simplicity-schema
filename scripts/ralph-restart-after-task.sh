#!/usr/bin/env bash
set -euo pipefail
trap 'exit 0' INT TERM

# ralph-restart-after-task.sh — Wait for current task to complete, then
# kill old ralph and restart with the latest version in a loop.
#
# Usage: ./scripts/ralph-restart-after-task.sh

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Waiting for current ralph iteration to finish..."

HEAD_BEFORE=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)

# Poll until a new commit appears (meaning the current task committed)
while true; do
  HEAD_NOW=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)
  if [[ "$HEAD_NOW" != "$HEAD_BEFORE" ]]; then
    echo "New commit detected: $(git -C "$PROJECT_DIR" log --oneline -1)"
    break
  fi
  sleep 5
done

# Give ralph a moment to push/cleanup, then kill it
sleep 15
echo "Killing old ralph..."
bash "$PROJECT_DIR/scripts/ralph-kill.sh" 2>/dev/null || true
sleep 5

# Discard any leftover unstaged changes from the old ralph
git -C "$PROJECT_DIR" checkout -- . 2>/dev/null || true

echo "Starting new ralph (unlimited iterations)..."
exec bash "$PROJECT_DIR/scripts/ralph.sh" -n 0
