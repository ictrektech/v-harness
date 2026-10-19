#!/usr/bin/env bash
set -euo pipefail

# Build the pull-mode VOS app tarball for v-harness.
#
# Image tags are not baked in here: they are read from the Feishu release table,
# which `build_image.sh` writes. That keeps "publish an image" and "publish an
# app" independent — an app release always points at whatever tag is newest for
# each architecture.

APP_NAME="v-harness"
APP_ID="com.ictrek.v-harness"
ROUTER_PAGE_ID="v-harness"
ROUTER_IFRAME_SRC="/app/com.ictrek.v-harness/?v=__APP_VERSION__"
FRONTEND_BASE_PATH="/app/com.ictrek.v-harness"
# A spreadsheet token only identifies the release table; reading it still needs
# a tenant token derived from feishu_app_secret. Keeping the default lets a
# fresh clone package without extra setup, matching v-office.
SPREADSHEET_TOKEN="${FEISHU_SPREADSHEET_TOKEN:-Htotsn3oahO1zxt73YMcaB1zn8e}"
FEISHU_CONFIG_FILE="${FEISHU_CONFIG_FILE:-${HOME}/.feishu.components.json}"
FEISHU_FALLBACK_CONFIG_FILE="${FEISHU_FALLBACK_CONFIG_FILE:-${HOME}/.feishu.json}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/src"
DIST_DIR="${ROOT_DIR}/dist"
STAGE_DIR="${DIST_DIR}/staging"
PACKAGE_ROOT="${DIST_DIR}/package-root"
VERSION_FILE="${ROOT_DIR}/VERSION"
LOCK_DIR="${DIST_DIR}/.package.lock"

PROFILES=(
  "amd|AMD_with_cuda"
  "arm|ARM_with_cuda"
)
COMPONENTS=(
  "V_HARNESS|v-harness|swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness"
)

log() { echo "[INFO] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  ./scripts/package.sh

Builds one pull-mode VOS app tarball covering every Docker Compose profile.
Image tags are read from the Feishu release table and rendered into the bundle.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

select_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import yaml' >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      log "Python runtime: ${PYTHON_BIN}"
      return
    fi
  done
  die "missing Python with PyYAML; install PyYAML or set PYTHON_BIN"
}

read_feishu_field() {
  local config_file="$1" field="$2"
  "${PYTHON_BIN}" - "$config_file" "$field" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
val = data.get(sys.argv[2], "")
print(val if isinstance(val, str) else str(val))
PY
}

get_feishu_token() {
  local app_id="$1" app_secret="$2" resp
  resp="$(curl --fail -sS -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\":\"${app_id}\",\"app_secret\":\"${app_secret}\"}")"
  "${PYTHON_BIN}" - "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if data.get("code") != 0:
    raise SystemExit(f"get_feishu_token failed: {data}")
print(data["tenant_access_token"])
PY
}

feishu_get() {
  curl --fail -sS -X GET "$1" -H "Authorization: Bearer ${2}"
}

get_sheet_id_by_title() {
  local token="$1" title="$2" resp
  resp="$(feishu_get "https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/query" "$token")"
  "${PYTHON_BIN}" - "$title" "$resp" <<'PY'
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
  feishu_get "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/$2" "$1"
}

find_component_column_letter() {
  local token="$1" sheet_id="$2" component="$3" resp
  resp="$(get_range_values "$token" "${sheet_id}!A1:ZZ1")"
  "${PYTHON_BIN}" - "$component" "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[2])
if data.get("code") != 0:
    raise SystemExit(f"read header failed: {data}")
values = data.get("data", {}).get("valueRange", {}).get("values", [])
row = values[0] if values else []

def text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return str(value.get("text") or value.get("link") or "").strip()
    if isinstance(value, list):
        return "".join(text(v) for v in value).strip()
    return str(value).strip()

def col(num):
    out = ""
    while num > 0:
        num, rem = divmod(num - 1, 26)
        out = chr(ord("A") + rem) + out
    return out

for index, value in enumerate(row, start=1):
    if text(value) == sys.argv[1]:
        print(col(index))
        raise SystemExit(0)
raise SystemExit(f"component column not found in row 1: {sys.argv[1]}")
PY
}

find_latest_tag() {
  local token="$1" sheet_id="$2" column="$3" resp
  resp="$(get_range_values "$token" "${sheet_id}!${column}4:${column}2000")"
  "${PYTHON_BIN}" - "$resp" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if data.get("code") != 0:
    raise SystemExit(f"read version column failed: {data}")
values = data.get("data", {}).get("valueRange", {}).get("values", [])
for row in values:
    if row and row[0] is not None and str(row[0]).strip():
        print(str(row[0]).strip())
        raise SystemExit(0)
raise SystemExit("latest version not found")
PY
}

latest_image() {
  local token="$1" sheet_id="$2" component="$3" repository="$4" column tag
  column="$(find_component_column_letter "$token" "$sheet_id" "$component")" || return 1
  tag="$(find_latest_tag "$token" "$sheet_id" "$column")" || return 1
  [[ -n "$tag" ]] || return 1
  echo "${repository}:${tag}"
}

load_feishu_auth() {
  local config_file
  for config_file in "$FEISHU_CONFIG_FILE" "$FEISHU_FALLBACK_CONFIG_FILE"; do
    [[ -r "$config_file" ]] || continue
    log "Read image tags with Feishu config: ${config_file}"
    FEISHU_APP_ID="$(read_feishu_field "$config_file" "feishu_app_id")"
    FEISHU_APP_SECRET="$(read_feishu_field "$config_file" "feishu_app_secret")"
    if [[ -z "$SPREADSHEET_TOKEN" ]]; then
      SPREADSHEET_TOKEN="$(read_feishu_field "$config_file" "feishu_spreadsheet_token" 2>/dev/null || true)"
    fi
    if [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]] \
      && FEISHU_TOKEN="$(get_feishu_token "$FEISHU_APP_ID" "$FEISHU_APP_SECRET")"; then
      break
    fi
    log "Cannot read Feishu auth from ${config_file}; trying fallback"
  done
  [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]] || die "failed to read Feishu credentials"
  [[ -n "$SPREADSHEET_TOKEN" ]] || die \
    "FEISHU_SPREADSHEET_TOKEN is not set; export it or add feishu_spreadsheet_token to the config file"
}

env_key() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_' | tr -c 'A-Z0-9_' '_'
}

resolve_image_versions() {
  local env_file="$1" profile_spec profile sheet_title profile_key sheet_id component_spec
  local env_prefix component repository image
  : > "$env_file"
  for profile_spec in "${PROFILES[@]}"; do
    IFS='|' read -r profile sheet_title <<< "$profile_spec"
    profile_key="$(env_key "$profile")"
    sheet_id="$(get_sheet_id_by_title "$FEISHU_TOKEN" "$sheet_title")"
    for component_spec in "${COMPONENTS[@]}"; do
      IFS='|' read -r env_prefix component repository <<< "$component_spec"
      image="$(latest_image "$FEISHU_TOKEN" "$sheet_id" "$component" "$repository")" \
        || die "no image tag for profile=${profile} component=${component} sheet=${sheet_title}"
      log "$profile ($sheet_title) $component -> $image"
      printf '%s_%s_IMAGE=%s\n' "$env_prefix" "$profile_key" "$image" >> "$env_file"
    done
  done
}

render_text_file() {
  local src="$1" dst="$2"
  "${PYTHON_BIN}" - "$src" "$dst" "$APP_VERSION" <<'PY'
import sys
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.write_text(src.read_text(encoding="utf-8").replace("__APP_VERSION__", sys.argv[3]), encoding="utf-8")
PY
}

render_compose_file() {
  local src="$1" dst="$2" env_file="$3"
  "${PYTHON_BIN}" - "$src" "$dst" "$APP_VERSION" "$env_file" <<'PY'
import re, sys
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
version, env_path = sys.argv[3], Path(sys.argv[4])
env = {}
for line in env_path.read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    env[key] = value
text = src.read_text(encoding="utf-8").replace("__APP_VERSION__", version)
text = re.sub(
    r"\$\{([A-Z0-9_]+)(?::-[^}]*)?\}",
    lambda m: env.get(m.group(1), m.group(0)),
    text,
)
dst.write_text(text, encoding="utf-8")
PY
}

validate_staged_files() {
  local file
  for file in manifest.yml configs.yml routers.yml docker-compose.yml; do
    "${PYTHON_BIN}" - "$STAGE_DIR/$file" <<'PY' || die "invalid YAML: $file"
import sys, yaml
with open(sys.argv[1], "r", encoding="utf-8") as f:
    yaml.safe_load(f)
PY
  done

  "${PYTHON_BIN}" - "$STAGE_DIR/manifest.yml" "$STAGE_DIR/docker-compose.yml" <<'PY' \
    || die "manifest/docker-compose contract validation failed"
import sys, yaml
with open(sys.argv[1], "r", encoding="utf-8") as f:
    manifest = yaml.safe_load(f) or {}
profiles = manifest.get("profiles") or []
names = [str(item.get("name")) for item in profiles if isinstance(item, dict)]
if sorted(names) != ["amd", "arm"]:
    raise SystemExit(f"manifest profiles must be amd and arm, got {names!r}")
for item in profiles:
    conflicts = item.get("conflicts") or []
    missing = [other for other in names if other != item.get("name") and other not in conflicts]
    if missing:
        raise SystemExit(f"profile {item.get('name')!r} missing conflicts {missing!r}")

with open(sys.argv[2], "r", encoding="utf-8") as f:
    compose = yaml.safe_load(f) or {}
services = compose.get("services") or {}
covered = set()
for service in services.values():
    for profile in service.get("profiles") or []:
        covered.add(str(profile))
missing = [name for name in names if name not in covered]
if missing:
    raise SystemExit(f"docker-compose has no service for profiles {missing!r}")
PY

  "${PYTHON_BIN}" - "$STAGE_DIR/icon.png" <<'PY' || die "icon.png must be a 256x256 RGBA PNG"
import struct, sys
from pathlib import Path
data = Path(sys.argv[1]).read_bytes()
if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 33 or data[12:16] != b"IHDR":
    raise SystemExit("icon.png is not a PNG")
width, height, depth, color = struct.unpack(">IIBB", data[16:26])
if (width, height) != (256, 256):
    raise SystemExit(f"icon.png must be 256x256, got {width}x{height}")
if depth != 8 or color not in (4, 6):
    raise SystemExit("icon.png must be 8-bit RGBA")
PY

  if grep -q '${[A-Z0-9_]*_IMAGE}' "$STAGE_DIR/docker-compose.yml"; then
    grep '${[A-Z0-9_]*_IMAGE}' "$STAGE_DIR/docker-compose.yml" >&2
    die "unresolved image placeholder remains in docker-compose.yml"
  fi
  if grep -q '__APP_VERSION__' "$STAGE_DIR"/*.yml; then
    die "unrendered __APP_VERSION__ placeholder remains"
  fi
}

verify_package() {
  local package_path="$1" app_tarball="$2" required
  log "Verify app.tar.gz contents"
  for required in .env manifest.yml docker-compose.yml configs.yml routers.yml icon.png README.zh-CN.md README.en.md; do
    tar tzf "$app_tarball" | grep -qx "$required" || die "app.tar.gz missing required file: ${required}"
  done
  tar tf "$package_path" | grep -qx "app.tar.gz" || die "package is missing app.tar.gz"

  local manifest_text compose_text routers_text
  manifest_text="$(tar xOf "$app_tarball" manifest.yml)"
  printf '%s\n' "$manifest_text" | grep -Fq "  basePath: ${FRONTEND_BASE_PATH}" \
    || die "manifest frontend.basePath must be ${FRONTEND_BASE_PATH}"
  printf '%s\n' "$manifest_text" | grep -Fq "id: ${APP_ID}" \
    || die "manifest id must be ${APP_ID}"

  compose_text="$(tar xOf "$app_tarball" docker-compose.yml)"
  printf '%s\n' "$compose_text" | grep -q 'HeadersRegexp' \
    && die "Traefik v3 requires HeaderRegexp, not HeadersRegexp"
  printf '%s\n' "$compose_text" | grep -Fq '${VOS_APP_STORAGE_PATH}/data:/data' \
    || die "compose must mount VOS_APP_STORAGE_PATH/data at /data"

  routers_text="$(tar xOf "$app_tarball" routers.yml)"
  printf '%s\n' "$routers_text" | grep -Fq "  - id: ${ROUTER_PAGE_ID}" \
    || die "routers.yml must declare page id ${ROUTER_PAGE_ID}"
  printf '%s\n' "$routers_text" | grep -Fq "    iframe-src: ${ROUTER_IFRAME_SRC/__APP_VERSION__/${APP_VERSION}}" \
    || die "routers.yml iframe-src mismatch"
}

acquire_lock() {
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do sleep 1; done
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-source)
      [[ "${2:-}" == "pull" ]] || die "only pull mode is supported"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_cmd curl
require_cmd tar
select_python
mkdir -p "$DIST_DIR"
acquire_lock

APP_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid VERSION: ${APP_VERSION}"
log "Package version: ${APP_VERSION}"

load_feishu_auth

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

ENV_FILE="${STAGE_DIR}/.env"
resolve_image_versions "$ENV_FILE"

for file in manifest.yml configs.yml routers.yml README.zh-CN.md README.en.md; do
  [[ -f "${SRC_DIR}/${file}" ]] && render_text_file "${SRC_DIR}/${file}" "${STAGE_DIR}/${file}"
done
[[ -f "${SRC_DIR}/icon.png" ]] && cp "${SRC_DIR}/icon.png" "${STAGE_DIR}/icon.png"
render_compose_file "${SRC_DIR}/docker-compose.yml" "${STAGE_DIR}/docker-compose.yml" "$ENV_FILE"

validate_staged_files

APP_TARBALL="${DIST_DIR}/app.tar.gz"
PACKAGE_NAME="${APP_NAME}_${APP_VERSION}_pull.tar"
PACKAGE_PATH="${DIST_DIR}/${PACKAGE_NAME}"

rm -rf "$PACKAGE_ROOT"
mkdir -p "$PACKAGE_ROOT"
tar czf "$APP_TARBALL" -C "$STAGE_DIR" \
  .env manifest.yml docker-compose.yml configs.yml routers.yml icon.png README.zh-CN.md README.en.md
cp "$APP_TARBALL" "${PACKAGE_ROOT}/app.tar.gz"
tar cf "$PACKAGE_PATH" -C "$PACKAGE_ROOT" app.tar.gz

verify_package "$PACKAGE_PATH" "$APP_TARBALL"
log "Done: ${PACKAGE_PATH}"
