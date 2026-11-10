#!/usr/bin/env bash
# PID 1 for the v-harness container.
#
# The gateway runs as a child, not as PID 1: restarting it leaves tenant dsh
# processes alive. Each is the init of its own pid namespace and is reparented
# here, so the next gateway adopts it from the persistent instance registry.
# This supervisor listens on no port, never signals a process group, and reaps
# orphans reparented to PID 1. A zombie whose own parent is still alive (a dsh
# child that dsh has not waited for) belongs to that parent, not to PID 1.
set -uo pipefail

GATEWAY="${VH_GATEWAY_ENTRY:-/opt/v-harness/gateway/server.mjs}"
PID_FILE="${VH_GATEWAY_PID_FILE:-${STATE_ROOT:-/data/.vh}/gateway.pid}"

# node:sqlite is flag-gated on Node 22; the entrypoint probed once already.
SQLITE_FLAGS=()
if [[ -n "${VH_SQLITE_FLAGS:-}" ]]; then
  read -r -a SQLITE_FLAGS <<< "$VH_SQLITE_FLAGS"
fi

stopping=0
gateway_pid=0
sleep_pid=0
delay=1

shutdown() {
  stopping=1
  # Docker signals PID 1 when the whole container is going away. Only this path
  # shuts the gateway down and exits with it; a gateway killed on its own never
  # lands here and is simply restarted.
  if [[ "$gateway_pid" -gt 0 ]]; then
    kill -TERM "$gateway_pid" 2>/dev/null || true
  fi
  if [[ "$sleep_pid" -gt 0 ]]; then
    kill -TERM "$sleep_pid" 2>/dev/null || true
  fi
}
trap shutdown TERM INT

while [[ "$stopping" -eq 0 ]]; do
  started_at=$(date +%s)
  if [[ ${#SQLITE_FLAGS[@]} -gt 0 ]]; then
    node "${SQLITE_FLAGS[@]}" "$GATEWAY" &
  else
    node "$GATEWAY" &
  fi
  gateway_pid=$!
  printf '%s\n' "$gateway_pid" > "$PID_FILE"
  chmod 0600 "$PID_FILE"
  # `wait` returns when the gateway exits; a signal runs the trap first. Only
  # one gateway is ever started, so two copies cannot race for the sockets,
  # session DB or credential files.
  wait "$gateway_pid"
  status=$?
  gateway_pid=0
  rm -f "$PID_FILE"
  if [[ "$stopping" -eq 1 ]]; then
    break
  fi

  printf '[vh-supervisor] gateway exited (status=%s); restarting in %ss\n' "$status" "$delay" >&2
  elapsed=$(( $(date +%s) - started_at ))
  if [[ "$elapsed" -gt 60 ]]; then
    delay=1
  fi
  sleep "$delay" &
  sleep_pid=$!
  wait "$sleep_pid" 2>/dev/null || true
  sleep_pid=0
  delay=$(( delay * 2 ))
  if [[ "$delay" -gt 30 ]]; then
    delay=30
  fi
done

exit 0
