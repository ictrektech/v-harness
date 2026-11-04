#!/usr/bin/env bash
# Move a running v-harness container onto the per-tenant network namespace
# implementation without rebuilding the image.
#
# Everything the change needs that is *not* an image layer is copied into the
# container here; the two image-layer pieces (`passt`, `/dev/net/tun`) are
# supplemented in place, which survives `docker restart` and is lost only when
# the container is recreated.
#
# Usage: bash ictrek.app/scripts/hotfix-network.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# The files this change touches. Keep in step with the commit: a stale entry is
# copied over the container as-is, a missing one leaves the container half
# upgraded, so the list is checked up front.
FILES=(
  gateway/netns.mjs
  gateway/instances.mjs
  gateway/server.mjs
  gateway/services.mjs
  gateway/scheduler.mjs
  gateway/plugins.mjs
  bin/vh-jail
  bin/entrypoint
  bin/network-probe.mjs
)

for file in "${FILES[@]}"; do
  [[ -f "$file" ]] || { printf '缺少文件: %s\n' "$file" >&2; exit 1; }
done

mapfile -t containers < <(docker ps --format '{{.Names}}' | grep 'v-harness' || true)
[[ ${#containers[@]} -gt 0 ]] || { echo '没有运行中的 v-harness 容器' >&2; exit 1; }

for container in "${containers[@]}"; do
  printf '\n== %s\n' "$container"

  # 1. pasta is the tenant's network. When the image predates it, install it into
  #    the container's writable layer: a restart keeps it, a recreate does not.
  if ! docker exec "$container" command -v pasta >/dev/null 2>&1; then
    echo '-- 容器里没有 pasta，安装 passt'
    docker exec "$container" sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends passt'
  fi

  # 2. pasta creates the namespace tap through this node.
  if ! docker exec "$container" test -c /dev/net/tun; then
    echo '-- 补 /dev/net/tun'
    if ! docker exec "$container" sh -c 'mkdir -p /dev/net && mknod /dev/net/tun c 10 200 && chmod 666 /dev/net/tun' 2>/dev/null; then
      printf '!! 无法在容器内创建 /dev/net/tun。给 compose 加 devices: ["/dev/net/tun"]，recreate 容器后再跑本脚本\n' >&2
      exit 1
    fi
  fi

  # 3. The code itself: plain ESM and shell, replaced in place.
  for file in "${FILES[@]}"; do
    docker cp "$file" "$container:/opt/v-harness/$file"
  done
  docker exec "$container" chmod 0755 /opt/v-harness/bin/vh-jail /opt/v-harness/bin/entrypoint

  # 4. Prove the network works before touching the running gateway: a failed
  #    probe leaves the old process serving, a passed one cannot regress.
  if ! docker exec "$container" node /opt/v-harness/bin/network-probe.mjs; then
    printf '!! 网络自检失败，容器保持原状（见上面的 detail）\n' >&2
    exit 1
  fi

  # 5. Restart so the entrypoint and the gateway pick up the new code.
  docker restart "$container" >/dev/null
  printf -- '-- 已重启，等待启动自检'
  for _ in $(seq 1 60); do
    if docker logs --tail 80 "$container" 2>&1 | grep -q 'listening on'; then break; fi
    printf '.'
    sleep 1
  done
  printf '\n'

  # 6. Report what a user would hit, in one line per tenant.
  docker exec "$container" sh -c '
    printf "网关健康      %s\n" "$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/__vh/health || echo err)"
  ' || true

  docker exec "$container" node -e '
    const t = require("/data/.vh/users.json");
    for (const r of Object.values(t)) {
      const u = r.uid;
      console.log(`${r.account} 127.${Math.floor(u / 256) % 254 + 1}.${u % 256}.1 ${r.port}`);
    }
  ' 2>/dev/null | while read -r account address port; do
    [[ -n "${account:-}" ]] || continue
    printf '租户 %-12s 网关→租户 %-3s 租户→网关 %s\n' "$account" \
      "$(docker exec "$container" curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$address:$port/" 2>/dev/null || echo err)" \
      "$(docker exec "$container" ip netns exec "vh-$account" curl -sS -m 5 -o /dev/null -w '%{http_code}' http://10.0.2.2:8080/__vh/health 2>/dev/null || echo err)"
  done

  echo '-- 判定：网关→租户不是 000（302/200/401 都算通），租户→网关是 200'
done

printf '\n完成。浏览器登录后仍要验一次：首页、侧栏「服务」、点「打开」。\n'
