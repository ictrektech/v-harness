#!/usr/bin/env bash
# Entrypoint of the live-debug container.
#
# Copies the checkout under /usr so every tenant jail can reach the build
# read-only (vh-jail binds /usr as the shared runtime), installs and builds it
# once, keeps the browser-side artifacts rebuilding, then hands over to the
# released boot sequence, which starts the gateway and every tenant dsh from
# that tree.
set -euo pipefail

HOST_SRC=/host-src
SRC=/usr/local/share/v-harness/src
STATE=/var/lib/vos-dev

log() { printf '\033[36m[vos-dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[vos-dev]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[vos-dev][ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$HOST_SRC" ] || die "the host checkout is not mounted at $HOST_SRC"
mkdir -p "$STATE" "$SRC"

# `.gitignore` is the removal list as well as the transfer list: every build
# output and the workspace install are ignored there, so a sync neither
# re-transfers them nor deletes them, and the copy stays correct as the
# repository adds outputs. `.env` is ignored too, which keeps the checkout's
# credentials out of a tree every tenant can read.
log "syncing the checkout into $SRC"
rsync -a --delete --exclude=.git/ --filter=':- .gitignore' "$HOST_SRC"/ "$SRC"/
# Build metadata (version, commit, dirty marker) is read from Git by
# scripts/build.ts, which refuses a tree that is not a repository.
[ -d "$HOST_SRC/.git" ] || die "the checkout has no .git directory; scripts/build.ts reads the commit from Git"
rsync -a "$HOST_SRC/.git/" "$SRC/.git/"
# The copy keeps the host user's ownership while this container runs as root,
# and Git refuses a repository owned by another user until it is declared.
git config --global --replace-all safe.directory "$SRC"

# One sync per second, without a removal pass: a build writes paths that no
# ignore file knows, and deleting one mid-build surfaces as an unexplainable
# compiler error. A file deleted in the checkout leaves the copy until the
# container is recreated, which runs the removal pass above.
(
  while :; do
    sleep 1
    rsync -a --exclude=.git/ --filter=':- .gitignore' "$HOST_SRC"/ "$SRC"/ || warn "source sync failed; retrying"
  done
) &

if [ "${VH_DEV_SKIP_INSTALL:-0}" != 1 ] && ! cmp -s "$SRC/pnpm-lock.yaml" "$STATE/pnpm-lock.yaml"; then
  log "installing the workspace dependencies (this takes minutes)"
  ( cd "$SRC" && pnpm install --frozen-lockfile --prod=false --store-dir "$STATE/pnpm-store" )
  cp "$SRC/pnpm-lock.yaml" "$STATE/pnpm-lock.yaml"
fi

if [ "${VH_DEV_SKIP_BUILD:-0}" != 1 ] \
  && { [ ! -f "$STATE/build.stamp" ] || [ ! -f "$SRC/apps/cli/lib/bin.js" ]; }; then
  log "building the artifact tree (this takes minutes)"
  ( cd "$SRC" && pnpm run build:native-system && pnpm run build:artifacts )
  date -u > "$STATE/build.stamp"
fi

# Client bundles and the shell are compiled artifacts the browser loads, so an
# edit only reaches it through these watchers. Host-side packages are not in
# their graph: `make vos-dev-build` rebuilds those.
if [ "${VH_DEV_WATCH:-1}" = 1 ]; then
  log "watching client bundles, tsconfig.client.json and the Web shell"
  ( cd "$SRC" && exec pnpm run dev:web --skip-build --no-serve ) &
fi

log "starting the gateway; tenant dsh processes run $SRC/apps/cli/lib/bin.js"
exec /opt/v-harness/bin/entrypoint
