#!/usr/bin/env bash
set -euo pipefail

# 通过平台 HTTP 接口安装本地 VOS 应用：先上传外层包，再调商店安装接口。
# 只用 curl：不依赖 vos-platform-cli、docker，也不要求后端能看到宿主路径，
# 因此可以在 v-harness 租户容器内直接执行。
#
# 凭据只有一种：平台 access_token（Authorization: Bearer）。
# 退出码：0 成功；2 平台返回业务错误；4 包结构不合法；5 缺 access_token。

GATEWAY="${VOS_GATEWAY:-https://172.17.0.1:1180}"
TOKEN="${VOS_TOKEN:-}"
PACKAGE=""
VOLUME_ID="${VOS_VOLUME_ID:-}"
CONFIGS="${VOS_APP_CONFIGS:-}"
CHECK=0

die() { echo "[ERROR] $*" >&2; exit 2; }

usage() {
  cat <<'EOF'
Usage: bash install-app.sh --package <offline.tar> [options]

Options:
  --package PATH     外层归档（内含 app.tar.gz）
  --volume-id UUID   目标卷；缺省读 device-paths.sh 的 VOLUME_ROOT 末段
  --configs JSON     应用配置对象，缺省 {}
  --token TOKEN      平台 access_token（也可用 VOS_TOKEN）
  --gateway URL      平台地址（默认 https://172.17.0.1:1180）
  --check            只做检查，不安装
  -h, --help         显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGE="${2:?--package needs a value}"; shift 2 ;;
    --volume-id) VOLUME_ID="${2:?--volume-id needs a value}"; shift 2 ;;
    --configs) CONFIGS="${2:?--configs needs a value}"; shift 2 ;;
    --token) TOKEN="${2:?--token needs a value}"; shift 2 ;;
    --gateway) GATEWAY="${2:?--gateway needs a value}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[ERROR] unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

[[ -n "$PACKAGE" ]] || { usage; die "--package is required"; }
[[ -f "$PACKAGE" ]] || die "package not found: ${PACKAGE}"
command -v curl >/dev/null 2>&1 || die "missing command: curl"

json_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" <<< "$2" | head -n1; }

# 只接受外层归档：后端按外层包读取 app.tar.gz。
if ! tar tf "$PACKAGE" >/dev/null 2>&1 || ! tar tf "$PACKAGE" | grep -qx 'app.tar.gz'; then
  echo "[CHECK] package: FAIL (not an outer package; need the tarball that contains app.tar.gz)" >&2
  [[ "$CHECK" == "1" ]] && exit 4
  die "package is not an outer archive"
fi

# 平台按外层 assets/<arch>/ 取镜像；放进 app.tar.gz 会在安装时报本地文件不存在。
if ! tar tf "$PACKAGE" | grep -qE '^assets/[^/]+/.+\.tar\.gz$'; then
  echo "[CHECK] package: FAIL (no assets/<arch>/*.tar.gz at the package top level)" >&2
  [[ "$CHECK" == "1" ]] && exit 4
  die "package has no image asset under assets/<arch>/"
fi

inner="$(mktemp)"
trap 'rm -f "$inner"' EXIT
tar xOf "$PACKAGE" app.tar.gz > "$inner"
if tar tf "$inner" | grep -q '^assets/'; then
  echo "[CHECK] package: FAIL (app.tar.gz contains assets/; the image belongs at the package top level)" >&2
  [[ "$CHECK" == "1" ]] && exit 4
  die "app.tar.gz must not contain assets/"
fi
manifest="$(tar xOf "$inner" manifest.yml 2>/dev/null || true)"
app_id="$(awk '/^id:[[:space:]]*/ {print $2; exit}' <<< "$manifest")"
version="$(awk '/^version:[[:space:]]*/ {print $2; exit}' <<< "$manifest")"
[[ -n "$app_id" && -n "$version" ]] || die "cannot read id/version from manifest.yml"

if [[ -z "$VOLUME_ID" ]]; then
  here="$(cd "$(dirname "$0")" && pwd)"
  if [[ -f "$here/device-paths.sh" ]]; then
    # device-paths.sh 在拿不到宿主路径时以 2 退出；由 --check 报告，不能中断脚本。
    VOLUME_ID="$(bash "$here/device-paths.sh" --json 2>/dev/null \
      | sed -n 's/.*"volume_root":"[^"]*\/\([^"/]*\)".*/\1/p')" || true
  fi
fi

if [[ "$CHECK" == "1" ]]; then
  rc=0
  echo "[CHECK] package: ok (outer) app=${app_id} version=${version}"
  if curl -sk -m 5 -o /dev/null "$GATEWAY/v1000/openapi.json"; then
    echo "[CHECK] gateway: ok (${GATEWAY})"
  else
    echo "[CHECK] gateway: FAIL (${GATEWAY} unreachable)" >&2
    [[ "$rc" == "0" ]] && rc=3
  fi
  [[ -n "$VOLUME_ID" ]] && echo "[CHECK] volume: ${VOLUME_ID}" || echo "[CHECK] volume: FAIL (no --volume-id and no derivable VOLUME_ROOT)" >&2
  if [[ -n "$TOKEN" ]]; then
    body="$(curl -sk -m 8 -H "Authorization: Bearer $TOKEN" "$GATEWAY/v1000/user/check" || true)"
    if [[ "$(json_field code "$body")" == "0" ]]; then
      echo "[CHECK] token: ok"
    else
      echo "[CHECK] token: FAIL ($(json_field msg "$body"))" >&2
      [[ "$rc" == "0" ]] && rc=5
    fi
  else
    echo "[CHECK] token: FAIL (VOS_TOKEN or --token missing)" >&2
    [[ "$rc" == "0" ]] && rc=5
  fi
  echo "[CHECK] result: $([[ "$rc" == "0" ]] && echo ready || echo blocked) (exit ${rc})"
  exit "$rc"
fi

[[ -n "$TOKEN" ]] || die "access token required: pass --token or set VOS_TOKEN"
[[ -n "$VOLUME_ID" ]] || die "volume id required: pass --volume-id or run inside the v-harness container so device-paths.sh can derive it"
[[ -n "$CONFIGS" ]] || CONFIGS='{}'

echo "[INFO] upload ${PACKAGE##*/} (${app_id} ${version}) to ${GATEWAY}"
upload="$(curl -sk -X POST "$GATEWAY/v1000/app-store/upload_app" \
  -H "Authorization: Bearer $TOKEN" -F "package=@${PACKAGE}" || true)"
code="$(json_field code "$upload")"
[[ "$code" == "0" ]] || die "upload_app failed: ${upload:0:300}"
source_id="$(json_field source_id "$upload")"
[[ -n "$source_id" ]] || die "upload_app returned no source_id: ${upload:0:300}"
echo "[INFO] source_id=${source_id}"

echo "[INFO] install ${app_id} ${version} into volume ${VOLUME_ID}"
result="$(curl -sk -X POST "$GATEWAY/v1000/app-store/install" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"source_id\":\"${source_id}\",\"app_id\":\"${app_id}\",\"version\":\"${version}\",\"volume_id\":\"${VOLUME_ID}\",\"user_configs\":${CONFIGS}}" || true)"
code="$(json_field code "$result")"
if [[ "$code" != "0" ]]; then
  echo "[ERROR] install failed: ${result:0:400}" >&2
  exit 2
fi

echo "[INFO] installed; status:"
curl -sk -H "Authorization: Bearer $TOKEN" \
  "$GATEWAY/v1000/app/status?app_id=${app_id}" | head -c 600
echo
