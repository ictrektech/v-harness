#!/usr/bin/env bash
# Repair the dsh profiles that the `link:` bundle dependencies broke.
#
# A previous revision of gateway/plugins.mjs declared vh-agent-plugins, dshmarket
# and ds-bot as `link:/opt/v-harness/...` dependencies of the tenant profile.
# `pnpm install` runs inside the tenant's jail, where that path does not exist,
# so the install failed and left the profile's node_modules incomplete: the
# browser bundles resolved from there never activated ("1 entry did not
# activate"). The module no longer writes those entries and drops a stale one on
# sight; this script applies that to profiles already on disk.
#
# Usage: bash ictrek.app/scripts/hotfix-plugins.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

mapfile -t containers < <(docker ps --format '{{.Names}}' | grep 'v-harness' || true)
[[ ${#containers[@]} -gt 0 ]] || { echo '没有运行中的 v-harness 容器' >&2; exit 1; }

for container in "${containers[@]}"; do
  printf '\n== %s\n' "$container"

  docker cp gateway/plugins.mjs "$container:/opt/v-harness/gateway/plugins.mjs"

  # Clear the stale dependency, then drop only the unfinished pieces so the next
  # launch reinstalls them: the whole tree is not thrown away, one missing
  # package is.
  docker exec "$container" node -e '
    const { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
    const fixed = [];
    for (const entry of readdirSync("/data", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profile = `/data/${entry.name}/.dsh/profiles/web`;
      const manifestPath = `${profile}/package.json`;
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const deps = manifest.dependencies ?? {};
      const stale = Object.keys(deps).filter(name => String(deps[name]).startsWith("link:/opt/v-harness"));
      if (stale.length === 0) continue;
      for (const name of stale) delete deps[name];
      manifest.dependencies = deps;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(`${profile}/pnpm-lock.yaml`, { force: true });
      rmSync(`${profile}/node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse`, { recursive: true, force: true });
      fixed.push(`${entry.name}: ${stale.join(", ")}`);
    }
    console.log(fixed.length === 0 ? "没有残留的 link 依赖" : `已清除依赖 — ${fixed.join("; ")}`);
  '

  docker restart "$container" >/dev/null
  echo '-- 容器已重启'
done

cat <<'TIP'

下一步（只做这个）：
  1. 打开页面并刷新一次 —— 实例启动时会重装依赖，页面会先失败一次再恢复
  2. 若仍是 Failed to load plugins，等 60 秒再刷新一次
  3. 还在失败就把日志给我：/data/.vh/logs/<账号>.log
TIP
