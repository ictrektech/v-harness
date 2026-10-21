#!/usr/bin/env bash
set -euo pipefail

# Build and publish the v-harness image.
#
# One image serves both architectures; the tag carries the architecture the
# same way the other ictrek apps do:
#   swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness:amd_YYYYMMDD
#   swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness:arm_YYYYMMDD
#
# The Feishu release table records the tag in the service column named
# `v-harness` on every sheet selected for the target architecture.

APP_REGISTRY_PREFIX="swr.cn-southwest-2.myhuaweicloud.com/ictrek"
IMAGE="${APP_REGISTRY_PREFIX}/v-harness"
SERVICE_NAME="v-harness"
# Mirrored into SWR once so repeat builds, and the other architecture's host,
# never depend on Docker Hub being reachable.
BASE_IMAGE="node:22-bookworm-slim"
SWR_BASE_IMAGE="${APP_REGISTRY_PREFIX}/node:22-bookworm-slim"

FEISHU_CONFIG_FILE="${FEISHU_CONFIG_FILE:-${HOME}/.feishu.json}"
# A spreadsheet token identifies a document; reading it still requires a
# tenant token minted from feishu_app_secret. Committing the id therefore does
# not expose data, and a fresh clone can build without extra setup — the same
# arrangement v-office uses. Override with the environment or with
# `feishu_spreadsheet_token` in the config file when pointing at another table.
FEISHU_SPREADSHEET_TOKEN="${FEISHU_SPREADSHEET_TOKEN:-Htotsn3oahO1zxt73YMcaB1zn8e}"
TARGET="${V_HARNESS_BUILD_TARGET:-}"
TARGET_SHEET_SPEC="${FEISHU_SHEET_TITLE:-}"
PROFILE_TAG=""
TARGET_SHEET_TITLES=()

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
# Debian package mirror for the build stage; an empty value keeps the base
# image's own sources.
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"

PUSH_IMAGES=1
UPDATE_FEISHU=1
DRY_RUN=0
SKIP_BUILD=0

log() { echo "[INFO] $*"; }
err() { echo "[ERROR] $*" >&2; }

usage() {
  cat <<'EOF'
Usage: ./build_image.sh [options]

Builds the v-harness image and records its tag in the Feishu release table.

Options:
  --no-push             Build locally without docker push
  --no-feishu           Do not update Feishu after push
  --feishu-only         Do not build or push; only write the tag to Feishu
  --dry-run             Print the plan without building or writing Feishu
  --target TARGET       Build target tag prefix: amd or arm (default: detect host)
  --sheet SHEET         Override Feishu sheet title list; comma-separated
  --tag TAG             Override the generated tag (used as-is)
  --suffix SUFFIX       Append SUFFIX to the generated tag (e.g. v2)
  -h, --help            Show this help

Environment:
  FEISHU_CONFIG_FILE       Defaults to ~/.feishu.json on the build host
  FEISHU_SPREADSHEET_TOKEN Release table token; falls back to
                           `feishu_spreadsheet_token` in the config file
  V_HARNESS_BUILD_TARGET    Optional default for --target
  FEISHU_SHEET_TITLE       Optional default for --sheet, comma-separated
  NPM_REGISTRY             npm registry used during the image build
  APT_MIRROR               Debian package mirror for apt (empty keeps upstream)
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "missing command: $1"; exit 1; }
}

configure_build_engine() {
  if docker buildx version >/dev/null 2>&1; then BUILD_ENGINE="buildx"; else BUILD_ENGINE="docker"; fi
}

normalize_official_image_path() {
  local image="$1"
  local without_tag="${image%%:*}"
  if [[ "$without_tag" != */* ]]; then printf 'library/%s\n' "$image"; else printf '%s\n' "$image"; fi
}

# Docker Hub is often unreachable from build hosts. Try the upstream registry,
# then the same mirrors v-office uses, and re-tag whatever succeeds.
pull_base_image() {
  local image="$1" normalized mirrored
  if docker pull "$image"; then return 0; fi
  normalized="$(normalize_official_image_path "$image")"
  for mirror in docker.m.daocloud.io docker.1ms.run dockerproxy.com; do
    mirrored="${mirror}/${normalized}"
    log "Direct pull failed for ${image}; trying ${mirrored}"
    if docker pull "$mirrored"; then
      docker tag "$mirrored" "$image"
      return 0
    fi
  done
  return 1
}

# Reuse the SWR copy when another host (or a previous build) already mirrored it.
ensure_base_image() {
  if docker image inspect "$SWR_BASE_IMAGE" >/dev/null 2>&1; then
    log "Base image cached locally: ${SWR_BASE_IMAGE}"
    return 0
  fi
  if docker pull "$SWR_BASE_IMAGE" >/dev/null 2>&1; then
    log "Base image pulled from SWR: ${SWR_BASE_IMAGE}"
    return 0
  fi
  if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    log "Pulling base image from upstream: ${BASE_IMAGE}"
    pull_base_image "$BASE_IMAGE" || { err "cannot pull ${BASE_IMAGE} from any registry"; exit 1; }
  fi
  docker tag "$BASE_IMAGE" "$SWR_BASE_IMAGE"
  if docker push "$SWR_BASE_IMAGE"; then
    log "Base image mirrored to SWR: ${SWR_BASE_IMAGE}"
  else
    err "warning: could not push ${SWR_BASE_IMAGE}; continuing with the local copy"
  fi
}

docker_build_image() {
  if [[ "$BUILD_ENGINE" == "buildx" ]]; then
    docker buildx build --load --provenance=false --sbom=false "$@"
  else
    docker build "$@"
  fi
}

column_letter() {
  python3 - "$1" <<'PY'
import sys
n = int(sys.argv[1])
s = ""
while n > 0:
    n, r = divmod(n - 1, 26)
    s = chr(ord("A") + r) + s
print(s)
PY
}

read_feishu_field() {
  local field="$1"
  python3 - "$FEISHU_CONFIG_FILE" "$field" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
val = data.get(sys.argv[2], "")
print(val if isinstance(val, str) else str(val))
PY
}

get_feishu_token() {
  local app_id="$1" app_secret="$2" resp
  resp=$(curl --fail -sS -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
    -H 'Content-Type: application/json' \
    -d "{\"app_id\":\"${app_id}\",\"app_secret\":\"${app_secret}\"}") || {
    err "get_feishu_token: curl failed"
    return 1
  }
  python3 - "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if data.get("code") != 0:
    raise SystemExit(f"get_feishu_token failed: {data}")
print(data["tenant_access_token"])
PY
}

feishu_api_json() {
  local method="$1" url="$2" token="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl --fail -sS -X "$method" "$url" -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" --data "$body"
  else
    curl --fail -sS -X "$method" "$url" -H "Authorization: Bearer ${token}"
  fi
}

get_sheet_id_by_title() {
  local token="$1" target_title="$2" resp
  resp=$(feishu_api_json "GET" \
    "https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${FEISHU_SPREADSHEET_TOKEN}/sheets/query" "$token")
  python3 - "$target_title" "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[2])
if data.get("code") != 0:
    raise SystemExit(f"query sheets failed: {data}")
for sheet in data.get("data", {}).get("sheets", []):
    if sheet.get("title") == sys.argv[1]:
        print(sheet["sheet_id"])
        raise SystemExit(0)
raise SystemExit(f"sheet title not found: {sys.argv[1]}")
PY
}

get_range_values() {
  feishu_api_json "GET" \
    "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${FEISHU_SPREADSHEET_TOKEN}/values/$2" "$1"
}

write_cell() {
  local token="$1" sheet_id="$2" cell="$3" value="$4" resp
  resp=$(feishu_api_json "PUT" \
    "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${FEISHU_SPREADSHEET_TOKEN}/values" "$token" \
    "{\"valueRange\":{\"range\":\"${sheet_id}!${cell}:${cell}\",\"values\":[[\"${value}\"]]}}")
  python3 - "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if data.get("code") != 0:
    raise SystemExit(f"write_cell failed: {data}")
PY
}

find_or_create_component_column() {
  local token="$1" sheet_id="$2" component_name="$3" resp_file
  resp_file="$(mktemp)"
  get_range_values "$token" "${sheet_id}!A1:ZZ2" > "$resp_file"
  python3 - "$component_name" "$resp_file" <<'PY'
import json, sys
target = sys.argv[1]
with open(sys.argv[2], "r", encoding="utf-8") as f:
    data = json.load(f)
if data.get("code") != 0:
    raise SystemExit(f"read header failed: {data}")
values = data.get("data", {}).get("valueRange", {}).get("values", [])
row = values[0] if values else []
repo_row = values[1] if len(values) > 1 else []

def cell_text(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, dict):
        return str(v.get("text") or v.get("link") or "").strip()
    if isinstance(v, list):
        return "".join(cell_text(x) for x in v).strip()
    return str(v).strip()

max_len = max(len(row), len(repo_row))
for i in range(2, max_len + 1):
    header = cell_text(row[i - 1]) if i <= len(row) else ""
    if header == target:
        print(i)
        raise SystemExit(0)
for i in range(2, max_len + 2):
    header = cell_text(row[i - 1]) if i <= len(row) else ""
    repo = cell_text(repo_row[i - 1]) if i <= len(repo_row) else ""
    if not header and not repo:
        print(i)
        raise SystemExit(0)
print(max_len + 1)
PY
  rm -f "$resp_file"
}

find_date_row() {
  local token="$1" sheet_id="$2" target_date="$3" resp
  resp=$(get_range_values "$token" "${sheet_id}!A4:A2000")
  python3 - "$target_date" "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[2])
if data.get("code") != 0:
    raise SystemExit(f"read date column failed: {data}")
values = data.get("data", {}).get("valueRange", {}).get("values", [])
for idx, row in enumerate(values, start=4):
    if row and str(row[0]).strip() == sys.argv[1]:
        print(idx)
        raise SystemExit(0)
print("")
PY
}

prepend_date_row() {
  local token="$1" sheet_id="$2" today="$3" resp
  resp=$(feishu_api_json "POST" \
    "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${FEISHU_SPREADSHEET_TOKEN}/values_prepend" "$token" \
    "{\"valueRange\":{\"range\":\"${sheet_id}!A4:A4\",\"values\":[[\"${today}\"]]}}")
  python3 - "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if data.get("code") != 0:
    raise SystemExit(f"prepend_date_row failed: {data}")
PY
}

update_feishu_cell() {
  local token="$1" sheet_id="$2" sheet_title="$3" row="$4" tag="$5"
  local component_col_idx component_col
  component_col_idx="$(find_or_create_component_column "$token" "$sheet_id" "$SERVICE_NAME")"
  component_col="$(column_letter "$component_col_idx")"
  write_cell "$token" "$sheet_id" "${component_col}1" "$SERVICE_NAME"
  write_cell "$token" "$sheet_id" "${component_col}2" "$IMAGE"
  write_cell "$token" "$sheet_id" "${component_col}${row}" "$tag"
  log "Feishu updated: ${sheet_title}!${component_col}${row} = ${tag}"
}

resolve_spreadsheet_token() {
  if [[ -n "$FEISHU_SPREADSHEET_TOKEN" ]]; then return 0; fi
  if [[ -f "$FEISHU_CONFIG_FILE" ]]; then
    FEISHU_SPREADSHEET_TOKEN="$(read_feishu_field "feishu_spreadsheet_token" 2>/dev/null || true)"
  fi
  [[ -n "$FEISHU_SPREADSHEET_TOKEN" ]] || {
    err "FEISHU_SPREADSHEET_TOKEN is not set."
    err "Export it, or add \"feishu_spreadsheet_token\" to ${FEISHU_CONFIG_FILE}."
    exit 1
  }
}

update_feishu() {
  local tag="$1" app_id app_secret token sheet_id date_row sheet_title
  [[ -f "$FEISHU_CONFIG_FILE" ]] || { err "Feishu config not found: $FEISHU_CONFIG_FILE"; exit 1; }
  resolve_spreadsheet_token
  app_id="$(read_feishu_field "feishu_app_id")"
  app_secret="$(read_feishu_field "feishu_app_secret")"
  [[ -n "$app_id" && -n "$app_secret" ]] || { err "feishu credentials missing in $FEISHU_CONFIG_FILE"; exit 1; }

  for sheet_title in "${TARGET_SHEET_TITLES[@]}"; do
    token="$(get_feishu_token "$app_id" "$app_secret")"
    sheet_id="$(get_sheet_id_by_title "$token" "$sheet_title")"
    log "Resolved sheet: ${sheet_title} -> ${sheet_id}"

    token="$(get_feishu_token "$app_id" "$app_secret")"
    date_row="$(find_date_row "$token" "$sheet_id" "$DATE")"
    if [[ -z "$date_row" ]]; then
      log "Date ${DATE} not found in ${sheet_title}, creating a new row"
      token="$(get_feishu_token "$app_id" "$app_secret")"
      prepend_date_row "$token" "$sheet_id" "$DATE"
      date_row=4
    fi

    token="$(get_feishu_token "$app_id" "$app_secret")"
    update_feishu_cell "$token" "$sheet_id" "$sheet_title" "$date_row" "$tag"
  done
}

TAG_OVERRIDE=""
TAG_SUFFIX=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push) PUSH_IMAGES=0; shift ;;
    --no-feishu) UPDATE_FEISHU=0; shift ;;
    --feishu-only) SKIP_BUILD=1; PUSH_IMAGES=0; UPDATE_FEISHU=1; shift ;;
    --dry-run) DRY_RUN=1; PUSH_IMAGES=0; UPDATE_FEISHU=0; shift ;;
    --tag) TAG_OVERRIDE="$2"; shift 2 ;;
    --suffix) TAG_SUFFIX="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --sheet) TARGET_SHEET_SPEC="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# The only host dependency is docker plus the python3 used to read the Feishu
# table; node, pnpm and the bundler all run inside the image.
require_cmd python3

ARCH="$(uname -m)"
if [[ -z "$TARGET" ]]; then
  case "$ARCH" in
    x86_64) TARGET="amd" ;;
    aarch64|arm64) TARGET="arm" ;;
    *) err "Unable to infer target from ${ARCH}; pass --target amd|arm"; exit 1 ;;
  esac
fi

case "$TARGET" in
  amd)
    PROFILE_TAG="amd"
    TARGET_SHEET_SPEC="${TARGET_SHEET_SPEC:-AMD_with_cuda,AMD_with_mxn100}"
    ;;
  arm)
    PROFILE_TAG="arm"
    TARGET_SHEET_SPEC="${TARGET_SHEET_SPEC:-ARM_without_cuda,l4t,ARM_with_cuda,thor_spark,SOPHON_bm1688}"
    ;;
  *) err "Unsupported target: ${TARGET}"; exit 1 ;;
esac

IFS=',' read -r -a TARGET_SHEET_TITLES <<< "$TARGET_SHEET_SPEC"
[[ "${#TARGET_SHEET_TITLES[@]}" -gt 0 ]] || { err "No Feishu sheet titles configured"; exit 1; }

if [[ "$DRY_RUN" != "1" && "$SKIP_BUILD" != "1" ]]; then
  case "${TARGET}:${ARCH}" in
    amd:x86_64|arm:aarch64|arm:arm64) ;;
    *) err "Target ${TARGET} does not match host architecture ${ARCH}"; exit 1 ;;
  esac
fi

DATE="$(date +%Y%m%d)"
BASE_TAG="${PROFILE_TAG}_${DATE}"

tag_taken() {
  local tag="$1"
  if docker image inspect "${IMAGE}:${tag}" >/dev/null 2>&1; then return 0; fi
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 docker manifest inspect "${IMAGE}:${tag}" >/dev/null 2>&1 && return 0
  else
    docker manifest inspect "${IMAGE}:${tag}" >/dev/null 2>&1 && return 0
  fi
  return 1
}

next_free_tag() {
  local base="$1" candidate="$1" n=1
  while tag_taken "$candidate"; do
    n=$((n + 1))
    candidate="${base}_${n}"
  done
  printf '%s\n' "$candidate"
}

if [[ -n "$TAG_OVERRIDE" ]]; then
  TAG="$TAG_OVERRIDE"
elif [[ "$SKIP_BUILD" == "1" ]]; then
  TAG="$BASE_TAG"
elif [[ -n "$TAG_SUFFIX" ]]; then
  TAG="${BASE_TAG}${TAG_SUFFIX}"
else
  TAG="$(next_free_tag "$BASE_TAG")"
  [[ "$TAG" == "$BASE_TAG" ]] || log "Tag ${BASE_TAG} already exists; using ${TAG}"
fi

log "TARGET=${TARGET} ARCH=${ARCH}"
log "TARGET_SHEETS=${TARGET_SHEET_TITLES[*]}"
log "IMAGE=${IMAGE}:${TAG}"
# The image carries the checkout it was built from, so two builds that disagree
# can be compared without guessing which source produced them.
REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
log "REVISION=${REVISION}"

if [[ "$DRY_RUN" == "1" ]]; then
  exit 0
fi

# Fail before the build, not after it. A missing token used to surface only
# once the image was built and pushed, which wastes the whole run.
preflight_feishu() {
  [[ "$UPDATE_FEISHU" == "1" ]] || return 0
  [[ -f "$FEISHU_CONFIG_FILE" ]] || {
    err "Feishu config not found: $FEISHU_CONFIG_FILE"
    err "Create it with feishu_app_id, feishu_app_secret and feishu_spreadsheet_token."
    exit 1
  }
  resolve_spreadsheet_token
  local app_id app_secret
  app_id="$(read_feishu_field "feishu_app_id" 2>/dev/null || true)"
  app_secret="$(read_feishu_field "feishu_app_secret" 2>/dev/null || true)"
  [[ -n "$app_id" && -n "$app_secret" ]] || {
    err "feishu_app_id / feishu_app_secret missing in $FEISHU_CONFIG_FILE"
    exit 1
  }
}

if [[ "$SKIP_BUILD" != "1" ]]; then
  preflight_feishu
  require_cmd docker
  configure_build_engine
  log "BUILD_ENGINE=${BUILD_ENGINE}"
  ensure_base_image
  docker_build_image \
    --build-arg "BASE_IMAGE=${SWR_BASE_IMAGE}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    --build-arg "APT_MIRROR=${APT_MIRROR}" \
    --build-arg "GIT_COMMIT=${REVISION}" \
    --label "org.opencontainers.image.revision=${REVISION}" \
    -f Dockerfile \
    -t "${IMAGE}:${TAG}" \
    .
fi

if [[ "$PUSH_IMAGES" == "1" ]]; then
  docker push "${IMAGE}:${TAG}"
fi

if [[ "$UPDATE_FEISHU" == "1" ]]; then
  require_cmd curl
  update_feishu "$TAG"
fi

log "Done."
