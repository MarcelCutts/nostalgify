#!/bin/bash
# Shared shell supervision; sourcing this file starts no commands or traps.

record_shell_phase() {
  # Bash's coarse clock includes time before the Python supervisor can start.
  # Keep this separate from its JSON events and never log command arguments.
  local NOSTALGIFY_SHELL_SECONDS=$SECONDS
  local NOSTALGIFY_SHELL_DEADLINE=${NOSTALGIFY_COMMAND_DEADLINE:--}
  local NOSTALGIFY_SHELL_REMAINING='-'
  if [ "$NOSTALGIFY_SHELL_DEADLINE" != '-' ]; then
    NOSTALGIFY_SHELL_REMAINING=$((NOSTALGIFY_SHELL_DEADLINE - NOSTALGIFY_SHELL_SECONDS))
  fi
  if [ -n "${NOSTALGIFY_IOS_RESULTS:-}" ]; then
    { printf 'phase=%s boundary=%s seconds=%s deadline=%s remaining=%s requested=%s effective=%s pid=%s exit=%s\n' \
        "$1" "$2" "$NOSTALGIFY_SHELL_SECONDS" "$NOSTALGIFY_SHELL_DEADLINE" \
        "$NOSTALGIFY_SHELL_REMAINING" "${3:--}" "${4:--}" "${5:--}" "${6:--}" \
        >> "$NOSTALGIFY_IOS_RESULTS/shell-timing.log"; } 2>/dev/null || true
  fi
  return 0
}

bounded_command() {
  local NOSTALGIFY_PHASE=$1 NOSTALGIFY_LIMIT=$2
  local NOSTALGIFY_REQUESTED_LIMIT=$2
  shift 2
  local NOSTALGIFY_REMAINING=$((NOSTALGIFY_COMMAND_DEADLINE - SECONDS))
  if [ "$NOSTALGIFY_REMAINING" -le 0 ]; then
    record_shell_phase "$NOSTALGIFY_PHASE" dispatch "$NOSTALGIFY_REQUESTED_LIMIT" 0
    python3 scripts/ios-ci-diagnostics.py refuse --output "$NOSTALGIFY_IOS_RESULTS" \
      --phase "$NOSTALGIFY_PHASE"
    record_shell_phase "$NOSTALGIFY_PHASE" returned "$NOSTALGIFY_REQUESTED_LIMIT" 0 - 124
    return 124
  fi
  if [ "$NOSTALGIFY_LIMIT" -gt "$NOSTALGIFY_REMAINING" ]; then
    NOSTALGIFY_LIMIT=$NOSTALGIFY_REMAINING
  fi
  # Waiting on an asynchronous child lets Bash handle entry-process signals.
  # Never put this function in a pipeline or command substitution: those would
  # hide this PID in a subshell and defer the outer shell's cancellation trap.
  record_shell_phase "$NOSTALGIFY_PHASE" dispatch "$NOSTALGIFY_REQUESTED_LIMIT" "$NOSTALGIFY_LIMIT"
  python3 scripts/ios-ci-diagnostics.py run --output "$NOSTALGIFY_IOS_RESULTS" \
    --phase "$NOSTALGIFY_PHASE" --timeout "$NOSTALGIFY_LIMIT" -- "$@" <&0 &
  NOSTALGIFY_ACTIVE_COMMAND_ID=$!
  record_shell_phase "$NOSTALGIFY_PHASE" spawned "$NOSTALGIFY_REQUESTED_LIMIT" "$NOSTALGIFY_LIMIT" "$NOSTALGIFY_ACTIVE_COMMAND_ID"
  local NOSTALGIFY_COMMAND_STATUS=0 NOSTALGIFY_WRAPPER_ID=$NOSTALGIFY_ACTIVE_COMMAND_ID
  wait "$NOSTALGIFY_WRAPPER_ID" || NOSTALGIFY_COMMAND_STATUS=$?
  NOSTALGIFY_ACTIVE_COMMAND_ID=''
  record_shell_phase "$NOSTALGIFY_PHASE" returned "$NOSTALGIFY_REQUESTED_LIMIT" "$NOSTALGIFY_LIMIT" "$NOSTALGIFY_WRAPPER_ID" "$NOSTALGIFY_COMMAND_STATUS"
  return "$NOSTALGIFY_COMMAND_STATUS"
}

bounded_logged_command() {
  local NOSTALGIFY_PHASE=$1 NOSTALGIFY_LIMIT=$2 NOSTALGIFY_LOG=$3
  shift 3
  # The entire pipeline belongs to the supervised group. pipefail retains the
  # command's failure even when tee succeeds; tee's own failure remains visible.
  # shellcheck disable=SC2016
  bounded_command "$NOSTALGIFY_PHASE" "$NOSTALGIFY_LIMIT" \
    bash -o pipefail -c 'log=$1; shift; "$@" 2>&1 | tee "$log"' \
    ios-ci-log "$NOSTALGIFY_LOG" "$@"
}

warn_diagnostic_failure() {
  printf 'Warning: %s diagnostic collection failed (exit %s); continuing required validation. See command-events.jsonl.\n' "$1" "$2" >&2
}

best_effort_command() {
  bounded_command "$@" || warn_diagnostic_failure "$1" "$?"
}

best_effort_logged_command() {
  bounded_logged_command "$@" || warn_diagnostic_failure "$1" "$?"
}

cancel_validation() {
  local NOSTALGIFY_SIGNAL_STATUS=$1 NOSTALGIFY_SIGNAL_NAME=$2
  # A second signal is allowed to stop finalization; incremental events and the
  # early summary remain available even when the runner forces termination.
  trap 'exit "$NOSTALGIFY_SIGNAL_STATUS"' INT TERM
  if [ -n "${NOSTALGIFY_ACTIVE_COMMAND_ID:-}" ]; then
    kill -s "$NOSTALGIFY_SIGNAL_NAME" "$NOSTALGIFY_ACTIVE_COMMAND_ID" 2>/dev/null || true
    wait "$NOSTALGIFY_ACTIVE_COMMAND_ID" 2>/dev/null || true
    NOSTALGIFY_ACTIVE_COMMAND_ID=''
  fi
  stop_diagnostic_commands
  exit "$NOSTALGIFY_SIGNAL_STATUS"
}

stop_diagnostic_commands() {
  local NOSTALGIFY_DIAGNOSTIC_PID
  # Signal both wrappers first so their bounded group cleanup runs concurrently.
  for NOSTALGIFY_DIAGNOSTIC_PID in "${NOSTALGIFY_STARTUP_WATCHER_ID:-}" "${NOSTALGIFY_APP_LOG_ID:-}"; do
    if [ -n "$NOSTALGIFY_DIAGNOSTIC_PID" ]; then
      kill "$NOSTALGIFY_DIAGNOSTIC_PID" 2>/dev/null || true
    fi
  done
  for NOSTALGIFY_DIAGNOSTIC_PID in "${NOSTALGIFY_STARTUP_WATCHER_ID:-}" "${NOSTALGIFY_APP_LOG_ID:-}"; do
    if [ -n "$NOSTALGIFY_DIAGNOSTIC_PID" ]; then
      wait "$NOSTALGIFY_DIAGNOSTIC_PID" 2>/dev/null || true
    fi
  done
  NOSTALGIFY_STARTUP_WATCHER_ID=''
  NOSTALGIFY_APP_LOG_ID=''
}

begin_collection_budget() {
  # Keep resource cleanup independent of optional collectors exhausting theirs.
  NOSTALGIFY_CLEANUP_DEADLINE=$((SECONDS + 240))
  NOSTALGIFY_COMMAND_DEADLINE=$((NOSTALGIFY_CLEANUP_DEADLINE - 60))
}

begin_resource_cleanup_budget() {
  NOSTALGIFY_COMMAND_DEADLINE=$NOSTALGIFY_CLEANUP_DEADLINE
}
