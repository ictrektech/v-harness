#!/usr/bin/env bash
set -euo pipefail

# 构建本地镜像，保存为 docker archive，并生成 VOS 离线安装包。
# 不推送镜像，不写飞书，不发布应用商店。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${ROOT}/ictrek.app/src"
DIST="${ROOT}/dist"
VERSION_FILE="${ROOT}/VERSION"

APP_NAME="${APP_NAME:-myapp}"
IMAGE="${IMAGE:-local/${APP_NAME}}"
ARCH=""
VERSION=""

die() { echo "[ERROR] $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash ictrek.app/scripts/package-local.sh [options]

Options:
  --arch NAME      Target architecture: amd64 or arm64 (default: host arch)
  --version VER    App version (default: VERSION file)
  --image NAME     Local image name (default: local/myapp)
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="${2:?--arch needs a value}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --image) IMAGE="${2:?--image needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[ERROR] unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "unsupported host arch: $(uname -m)" ;;
  esac
}

[[ -n "$ARCH" ]] || ARCH="$(host_arch)"
[[ "$ARCH" == "amd64" || "$ARCH" == "arm64" ]] || die "--arch must be amd64 or arm64"

[[ -n "$VERSION" ]] || VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
[[ -n "$VERSION" ]] || die "empty version"

REF="${IMAGE}:${VERSION}"
ASSET_NAME="${APP_NAME}-${VERSION}.tar.gz"
STAGE="${DIST}/staging"
OUTER_DIR="${DIST}/outer"
APP_TARBALL="${DIST}/app.tar.gz"
OUTER_TARBALL="${DIST}/${APP_NAME}-${VERSION}-${ARCH}.tar"

command -v docker >/dev/null 2>&1 || die "missing command: docker"
command -v tar >/dev/null 2>&1 || die "missing command: tar"

for file in manifest.yml docker-compose.yml configs.yml routers.yml; do
  [[ -f "${SRC}/${file}" ]] || die "missing ${SRC}/${file}"
done
if [[ ! -f "${SRC}/icon.png" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    echo "[INFO] ${SRC}/icon.png not found, generating it"
    python3 "${ROOT}/ictrek.app/scripts/make-icon.py" "${SRC}/icon.png"
  fi
fi
[[ -f "${SRC}/icon.png" ]] || die "missing ${SRC}/icon.png (256x256 RGBA)"

rm -rf "$STAGE" "$OUTER_DIR" "$APP_TARBALL" "$OUTER_TARBALL"
mkdir -p "$STAGE" "${OUTER_DIR}/assets/${ARCH}"

echo "[INFO] arch=${ARCH} version=${VERSION} image=${REF}"

# VOS 本地构建环境没有 BuildKit 控制面，必须走经典构建器。
export DOCKER_BUILDKIT=0
docker build --platform "linux/${ARCH}" -t "$REF" "$ROOT"

ASSET_PATH="${OUTER_DIR}/assets/${ARCH}/${ASSET_NAME}"
if docker save "$REF" 2>/dev/null | gzip > "$ASSET_PATH"; then
  echo "[INFO] image saved with docker save"
else
  # 受限 docker 能力下 GET /images/get 不可用，用 create/export 生成等价的 docker-archive。
  echo "[WARN] docker save unavailable, falling back to image export"
  command -v python3 >/dev/null 2>&1 || die "python3 is required for the export fallback"
  python3 "${ROOT}/ictrek.app/scripts/export-image.py" "$REF" "$ASSET_PATH"
fi
[[ -s "$ASSET_PATH" ]] || die "failed to export image ${REF}"

render() {
  sed "s|__APP_VERSION__|${VERSION}|g" "$1" > "$2"
}

render "${SRC}/manifest.yml" "${STAGE}/manifest.yml"
render "${SRC}/docker-compose.yml" "${STAGE}/docker-compose.yml"
render "${SRC}/configs.yml" "${STAGE}/configs.yml"
render "${SRC}/routers.yml" "${STAGE}/routers.yml"
cp "${SRC}/icon.png" "${STAGE}/icon.png"
: > "${STAGE}/.env"

tar czf "$APP_TARBALL" -C "$STAGE" \
  .env manifest.yml docker-compose.yml configs.yml routers.yml icon.png

verify_package() {
  local entries manifest compose manifest_version asset_filename compose_image
  entries="$(tar tzf "$APP_TARBALL")"
  for required in .env manifest.yml docker-compose.yml configs.yml routers.yml icon.png; do
    grep -Fxq "$required" <<< "$entries" || die "app.tar.gz missing ${required}"
  done
  # 镜像属于外层 assets/；放进 app.tar.gz 平台会取不到，安装时报本地文件不存在。
  if grep -q '^assets/' <<< "$entries"; then
    die "app.tar.gz must not contain assets/; put the image under assets/${ARCH}/ in the offline package"
  fi

  manifest="$(tar xOf "$APP_TARBALL" manifest.yml)"
  compose="$(tar xOf "$APP_TARBALL" docker-compose.yml)"

  # 取顶层字段值，避免命中 platform.version 之类的同名字段。
  manifest_version="$(awk '/^version:[[:space:]]*/ {print $2; exit}' <<< "$manifest")"
  asset_filename="$(awk '/^[[:space:]]*filename:[[:space:]]*/ {print $2; exit}' <<< "$manifest")"
  compose_image="$(awk '/^[[:space:]]*image:[[:space:]]*/ {print $2; exit}' <<< "$compose")"

  [[ "$manifest_version" == "$VERSION" ]] \
    || die "manifest version ${manifest_version:-<missing>} != ${VERSION}"
  [[ "$asset_filename" == "$ASSET_NAME" ]] \
    || die "manifest assets filename ${asset_filename:-<missing>} != ${ASSET_NAME}"
  [[ "$compose_image" == "$REF" ]] \
    || die "compose image ${compose_image:-<missing>} != ${REF}"

  if grep -q '__APP_VERSION__' <<< "${manifest}${compose}"; then
    die "unrendered __APP_VERSION__ placeholder"
  fi
}

verify_package

cp "$APP_TARBALL" "${OUTER_DIR}/app.tar.gz"
tar cf "$OUTER_TARBALL" -C "$OUTER_DIR" app.tar.gz "assets/${ARCH}/${ASSET_NAME}"
tar tf "$OUTER_TARBALL" | grep -Fxq "assets/${ARCH}/${ASSET_NAME}" \
  || die "offline package missing assets/${ARCH}/${ASSET_NAME}"

echo "[INFO] app tarball: ${APP_TARBALL} ($(du -h "$APP_TARBALL" | cut -f1))"
echo "[INFO] image asset: ${ASSET_PATH} ($(du -h "$ASSET_PATH" | cut -f1))"
echo "[INFO] offline package: ${OUTER_TARBALL} ($(du -h "$OUTER_TARBALL" | cut -f1))"
