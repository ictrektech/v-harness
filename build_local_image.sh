#!/usr/bin/env bash
set -euo pipefail

# Build the v-harness image from THIS checkout, including uncommitted work.
#
# `build_image.sh` is the release path: a dated tag, a push, and a Feishu row.
# This script exists for the step before that — verify the knowledge-base
# changes locally, then decide whether to hot-patch the running container:
#
#   - the tag carries a timestamp and the commit prefix, so a local build never
#     overwrites the day's release tag;
#   - a dirty worktree appends -dirty, so an image whose bytes do not match the
#     recorded commit says so in its own name;
#   - nothing is pushed and no release table is written.
#
# Usage: ./build_local_image.sh [--tag NAME]

APP_REGISTRY_PREFIX="swr.cn-southwest-2.myhuaweicloud.com/ictrek"
IMAGE="${V_HARNESS_LOCAL_IMAGE:-v-harness-local}"
BASE_IMAGE="${BASE_IMAGE:-node:22-bookworm-slim}"
SWR_BASE_IMAGE="${SWR_BASE_IMAGE:-${APP_REGISTRY_PREFIX}/node:22-bookworm-slim}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"
CUSTOM_TAG=""

log() { echo "[INFO] $*"; }
err() { echo "[ERROR] $*" >&2; }
die() { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./build_local_image.sh [options]

Builds a local-only v-harness image from the current checkout. Nothing is
pushed and the Feishu release table is not touched.

Options:
  --tag NAME   Use NAME as the image tag (default: local_<timestamp>_<commit7>[-dirty])
  -h, --help   Show this help

Environment:
  V_HARNESS_LOCAL_IMAGE  Image name (default: v-harness-local)
  BASE_IMAGE             Build base (default: node:22-bookworm-slim)
  NPM_REGISTRY           npm registry used during the build
  APT_MIRROR             Debian mirror for apt (empty keeps the base image's)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) CUSTOM_TAG="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || die "missing command: docker"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git checkout: ${ROOT}"

REVISION="$(git rev-parse HEAD)"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || die "cannot read the full commit from ${ROOT}"

# The image records the commit it was built from; the tag says whether that
# commit is the whole story.
DIRTY=""
if [[ -n "$(git status --porcelain)" ]]; then DIRTY="-dirty"; fi

if [[ -n "$CUSTOM_TAG" ]]; then
  TAG="$CUSTOM_TAG"
else
  TAG="local_$(date +%Y%m%d_%H%M%S)_${REVISION:0:7}${DIRTY}"
fi
REF="${IMAGE}:${TAG}"

# Reuse the SWR copy when a previous build already mirrored it; fall back to
# Docker Hub only for a first build.
ensure_base_image() {
  if docker image inspect "$SWR_BASE_IMAGE" >/dev/null 2>&1; then
    log "Base image cached locally: ${SWR_BASE_IMAGE}"
    return 0
  fi
  if docker pull "$SWR_BASE_IMAGE" >/dev/null 2>&1; then
    log "Base image pulled from SWR: ${SWR_BASE_IMAGE}"
    return 0
  fi
  log "Pulling base image from upstream: ${BASE_IMAGE}"
  docker pull "$BASE_IMAGE" || die "cannot pull ${BASE_IMAGE}; set BASE_IMAGE to a reachable copy"
  docker tag "$BASE_IMAGE" "$SWR_BASE_IMAGE"
}

# `--load` keeps the result in the local image store instead of a build cache.
if docker buildx version >/dev/null 2>&1; then
  BUILD=(docker buildx build --load --provenance=false --sbom=false)
else
  BUILD=(docker build)
fi

log "Checkout: ${ROOT}"
log "Revision: ${REVISION}${DIRTY}"
log "Image:    ${REF}"

ensure_base_image

"${BUILD[@]}" \
  --build-arg "BASE_IMAGE=${SWR_BASE_IMAGE}" \
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
  --build-arg "APT_MIRROR=${APT_MIRROR}" \
  --label "org.opencontainers.image.revision=${REVISION}" \
  --label "org.opencontainers.image.source-dirty=${DIRTY:-false}" \
  -f Dockerfile \
  -t "$REF" \
  .

log "Built: ${REF}"
log "Nothing was pushed and no release table was written."
