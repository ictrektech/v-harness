#!/usr/bin/env bash
# docker/vos-dev/vos-dev.sh — debug this source tree inside VOS, without an image build.
#
# Starts a dev container from the installed application's own image, runs the
# gateway and every tenant dsh process from the mounted checkout, and points the
# platform's Traefik at that container with a temporary dynamic route. The
# installed app keeps running untouched; removing the route hands platform
# traffic back to it.
#
# Usage:
#   make vos-dev          start, wait for health, install the route, follow logs
#   make vos-dev-down     remove the route and stop the container
#   make vos-dev-logs     follow the container log
#   make vos-dev-status   container, health and route state
#   make vos-dev-build    rebuild the Host artifact tree in a running container
#   make vos-dev-shell    shell inside the container
#
# The first start installs the workspace and builds the artifact tree inside the
# container; stopping and starting reuse both, because they live in the
# container's own filesystem under /usr/local/share/v-harness/src. `vos-dev.sh
# reset` removes the container, so the next start rebuilds from scratch, which
# is also how a file deleted in the checkout leaves the copy.
#
# Environment overrides:
#   VOS_DEV_PORT(38092)             host port for the dev gateway
#   VH_DEV_BASE_IMAGE               image to run; defaults to the installed app's
#   VH_DEV_STAGE_DIR                data and compose state, default ~/dev/build/v-harness/vos-dev
#   VH_DEV_HEALTH_TIMEOUT(2400)     seconds to wait for the first install and build
#   VH_DEV_SKIP_INSTALL(0)          reuse the workspace install already in the container
#   VH_DEV_SKIP_BUILD(0)            reuse the artifact tree already in the container
#   VH_DEV_WATCH(1)                 keep client bundles and the shell rebuilding
#   VH_DEV_WATCH_GATEWAY            gateway launcher, defaults to a watch restart
#   VH_DEV_NPM_REGISTRY             registry for the install inside the container
#   VH_DEV_REFRESH_ENV(0)           re-read the installed app's environment on start
#   VOS_TRAEFIK_CONTAINER(traefik)  VOS_HOST_GW_IP(172.17.0.1)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker/vos-dev/docker-compose.yml"
ROUTE_TMPL="docker/vos-dev/traefik.dev.yml"
APP_ID="com.ictrek.v-harness"
APP_NAME="${APP_ID//./-}"
SERVICE="v-harness-dev"
PORT="${VOS_DEV_PORT:-38092}"
HOST_GW="${VOS_HOST_GW_IP:-172.17.0.1}"
TRAEFIK_CONTAINER="${VOS_TRAEFIK_CONTAINER:-traefik}"
ROUTE_FILE="/etc/traefik/dynamic-conf/${APP_ID}.dev.yml"
STAGE_DIR="${VH_DEV_STAGE_DIR:-$HOME/dev/build/v-harness/vos-dev}"
DATA_DIR="$STAGE_DIR/data"
ENV_FILE="$STAGE_DIR/compose.env"

# Settings the dev container owns. Everything else the installed app is given is
# a platform or sibling-service address, and the debugged instance needs the
# same ones.
ENV_DENY='^(PATH|HOME|HOSTNAME|PWD|OLDPWD|SHLVL|TERM|_|NODE_VERSION|YARN_VERSION|NODE_ENV|PORT|DATA_ROOT|STATE_ROOT|DSH_BIN|NPM_CONFIG_REGISTRY|COREPACK_NPM_REGISTRY|LANG|LC_ALL)='

log() { printf '\033[36m[vos-dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[vos-dev] %s\n' "$*" >&2; }
die() { printf '\033[31m[vos-dev][ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

compose() { docker compose -p vh-vos-dev -f "$COMPOSE_FILE" "$@"; }

# The installed application, not this container: `v-harness-dev` does not match
# the platform's `vos-app-<id>-<instance>-v-harness-(amd|arm)-1` naming.
app_container() {
  docker ps --format '{{.Names}}' \
    | grep -E '^vos-app-com-ictrek-v-harness-.*-v-harness-(amd|arm)-1$' \
    | head -n1
}

ensure_port_free() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    die "port $PORT is already in use; stop whatever holds it or run with VOS_DEV_PORT=<free port>"
  fi
}

# Export what the compose file interpolates, and refresh the environment the
# installed app runs with when it is not there yet.
prepare() {
  mkdir -p "$DATA_DIR" 2>/dev/null \
    || die "cannot create $DATA_DIR; run with VH_DEV_STAGE_DIR=<writable directory>"
  local installed
  installed="$(app_container || true)"
  if [ -z "${VH_DEV_BASE_IMAGE:-}" ]; then
    if [ -n "$installed" ]; then
      VH_DEV_BASE_IMAGE="$(docker inspect "$installed" --format '{{.Config.Image}}')"
    else
      VH_DEV_BASE_IMAGE="v-harness-dev:unresolved"
    fi
  fi
  export VH_DEV_BASE_IMAGE
  export VH_DEV_SOURCE="$ROOT_DIR"
  export VH_DEV_DATA_DIR="$DATA_DIR"
  export VH_DEV_ENV_FILE="$ENV_FILE"
  export VOS_DEV_PORT="$PORT"
  if [ -n "$installed" ] && { [ ! -f "$ENV_FILE" ] || [ "${VH_DEV_REFRESH_ENV:-0}" = 1 ]; }; then
    log "copying the platform environment of $installed"
    {
      printf '# Written by docker/vos-dev/vos-dev.sh from %s\n' "$installed"
      docker inspect "$installed" --format '{{range .Config.Env}}{{println .}}{{end}}' \
        | grep -Ev "$ENV_DENY" || true
    } > "$ENV_FILE"
  fi
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
}

route_on() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$TRAEFIK_CONTAINER"; then
    warn "no Traefik container $TRAEFIK_CONTAINER: no route written, use http://127.0.0.1:${PORT}/app/${APP_ID}/"
    return 0
  fi
  sed -e "s|__NAME__|$APP_NAME|g" -e "s|__APP_ID__|$APP_ID|g" \
      -e "s|__HOST__|$HOST_GW|g" -e "s|__PORT__|$PORT|g" "$ROUTE_TMPL" \
    | docker exec -i "$TRAEFIK_CONTAINER" sh -c "cat > '$ROUTE_FILE'"
  log "route enabled: /app/${APP_ID} and /__vh -> http://${HOST_GW}:${PORT}"
}

route_off() {
  docker ps --format '{{.Names}}' | grep -qx "$TRAEFIK_CONTAINER" || return 0
  docker exec -i "$TRAEFIK_CONTAINER" sh -c "rm -f '$ROUTE_FILE'" 2>/dev/null || true
  log "route removed; the platform serves the installed app again"
}

# The container's own healthcheck is the primary answer: it proves the gateway
# inside the container, which a published-port probe does not (a host whose
# loopback reaches the port still cannot tell a proxy from the app).
health_ok() {
  local id
  id="$(compose ps -q "$SERVICE" 2>/dev/null | head -n1)"
  if [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ]; then
    return 0
  fi
  curl -fsS -m 3 "http://127.0.0.1:${PORT}/__vh/health" >/dev/null 2>&1
}

wait_healthy() {
  local timeout="${VH_DEV_HEALTH_TIMEOUT:-2400}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if health_ok; then
      [ "$waited" -gt 0 ] && echo
      return 0
    fi
    printf '\r\033[36m[vos-dev]\033[0m waiting for the container: install, build and gateway ... %ss/%ss' "$waited" "$timeout"
    sleep 5
    waited=$((waited + 5))
    if [ $((waited % 30)) -eq 0 ]; then
      printf '\n  %s\n' "$(compose logs --no-color --tail 1 "$SERVICE" 2>/dev/null | tail -n 1)"
    fi
  done
  echo
  return 1
}

cleanup() {
  local rc=$?
  printf '\n'
  log "stopping live debugging (the build is kept; 'vos-dev.sh reset' removes it)"
  set +e
  route_off
  compose stop
  return "$rc"
}

cmd_up() {
  command -v docker >/dev/null || die "docker is required"
  command -v curl >/dev/null || die "curl is required"
  prepare
  case "${VH_DEV_BASE_IMAGE}" in
    *:unresolved)
      die "no installed v-harness container found; install the app in VOS or set VH_DEV_BASE_IMAGE" ;;
  esac
  ensure_port_free

  log "starting the dev container from ${VH_DEV_BASE_IMAGE}"
  compose up -d
  if ! wait_healthy; then
    warn "not healthy within ${VH_DEV_HEALTH_TIMEOUT:-2400}s; the platform route was not written"
    compose logs --no-color --tail 80 "$SERVICE" || true
    return 1
  fi
  log "dev container is healthy on http://127.0.0.1:${PORT}/__vh/health"
  route_on

  log "open the app from the VOS sidebar; this container now serves it"
  log "  gateway: ${ROOT_DIR}/gateway, restarted on edit"
  log "  tenants: dsh from the workspace build; client bundles and the shell rebuild on edit"
  log "  Host packages under packages/ need 'make vos-dev-build' after an edit"
  log "  payload plugins in /opt/v-harness/{plugins,agent-plugins} stay the installed image's"
  log "Ctrl-C stops the container and removes the route"

  trap cleanup EXIT
  compose logs -f "$SERVICE"
}

cmd_down() {
  prepare
  set +e
  route_off
  compose stop
  log "dev container stopped; the workspace install and build remain for the next start"
}

cmd_reset() {
  prepare
  set +e
  route_off
  compose down --remove-orphans
  log "dev container removed; the next start installs and builds again"
}

cmd_status() {
  prepare
  echo "-- container --"
  compose ps "$SERVICE" --format '  {{.Name}}  {{.Status}}  {{.Ports}}' 2>/dev/null || echo "  not running"
  echo "-- health --"
  if health_ok; then
    echo "  OK http://127.0.0.1:${PORT}/__vh/health"
  else
    echo "  unreachable (not started, still installing or building, or failed)"
  fi
  echo "-- last log line --"
  compose logs --no-color --tail 1 "$SERVICE" 2>/dev/null | tail -n 1 || true
  echo "-- route ${ROUTE_FILE} --"
  docker exec -i "$TRAEFIK_CONTAINER" sh -c "test -f '$ROUTE_FILE' && cat '$ROUTE_FILE' || echo '  (not enabled: the platform serves the installed app)'" 2>/dev/null \
    || echo "  (Traefik container unavailable)"
}

cmd_build() {
  prepare
  compose exec -T "$SERVICE" bash -lc \
    'cd /usr/local/share/v-harness/src && pnpm run build:native-system && pnpm run build:artifacts && date -u > /var/lib/vos-dev/build.stamp'
}

cmd_shell() {
  prepare
  compose exec "$SERVICE" bash
}

case "${1:-up}" in
  up)        cmd_up ;;
  down)      cmd_down ;;
  reset)     cmd_reset ;;
  route-off) prepare; route_off ;;
  status)    cmd_status ;;
  logs)      prepare; compose logs -f "$SERVICE" ;;
  build)     cmd_build ;;
  shell)     cmd_shell ;;
  -h|--help|help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "${BASH_SOURCE[0]}" ;;
  *) die "unknown command: $1 (up|down|reset|route-off|status|logs|build|shell)" ;;
esac
