#!/usr/bin/env bash
set -euo pipefail

# 上传 dist/ 下的外层包并安装到本机 VOS，只用 curl 与 python3。
#
# 流程：登录 -> upload_app 取 #local: source_id -> 查是否已安装 -> install_async 或
# upgrade_async -> 轮询 /v1000/app/status 到终态。
#
# 退出码：0 成功或跳过；2 平台业务错误或安装失败；3 缺目标卷；4 轮询超时；5 登录失败。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${ROOT}/dist"

GATEWAY="${VOS_GATEWAY:-https://172.17.0.1:1180}"
GATEWAY="${GATEWAY%/}"
ADMIN_USER="${VOS_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${VOS_ADMIN_PASSWORD:-}"
TOKEN="${VOS_TOKEN:-}"
VOLUME_ID="${VOS_VOLUME_ID:-}"
VOLUME_NAME="${VOS_VOLUME:-}"
PROFILES="${VOS_PROFILES:-}"
PACKAGE="${VOS_PACKAGE:-}"
TIMEOUT="${VOS_INSTALL_TIMEOUT:-900}"
CONTEXT_TOKEN_FILE="${VOS_CONTEXT_TOKEN_FILE:-/var/lib/vos-context/access-token}"
TLS_FLAG=(-k)
if [[ "${VOS_TLS_VERIFY:-0}" == "1" ]]; then
  TLS_FLAG=()
fi

die() { echo "[ERROR] $*" >&2; exit 2; }
skip() { echo "[WARN] $*" >&2; exit 0; }

usage() {
  cat <<'EOF'
Usage: bash ictrek.app/scripts/install-to-vos.sh [options]

Options:
  --package PATH     外层归档（缺省取 dist/*-*.tar 的第一个）
  --gateway URL      平台地址（缺省 https://172.17.0.1:1180）
  --volume-id UUID   首次安装的目标卷
  --volume NAME      首次安装的目标卷名（nick_name 或 alias）
  --profiles LIST    逗号分隔的 profile，缺省按包名架构推导（amd64 -> amd，arm64 -> arm）
  --timeout SEC      轮询超时，缺省 900
  -h, --help         显示帮助

环境变量：VOS_ADMIN_USER / VOS_ADMIN_PASSWORD 或 VOS_TOKEN。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGE="${2:?--package needs a value}"; shift 2 ;;
    --gateway) GATEWAY="${2:?--gateway needs a value}"; GATEWAY="${GATEWAY%/}"; shift 2 ;;
    --volume-id) VOLUME_ID="${2:?--volume-id needs a value}"; shift 2 ;;
    --volume) VOLUME_NAME="${2:?--volume needs a value}"; shift 2 ;;
    --profiles) PROFILES="${2:?--profiles needs a value}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[ERROR] unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "missing command: curl"
command -v python3 >/dev/null 2>&1 || die "missing command: python3"

# 从 ResultBody JSON 取字段，路径用点分隔（如 data.source_id）。
jget() {
  VOS_JSON="$1" VOS_FIELD="$2" python3 - <<'PY'
import json, os
try:
    cur = json.loads(os.environ["VOS_JSON"])
except Exception:
    print("")
    raise SystemExit(0)
for key in os.environ["VOS_FIELD"].split("."):
    cur = cur.get(key) if isinstance(cur, dict) else None
    if cur is None:
        break
if cur is None:
    print("")
elif isinstance(cur, str):
    print(cur)
else:
    print(json.dumps(cur, ensure_ascii=False, separators=(",", ":")))
PY
}

# 从 volumes/list 响应里取 nick_name 或 alias 匹配的 uuid。
volume_uuid() {
  VOS_BODY="$1" VOS_NAME="$2" python3 - <<'PY'
import json, os
try:
    items = json.loads(os.environ["VOS_BODY"])["data"]["data"]
except Exception:
    items = []
name = os.environ["VOS_NAME"]
for item in items or []:
    if item.get("nick_name") == name or name in (item.get("alias") or []):
        print(item.get("uuid") or "")
        break
PY
}

api() {
  local method="$1" path="$2" max="${3:-30}" out
  shift 3
  if out="$(curl "${TLS_FLAG[@]}" -sS -m "$max" -X "$method" "${GATEWAY}${path}" "$@" 2>&1)"; then
    printf '%s' "$out"
  else
    echo "[ERROR] ${method} ${path} failed: ${out:0:300}" >&2
    return 1
  fi
}

# 平台给应用注入的上下文令牌；挂在 /var/lib/vos-context 时直接用它。
if [[ -z "$TOKEN" && -z "$ADMIN_PASSWORD" && -f "$CONTEXT_TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '[:space:]' < "$CONTEXT_TOKEN_FILE")"
fi

if [[ -z "$ADMIN_PASSWORD" && -z "$TOKEN" ]]; then
  skip "no VOS_ADMIN_PASSWORD / VOS_TOKEN / ${CONTEXT_TOKEN_FILE}; skip install"
fi

if [[ -z "$PACKAGE" ]]; then
  PACKAGE="$(ls -1 "${DIST}"/*-*.tar 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$PACKAGE" || ! -f "$PACKAGE" ]]; then
  skip "no offline package under ${DIST}; skip install"
fi

# 按包名末段推导 profile 名；升级时后端沿用旧记录。
if [[ -z "$PROFILES" ]]; then
  arch="$(basename "$PACKAGE")"
  arch="${arch%.tar}"
  arch="${arch##*-}"
  case "$arch" in
    amd64) PROFILES="amd" ;;
    arm64) PROFILES="arm" ;;
    *) PROFILES="" ;;
  esac
fi
profiles_field=""
if [[ -n "$PROFILES" ]]; then
  profiles_json="$(printf '%s' "$PROFILES" | python3 -c 'import json,sys; print(json.dumps([p.strip() for p in sys.stdin.read().split(",") if p.strip()]))')"
  profiles_field=",\"profiles\":${profiles_json}"
fi

if [[ -z "$TOKEN" ]]; then
  body="$(api POST /v1000/user/login 30 \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\",\"application\":\"\"}" || true)"
  TOKEN="$(jget "$body" data.access_token)"
  if [[ -z "$TOKEN" ]]; then
    echo "[ERROR] login failed: ${body:0:300}" >&2
    exit 5
  fi
fi
AUTH=(-H "Authorization: Bearer ${TOKEN}")

echo "[INFO] upload ${PACKAGE##*/} to ${GATEWAY}"
body="$(api POST /v1000/app-store/upload_app 600 "${AUTH[@]}" -F "package=@${PACKAGE}" || true)"
source_id="$(jget "$body" data.source_id)"
app_id="$(jget "$body" data.app_id)"
version="$(jget "$body" data.version)"
if [[ -z "$source_id" || -z "$app_id" ]]; then
  echo "[ERROR] upload_app failed: ${body:0:400}" >&2
  exit 2
fi
echo "[INFO] source_id=${source_id} app=${app_id} version=${version}"

status="$(api GET "/v1000/app/status?app_id=${app_id}" 30 "${AUTH[@]}" || true)"
state="$(jget "$status" data.state)"
case "$state" in
  installed|running|stopped) installed=1 ;;
  *) installed=0 ;;
esac

if [[ "$installed" == "1" ]]; then
  echo "[INFO] already installed (state=${state}); submit upgrade"
  payload="{\"source_id\":\"${source_id}\",\"app_id\":\"${app_id}\",\"version\":\"${version}\",\"user_configs\":{}}"
  endpoint=/v1000/app-store/upgrade_async
else
  if [[ -z "$VOLUME_ID" && -n "$VOLUME_NAME" ]]; then
    list="$(api POST /v1000/nas/volumes/list 30 "${AUTH[@]}" \
      -H 'Content-Type: application/json' -d '{}' || true)"
    VOLUME_ID="$(volume_uuid "$list" "$VOLUME_NAME")"
  fi
  if [[ -z "$VOLUME_ID" ]]; then
    echo "[ERROR] first install needs --volume-id / --volume / VOS_VOLUME_ID (state=${state:-unknown})" >&2
    exit 3
  fi
  echo "[INFO] first install into volume ${VOLUME_ID}"
  payload="{\"source_id\":\"${source_id}\",\"app_id\":\"${app_id}\",\"version\":\"${version}\",\"user_configs\":{},\"volume_id\":\"${VOLUME_ID}\"${profiles_field}}"
  endpoint=/v1000/app-store/install_async
fi

body="$(api POST "$endpoint" 60 "${AUTH[@]}" -H 'Content-Type: application/json' -d "$payload" || true)"
code="$(jget "$body" code)"
if [[ "$code" != "0" ]]; then
  echo "[ERROR] ${endpoint} rejected: ${body:0:400}" >&2
  exit 2
fi
task_id="$(jget "$body" data.task_id)"
echo "[INFO] task_id=${task_id} submitted; waiting for the workflow"

deadline=$(( $(date +%s) + TIMEOUT ))

# 等 workflow 到终态；未结束前不读应用状态，避免读到升级前的旧记录。
wait_workflow() {
  local task task_status failure
  [[ -n "$task_id" ]] || return 0
  while :; do
    task="$(api GET "/v1000/async-task/get?task_id=${task_id}" 30 "${AUTH[@]}" || true)"
    task_status="$(jget "$task" data.status)"
    case "$task_status" in
      ""|"Running"|"Pending"|"Scheduled")
        echo "[INFO] workflow ${task_status:-<pending>}"
        ;;
      *)
        failure="$(jget "$task" data.failure)"
        if [[ -n "$failure" ]]; then
          echo "[ERROR] workflow ${task_status}: ${failure:0:400}" >&2
          return 2
        fi
        echo "[INFO] workflow ${task_status}"
        return 0
        ;;
    esac
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      echo "[ERROR] workflow did not finish within ${TIMEOUT}s" >&2
      return 4
    fi
    sleep 3
  done
}

# 等应用状态到终态。
wait_app() {
  local status state
  while :; do
    status="$(api GET "/v1000/app/status?app_id=${app_id}" 30 "${AUTH[@]}" || true)"
    state="$(jget "$status" data.state)"
    case "$state" in
      installed|running|stopped)
        echo "[INFO] state=${state}; install done"
        return 0
        ;;
      error)
        echo "[ERROR] install failed: $(jget "$status" data.last_error)" >&2
        return 2
        ;;
      *)
        echo "[INFO] state=${state:-<pending>}"
        ;;
    esac
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      echo "[ERROR] timeout after ${TIMEOUT}s (last state=${state:-<pending>})" >&2
      return 4
    fi
    sleep 3
  done
}

wait_workflow || exit $?
wait_app || exit $?
