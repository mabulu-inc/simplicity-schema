#!/usr/bin/env bash
set -euo pipefail

# ralph-monitor.sh — Minimal ralph status display.
#
# Usage:
#   ./scripts/ralph-monitor.sh           # one-shot status
#   ./scripts/ralph-monitor.sh -w        # watch mode (refresh every 5s)
#   ./scripts/ralph-monitor.sh -w -i 3   # watch mode, refresh every 3s

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DIR="$PROJECT_DIR/docs/tasks"
LOG_DIR="$PROJECT_DIR/.ralph-logs"
WATCH=false
INTERVAL=5

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--watch)    WATCH=true; shift ;;
    -i|--interval) INTERVAL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ralph-monitor.sh [-w] [-i seconds]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Helpers ---

get_active_log() {
  ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -1
}

format_duration() {
  local secs="$1"
  if [[ $secs -lt 60 ]]; then
    echo "${secs}s"
  elif [[ $secs -lt 3600 ]]; then
    echo "$((secs / 60))m $((secs % 60))s"
  else
    echo "$((secs / 3600))h $((secs % 3600 / 60))m"
  fi
}

# Detect phase from recent log activity. Returns "phase|timestamp" where
# timestamp is the unix time of the first log line matching that phase.
detect_phase() {
  local log="$1"
  [[ -f "$log" ]] || { echo "BOOT|$(date +%s)"; return; }
  set +e

  local last_messages
  last_messages=$(tail -100 "$log" 2>/dev/null || true)

  local phase=""

  if echo "$last_messages" | grep -q '"command":"git commit' 2>/dev/null; then
    phase="Committing"
  elif echo "$last_messages" | grep -q '"command":"pnpm check' 2>/dev/null; then
    phase="Verifying"
  elif echo "$last_messages" | grep -qE '"command":"pnpm (vitest|test)' 2>/dev/null; then
    phase="Running tests"
  elif echo "$last_messages" | grep -qE '"name":"(Edit|Write)"' 2>/dev/null; then
    local last_edit_file
    last_edit_file=$(echo "$last_messages" | grep -oE '"file_path":"[^"]*"' | tail -1 | sed 's/"file_path":"//;s/"//' || true)
    if echo "$last_edit_file" | grep -qE '(test|spec)\.' 2>/dev/null; then
      phase="Writing tests"
    else
      phase="Implementing"
    fi
  elif echo "$last_messages" | grep -qE '"name":"(Read|Grep|Glob)"' 2>/dev/null; then
    local read_targets
    read_targets=$(echo "$last_messages" | grep -o '"file_path":"[^"]*"' | tail -3 | sed 's/"file_path":"//;s/"//')
    if echo "$read_targets" | grep -qE '(tasks/|PRD|CLAUDE)' 2>/dev/null; then
      phase="Reading PRD"
    else
      phase="Reading code"
    fi
  else
    phase="Starting"
  fi

  # Find when this phase started by scanning backward through the log.
  # We look for the transition point — the last line that does NOT match
  # the current phase pattern.
  local phase_start
  local log_lines
  log_lines=$(wc -l < "$log" | xargs)

  # Use log file mtime as a rough "last activity" timestamp
  local log_mtime
  log_mtime=$(stat -f %m "$log" 2>/dev/null || stat -c %Y "$log" 2>/dev/null || echo 0)

  # Estimate phase duration from how many of the last N lines match
  local match_count=0
  local sample=50
  local tail_block
  tail_block=$(tail -${sample} "$log" 2>/dev/null || true)

  case "$phase" in
    "Committing")     match_count=$(echo "$tail_block" | grep -c '"command":"git' 2>/dev/null || echo 0) ;;
    "Verifying")      match_count=$(echo "$tail_block" | grep -c '"command":"pnpm' 2>/dev/null || echo 0) ;;
    "Running tests")  match_count=$(echo "$tail_block" | grep -cE '"command":"pnpm (vitest|test)' 2>/dev/null || echo 0) ;;
    "Writing tests")  match_count=$(echo "$tail_block" | grep -cE '"name":"(Edit|Write)"' 2>/dev/null || echo 0) ;;
    "Implementing")   match_count=$(echo "$tail_block" | grep -cE '"name":"(Edit|Write)"' 2>/dev/null || echo 0) ;;
    "Reading PRD")    match_count=$(echo "$tail_block" | grep -cE '"name":"(Read|Grep|Glob)"' 2>/dev/null || echo 0) ;;
    "Reading code")   match_count=$(echo "$tail_block" | grep -cE '"name":"(Read|Grep|Glob)"' 2>/dev/null || echo 0) ;;
    *)                match_count=1 ;;
  esac

  # Estimate: if log has been active for T seconds total and we're M/S into
  # matching lines in the tail, scale proportionally
  local log_start_mtime
  log_start_mtime=$(stat -f %B "$log" 2>/dev/null || stat -c %W "$log" 2>/dev/null || echo "$log_mtime")
  local total_elapsed=$(( log_mtime - log_start_mtime ))
  [[ $total_elapsed -lt 1 ]] && total_elapsed=1

  local phase_secs=0
  if [[ $log_lines -gt 0 && $match_count -gt 0 ]]; then
    phase_secs=$(( (match_count * total_elapsed) / log_lines ))
    [[ $phase_secs -lt 1 ]] && phase_secs=1
  fi

  echo "${phase}|${phase_secs}"
  set -e
}

render() {
  set +e
  local ralph_pid claude_pid active_log
  ralph_pid=$(pgrep -f "ralph.sh" 2>/dev/null | head -1 || true)
  claude_pid=$(pgrep -f "claude --print.*Ralph Loop" 2>/dev/null | head -1 || true)
  active_log=$(get_active_log)

  # Task counts
  local done_count=0 todo_count=0
  for f in "$TASKS_DIR"/T-*.md; do
    [[ -f "$f" ]] || continue
    if grep -q '^\- \*\*Status\*\*: DONE' "$f" 2>/dev/null; then
      done_count=$((done_count + 1))
    elif grep -q '^\- \*\*Status\*\*: TODO' "$f" 2>/dev/null; then
      todo_count=$((todo_count + 1))
    fi
  done
  local total=$((done_count + todo_count))
  local pct=0
  [[ $total -gt 0 ]] && pct=$(( (done_count * 100) / total ))

  # Progress bar
  local bar_width=20 filled=0
  [[ $total -gt 0 ]] && filled=$(( (done_count * bar_width) / total ))
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=filled; i<bar_width; i++)); do bar+="░"; done

  # Status
  local status status_color
  if [[ -n "$claude_pid" ]]; then
    status="RUNNING"
    status_color="$GREEN"
  elif [[ -n "$ralph_pid" ]]; then
    status="BETWEEN TASKS"
    status_color="$YELLOW"
  else
    status="STOPPED"
    status_color="$RED"
  fi

  # Current task
  local task="—" title=""
  if [[ -n "$active_log" ]]; then
    task=$(basename "$active_log" | grep -oE 'T-[0-9]+' || echo "—")
  fi
  if [[ "$task" != "—" && -f "$TASKS_DIR/${task}.md" ]]; then
    title=$(head -1 "$TASKS_DIR/${task}.md" | sed "s/^# ${task}: //")
  fi

  # Phase + duration
  local phase="—" phase_dur=""
  if [[ -n "$active_log" && -n "$claude_pid" ]]; then
    local phase_info
    phase_info=$(detect_phase "$active_log")
    phase=$(echo "$phase_info" | cut -d'|' -f1)
    local phase_secs
    phase_secs=$(echo "$phase_info" | cut -d'|' -f2)
    if [[ $phase_secs -gt 0 ]]; then
      phase_dur=" $(format_duration "$phase_secs")"
    fi
  fi

  # Idle check
  local idle_warning=""
  if [[ -n "$active_log" && -f "$active_log" && -n "$claude_pid" ]]; then
    local log_mtime now_ts idle
    log_mtime=$(stat -f %m "$active_log" 2>/dev/null || stat -c %Y "$active_log" 2>/dev/null || echo 0)
    now_ts=$(date +%s)
    idle=$(( now_ts - log_mtime ))
    if [[ $idle -gt 60 ]]; then
      idle_warning=" ${YELLOW}(idle $(format_duration $idle))${RESET}"
    fi
  fi

  # Render
  $WATCH && clear

  echo -e "${BOLD}ralph${RESET}  ${status_color}${status}${RESET}${idle_warning}"
  echo -e "${GREEN}${bar}${RESET} ${done_count}/${total} (${pct}%)"
  if [[ "$task" != "—" ]]; then
    echo -e "${CYAN}${task}${RESET} ${title}"
    if [[ "$phase" != "—" ]]; then
      echo -e "${DIM}${phase}${phase_dur}${RESET}"
    fi
  fi

  $WATCH && echo -e "\n${DIM}Ctrl+C to exit${RESET}"
  set -e
}

if $WATCH; then
  while true; do
    render
    sleep "$INTERVAL"
  done
else
  render
fi
