#!/usr/bin/env bash
# device-paths.sh — 打印本应用在装好的 VOS 设备上的宿主路径。
#
# 应用容器里看不到 /share，但 install_local 的 package_path 与 app_storage_path 都是
# 宿主路径。脚本从本容器的 /data 挂载来源反推宿主路径，因此不需要凭据，也不依赖卷 UUID。
#
# 用法：
#   bash device-paths.sh               打印 HOST_DATA / VOLUME_ROOT
#   bash device-paths.sh --json        输出 JSON
#   bash device-paths.sh --pkg-dir todo-app/pkg   打印某个子目录的宿主路径
#
# 退出码：0 成功；2 无法确定宿主路径（容器没有挂载 docker socket，也没有宿主机路径环境变量）。

set -euo pipefail

die() {
  echo "[ERROR] $*" >&2
  exit 2
}

JSON=0
PKG_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --pkg-dir) PKG_DIR="${2:?--pkg-dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# 1) 首选：用挂进容器的 docker socket 读自己的 /data 挂载来源。
host_data=""
if [[ -S /var/run/docker.sock ]] && command -v docker >/dev/null 2>&1; then
  host_data="$(docker inspect "$(hostname)" \
    --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
fi

# 2) 退路：平台可能直接注入宿主路径。
if [[ -z "$host_data" && -n "${VOS_APP_STORAGE_PATH:-}" ]]; then
  host_data="${VOS_APP_STORAGE_PATH%/}"
fi

[[ -n "$host_data" ]] || die "cannot determine the host path of /data: no docker socket and no VOS_APP_STORAGE_PATH"

volume_root=""
case "$host_data" in
  /share/*) volume_root="/share/$(printf '%s' "$host_data" | cut -d/ -f3)" ;;
esac

pkg_host=""
[[ -n "$PKG_DIR" ]] && pkg_host="${host_data%/}/${PKG_DIR#/}"

if [[ "$JSON" == "1" ]]; then
  printf '{"host_data":"%s","volume_root":"%s","pkg_host":"%s"}\n' \
    "$host_data" "$volume_root" "$pkg_host"
else
  echo "HOST_DATA=${host_data}"
  echo "VOLUME_ROOT=${volume_root:-<not-a-share-volume>}"
  [[ -n "$PKG_DIR" ]] && echo "PKG_HOST=${pkg_host}"
fi
