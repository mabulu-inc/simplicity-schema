#!/usr/bin/env bash
set -euo pipefail

# ralph-monitor.sh — Watch ralph's progress in real time.
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

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
RESET='\033[0m'

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--watch)    WATCH=true; shift ;;
    -i|--interval) INTERVAL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ralph-monitor.sh [-w] [-i seconds]"
      echo "  -w, --watch     Continuous refresh"
      echo "  -i, --interval  Refresh interval in seconds (default: 5)"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Helpers ---

count_by_status() {
  local status="$1" count=0
  for f in "$TASKS_DIR"/T-*.md; do
    [[ -f "$f" ]] || continue
    grep -q "^\- \*\*Status\*\*: ${status}" "$f" 2>/dev/null && count=$((count + 1))
  done
  echo "$count"
}

get_active_log() {
  ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -1
}

get_ralph_pid() {
  pgrep -f "ralph.sh" 2>/dev/null | head -1 || true
}

get_claude_pid() {
  pgrep -f "claude --print.*Ralph Loop" 2>/dev/null | head -1 || true
}

# Detect current phase from log content
detect_phase() {
  local log="$1"
  [[ -f "$log" ]] || { echo "BOOT"; return; }
  set +e

  local last_messages
  last_messages=$(tail -100 "$log" 2>/dev/null || true)

  # Check from most specific to least
  if echo "$last_messages" | grep -q '"command":"git commit' 2>/dev/null; then
    echo "COMMIT"
  elif echo "$last_messages" | grep -q '"command":"pnpm check' 2>/dev/null; then
    # Is it the final check or a mid-implementation check?
    local check_count
    check_count=$(grep -c '"command":"pnpm check' "$log" 2>/dev/null || echo 0)
    if [[ $check_count -gt 1 ]]; then
      echo "VERIFY (final)"
    else
      echo "VERIFY"
    fi
  elif echo "$last_messages" | grep -qE '"command":"pnpm (vitest|test)' 2>/dev/null; then
    echo "TESTING"
  elif echo "$last_messages" | grep -qE '"name":"(Edit|Write)"' 2>/dev/null; then
    # Check if editing test files or implementation files
    local last_edit_file
    last_edit_file=$(echo "$last_messages" | grep -oE '"file_path":"[^"]*"' | tail -1 | sed 's/"file_path":"//;s/"//' || true)
    if echo "$last_edit_file" | grep -qE '(test|spec)\.' 2>/dev/null; then
      echo "RED (writing tests)"
    else
      echo "GREEN (implementing)"
    fi
  elif echo "$last_messages" | grep -qE '"name":"(Read|Grep|Glob)"' 2>/dev/null; then
    # Check if still in boot (reading task files/PRD) or researching mid-task
    local read_targets
    read_targets=$(echo "$last_messages" | grep -o '"file_path":"[^"]*"' | tail -3 | sed 's/"file_path":"//;s/"//')
    if echo "$read_targets" | grep -qE '(tasks/|PRD|CLAUDE)' 2>/dev/null; then
      echo "BOOT"
    else
      echo "READING"
    fi
  else
    echo "BOOT"
  fi
  set -e
}

# Analyze current iteration efficiency
analyze_iteration() {
  local log="$1"
  [[ -f "$log" ]] || return

  # Disable errexit inside this function — grep returns 1 on no match
  set +e

  local lines size
  lines=$(wc -l < "$log" | xargs)
  size=$(wc -c < "$log" | xargs)

  # Count tool types — use grep -a to force text mode on jsonl files
  local read_count edit_count write_count bash_count grep_count glob_count
  read_count=$(grep -a '"name":"Read"' "$log" 2>/dev/null | wc -l | tr -d ' ')
  edit_count=$(grep -a '"name":"Edit"' "$log" 2>/dev/null | wc -l | tr -d ' ')
  write_count=$(grep -a '"name":"Write"' "$log" 2>/dev/null | wc -l | tr -d ' ')
  bash_count=$(grep -a '"name":"Bash"' "$log" 2>/dev/null | wc -l | tr -d ' ')
  grep_count=$(grep -a '"name":"Grep"' "$log" 2>/dev/null | wc -l | tr -d ' ')
  glob_count=$(grep -a '"name":"Glob"' "$log" 2>/dev/null | wc -l | tr -d ' ')

  # Shell anti-patterns
  local shell_reads
  shell_reads=$(grep -ao '"command":"[^"]*"' "$log" 2>/dev/null | grep -E '(cat |head |tail |grep )' | wc -l | tr -d ' ')

  # pnpm check count
  local check_count test_count
  check_count=$(grep -a '"command":"pnpm check' "$log" 2>/dev/null | wc -l | tr -d ' ')
  test_count=$(grep -a '"command":"pnpm vitest' "$log" 2>/dev/null | wc -l | tr -d ' ')

  # Commit count
  local commit_count
  commit_count=$(grep -a '"command":"git commit' "$log" 2>/dev/null | wc -l | tr -d ' ')

  echo -e "  ${DIM}── Iteration Health ──${RESET}"
  echo -e "  Context: ${lines} exchanges, $(( size / 1024 ))KB"
  echo -e "  Tools:   Read:${read_count} Edit:${edit_count} Write:${write_count} Bash:${bash_count} Grep:${grep_count} Glob:${glob_count}"

  # Checks
  if [[ $test_count -gt 0 || $check_count -gt 0 ]]; then
    echo -e "  Verify:  ${GREEN}${test_count} targeted tests, ${check_count} full checks${RESET}"
  else
    echo -e "  Verify:  ${YELLOW}none yet${RESET}"
  fi

  if [[ $commit_count -gt 0 ]]; then
    echo -e "  Commits: ${GREEN}${commit_count}${RESET}"
  fi

  # Warnings
  if [[ $shell_reads -gt 0 ]]; then
    echo -e "  ${YELLOW}⚠ ${shell_reads} shell reads (cat/head/tail/grep) — should use Read/Grep tools${RESET}"
  fi
  if [[ $lines -gt 150 && $check_count -eq 0 ]]; then
    echo -e "  ${YELLOW}⚠ ${lines} exchanges without running pnpm check${RESET}"
  fi
  if [[ $size -gt 1000000 ]]; then
    echo -e "  ${RED}⚠ Large context ($(( size / 1024 ))KB) — risk of running out of turns${RESET}"
  fi

  set -e
}

# Show history of completed tasks with efficiency stats
show_task_history() {
  local task_id="$1"
  local logs
  logs=$(ls "$LOG_DIR"/${task_id}-*.jsonl 2>/dev/null || true)
  [[ -z "$logs" ]] && return

  local attempt=0 total_lines=0
  for log in $logs; do
    attempt=$((attempt + 1))
    local l
    l=$(wc -l < "$log" | xargs)
    total_lines=$((total_lines + l))
  done
  echo "${attempt} attempt(s), ${total_lines} total exchanges"
}

# Recent task completion stats
show_recent_stats() {
  echo -e "  ${DIM}── Recent Task Stats ──${RESET}"

  # Get last 5 completed task commits
  local task_commits
  task_commits=$(git -C "$PROJECT_DIR" log --oneline -20 2>/dev/null | grep -E '^[a-f0-9]+ T-[0-9]+:' | head -5)

  if [[ -z "$task_commits" ]]; then
    echo -e "  ${DIM}(no completed tasks)${RESET}"
    return
  fi

  echo "$task_commits" | while IFS= read -r line; do
    local sha task_id
    sha=$(echo "$line" | cut -d' ' -f1)
    task_id=$(echo "$line" | grep -oE 'T-[0-9]+' | head -1)

    # Count attempts for this task
    local attempts
    attempts=$(ls "$LOG_DIR"/${task_id}-*.jsonl 2>/dev/null | wc -l | xargs)

    # Check if it was a single commit (good) or split (bad)
    local mark_commit
    mark_commit=$(git -C "$PROJECT_DIR" log --oneline -20 2>/dev/null | grep -c "${task_id}:" || echo 0)

    local efficiency_icon
    if [[ $attempts -eq 1 && $mark_commit -le 1 ]]; then
      efficiency_icon="${GREEN}●${RESET}"  # clean single iteration
    elif [[ $attempts -le 2 ]]; then
      efficiency_icon="${YELLOW}●${RESET}"  # acceptable
    else
      efficiency_icon="${RED}●${RESET}"     # inefficient
    fi

    local commit_icon
    if [[ $mark_commit -gt 1 ]]; then
      commit_icon=" ${RED}(split commit)${RESET}"
    else
      commit_icon=""
    fi

    echo -e "  ${efficiency_icon} ${line} — ${attempts} attempt(s)${commit_icon}"
  done
}

render() {
  local ralph_pid claude_pid active_log
  ralph_pid=$(get_ralph_pid)
  claude_pid=$(get_claude_pid)
  active_log=$(get_active_log)

  local done_count todo_count total
  done_count=$(count_by_status DONE)
  todo_count=$(count_by_status TODO)
  total=$((done_count + todo_count))

  # Progress bar
  local bar_width=30
  local filled=0
  if [[ $total -gt 0 ]]; then
    filled=$(( (done_count * bar_width) / total ))
  fi
  local empty=$((bar_width - filled))
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++)); do bar+="░"; done
  local pct=0
  if [[ $total -gt 0 ]]; then
    pct=$(( (done_count * 100) / total ))
  fi

  # Status
  local status_label status_color
  if [[ -n "$claude_pid" ]]; then
    status_label="RUNNING"
    status_color="$GREEN"
  elif [[ -n "$ralph_pid" ]]; then
    status_label="BETWEEN ITERATIONS"
    status_color="$YELLOW"
  else
    status_label="STOPPED"
    status_color="$RED"
  fi

  # Current task from active log filename
  local current_task="—"
  if [[ -n "$active_log" ]]; then
    current_task=$(basename "$active_log" | grep -oE 'T-[0-9]+' || echo "—")
  fi

  # Task title
  local task_title=""
  if [[ "$current_task" != "—" ]]; then
    local task_file="$TASKS_DIR/${current_task}.md"
    if [[ -f "$task_file" ]]; then
      task_title=$(head -1 "$task_file" | sed "s/^# ${current_task}: //")
    fi
  fi

  # Phase detection
  local phase="—"
  if [[ -n "$active_log" && -n "$claude_pid" ]]; then
    phase=$(detect_phase "$active_log")
  fi

  # Latest activity from log
  local last_tool="" last_file="" last_cmd="" idle_secs=0
  if [[ -n "$active_log" && -f "$active_log" ]]; then
    last_tool=$(tail -50 "$active_log" 2>/dev/null | grep -o '"name":"[^"]*"' | tail -1 | sed 's/"name":"//;s/"//' || true)
    last_file=$(tail -50 "$active_log" 2>/dev/null | grep -o '"file_path":"[^"]*"' | tail -1 | sed 's/"file_path":"//;s/"//' || true)
    last_cmd=$(tail -50 "$active_log" 2>/dev/null | grep -o '"command":"[^"]*"' | tail -1 | sed 's/"command":"//;s/"//' | cut -c1-70 || true)

    local log_mtime
    log_mtime=$(stat -f %m "$active_log" 2>/dev/null || stat -c %Y "$active_log" 2>/dev/null || echo 0)
    idle_secs=$(( $(date +%s) - log_mtime ))
  fi

  # Last claude message
  local last_message=""
  if [[ -n "$active_log" && -f "$active_log" ]]; then
    last_message=$(tail -100 "$active_log" 2>/dev/null | grep '"type":"text"' | grep -oE '"text":"[^"]{10,150}"' | tail -1 | sed 's/"text":"//;s/"$//' || true)
  fi

  # Render
  if $WATCH; then
    clear
  fi

  echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║               RALPH MONITOR                          ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  Status:   ${status_color}${status_label}${RESET}"
  echo -e "  Task:     ${CYAN}${current_task}${RESET} ${task_title}"
  echo -e "  Phase:    ${MAGENTA}${phase}${RESET}"
  echo -e "  Progress: ${GREEN}${bar}${RESET} ${done_count}/${total} (${pct}%)"
  echo ""

  # Current activity
  if [[ -n "$claude_pid" ]]; then
    echo -e "  ${DIM}── Current Activity ──${RESET}"
    if [[ -n "$last_cmd" ]]; then
      echo -e "  Tool:     ${CYAN}${last_tool}${RESET}"
      echo -e "  Command:  ${DIM}${last_cmd}${RESET}"
    elif [[ -n "$last_file" ]]; then
      echo -e "  Tool:     ${CYAN}${last_tool}${RESET}"
      echo -e "  File:     ${DIM}$(basename "$last_file")${RESET}"
    elif [[ -n "$last_tool" ]]; then
      echo -e "  Tool:     ${CYAN}${last_tool}${RESET}"
    fi
    if [[ -n "$last_message" ]]; then
      echo -e "  Claude:   ${DIM}${last_message}${RESET}"
    fi
    if [[ $idle_secs -gt 10 ]]; then
      local idle_label="${idle_secs}s ago"
      if [[ $idle_secs -gt 60 ]]; then
        idle_label="$((idle_secs / 60))m $((idle_secs % 60))s ago"
      fi
      echo -e "  Last I/O: ${YELLOW}${idle_label}${RESET}"
    fi
    echo ""

    # Iteration health
    if [[ -n "$active_log" ]]; then
      analyze_iteration "$active_log"
      echo ""
    fi
  fi

  # Recent task stats
  show_recent_stats
  echo ""

  # Logs
  if [[ -d "$LOG_DIR" ]]; then
    local log_count today_count
    log_count=$(ls "$LOG_DIR"/*.jsonl 2>/dev/null | wc -l | xargs)
    today_count=$(find "$LOG_DIR" -name "*.jsonl" -newer "$LOG_DIR/../package.json" -mtime -1 2>/dev/null | wc -l | xargs)
    echo -e "  ${DIM}── Logs ──${RESET}"
    echo -e "  Total: ${log_count} iterations  Today: ${today_count}"
    if [[ -n "$active_log" ]]; then
      echo -e "  Active: $(basename "$active_log")"
    fi
  fi

  if $WATCH; then
    echo ""
    echo -e "  ${DIM}Refreshing every ${INTERVAL}s — Ctrl+C to exit${RESET}"
  fi
}

if $WATCH; then
  while true; do
    render
    sleep "$INTERVAL"
  done
else
  render
fi
