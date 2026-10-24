# v-harness container: gateway + one dsh process per user.
#
# Build context is the repository root (see .dockerignore, which keeps the dsh
# monorepo out of the context):
#   docker build -f Dockerfile -t v-harness .
#
# The gateway runs as root because it must spawn each user's dsh process through
# `runuser`. That is the container's only privileged action: every filesystem
# mutation goes through bin/vh-userctl, and the only bytes the gateway reads
# from a user home are the dsh launch URL on that process's stdout.
# Base image is overridable so the build host can pull it from SWR instead of
# Docker Hub; build_image.sh mirrors it once and reuses it afterwards.
ARG BASE_IMAGE=node:22-bookworm-slim
# ============================================================
# Stage: browser plugins built from this repository
# ============================================================
# A user's dsh profile installs its web bundles from the npm registry, so a
# panel built in this repository would be replaced by the published copy the
# first time a user signs in. The image therefore carries its own build, and
# gateway/plugins.mjs copies it over the profile's copy.
#
# The build happens here so that every build host needs only Docker: the
# toolchain, the dependency install, and the compilation all run inside the
# image, and the same source produces the same plugin on every host. The
# alternative -- building the plugin on the host and copying the result in --
# makes the image depend on the build host's Node toolchain and on whatever
# happened to be in the build directory, so a second host builds a different
# image.
FROM ${BASE_IMAGE} AS plugins

ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV npm_config_registry=${NPM_REGISTRY}
WORKDIR /build

# pnpm is pinned to the repository's own version (packageManager in
# package.json) so the dependency tree resolves the same way on every host.
RUN corepack enable

# Manifests first: the dependency install is the slow layer, and it only
# changes when the lockfile does.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY vendor/ vendor/
COPY packages/ packages/
COPY scripts/ scripts/
COPY native/ native/
COPY apps/ apps/
COPY benchmarks/ benchmarks/
COPY website/ website/
COPY python/ python/
COPY tsconfig*.json ./
COPY tsdown.config.ts ./

# The whole workspace is installed. The plugin is a package of this monorepo,
# and its compilation reads declarations that other workspace packages
# produce, so those packages are build-time dependencies of the plugin and the
# install cannot be narrowed to a runtime closure.
RUN pnpm install --frozen-lockfile --ignore-scripts

# The client compilation reads generated declarations (the Typert /remote
# artifacts), which the Host side produces from source. Generating them is a
# separate pass that needs no Host bundle, so it runs before the client
# compilation instead of a full Host build.
RUN node --import tsx/esm scripts/generate-typert.ts

# The agent-plugins stage inherits this one and its staging script reads the
# carrier bundle from gateway/agent-plugins/. Copied after the install so
# gateway edits never invalidate the dependency layers.
COPY gateway/ gateway/

# Compile the plugin's project graph, then bundle it. The bundle is the
# browser artifact gateway/plugins.mjs ships into each user's profile.
RUN pnpm exec tsc -b packages/client/ui-knowledge/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-ui-knowledge bundle \
 && mkdir -p /build/plugins/dsh-client-ui-knowledge \
 && cp -R \
      packages/client/ui-knowledge/package.json \
      packages/client/ui-knowledge/lib \
      packages/client/ui-knowledge/locale \
      /build/plugins/dsh-client-ui-knowledge/ \
 && pnpm exec tsc -b packages/client/ui-tool-cards/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-ui-tool-cards bundle \
 && mkdir -p /build/plugins/dsh-client-ui-tool-cards \
 && cp -R \
      packages/client/ui-tool-cards/package.json \
      packages/client/ui-tool-cards/lib \
      packages/client/ui-tool-cards/locale \
      /build/plugins/dsh-client-ui-tool-cards/ \
 && pnpm exec tsc -b packages/client/ui-user-questions/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-ui-user-questions bundle \
 && mkdir -p /build/plugins/dsh-client-ui-user-questions \
 && cp -R \
      packages/client/ui-user-questions/package.json \
      packages/client/ui-user-questions/lib \
      packages/client/ui-user-questions/locale \
      /build/plugins/dsh-client-ui-user-questions/

# The `@` source over the signed-in user's V-Office folder. Unpublished, so no
# profile dependency graph names it: the carrier bundle mounts the row and
# gateway/plugins.mjs creates the profile copy from this payload.
RUN pnpm exec tsc -b packages/client/ui-voffice/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-ui-voffice bundle \
 && mkdir -p /build/plugins/dsh-client-ui-voffice \
 && cp -R \
      packages/client/ui-voffice/package.json \
      packages/client/ui-voffice/lib \
      packages/client/ui-voffice/locale \
      /build/plugins/dsh-client-ui-voffice/

# The locale plugin follows the language VOS publishes (the vos_platform
# bridge and the stamped preferences-locale entry). That support postdates
# the published dsh the runtime stage installs, so the image builds it from
# this repository and gateway/plugins.mjs overlays the profile's copy.
RUN pnpm exec tsc -b packages/client/locale/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-locale bundle \
 && mkdir -p /build/plugins/dsh-client-locale \
 && cp -R packages/client/locale/package.json packages/client/locale/lib /build/plugins/dsh-client-locale/

# Managed VOS model discovery and settings use local Host and Client builds.
# These land in the same /build/plugins tree the runtime stage copies, so the
# overlay loop below finds every package it names.
RUN pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries \
 && pnpm exec tsc -b packages/client/ui-settings-models/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-ui-settings-models bundle \
 && pnpm --filter @deepseek-ai/dsh-api-remotes bundle \
 && for spec in \
      client/ui-settings-models:dsh-client-ui-settings-models \
      llm/llm-pi-ai:dsh-llm-pi-ai \
      api/session-controller:dsh-api-session-controller \
      api/remotes:dsh-api-remotes; do \
      source="${spec%:*}"; name="${spec#*:}"; \
      mkdir -p "/build/plugins/$name"; \
      cp -R "packages/$source/package.json" "packages/$source/lib" "/build/plugins/$name/"; \
      if [ -d "packages/$source/locale" ]; then cp -R "packages/$source/locale" "/build/plugins/$name/"; fi; \
    done

# ============================================================
# Stage: agent-side tool plugins built from this repository
# ============================================================
# The fork's agent-side tool plugins (V-Office, AI-album, Image Studio) are
# unpublished, so a tenant profile assembled from the npm registry neither
# carries their packages nor mounts their rows. This stage builds them the
# way the publish flow does — `tsc -b` walks the project references so the
# dependency closure compiles without manual ordering, and the scoped tsdown
# pass emits the `lib/index.js` entry a hand-copied tsc output lacks — then
# scripts/stage-agent-plugins.ts stages the packages plus their computed
# dependency closure. It inherits the plugins stage to reuse the workspace
# install; a second full install would cost more than the serialized build.
FROM plugins AS agent-plugins

RUN pnpm exec tsc -b $(sed 's|$|/tsconfig.json|' gateway/agent-plugins/plugins.txt) \
 && pnpm exec tsdown --config-loader native --config scripts/agent-plugins.tsdown.config.ts \
 && node --import tsx/esm scripts/stage-agent-plugins.ts \
      --out /build/agent-plugins

# ============================================================
# Stage: runtime image
# ============================================================
FROM ${BASE_IMAGE}

ARG DSH_VERSION=0.2.1-rc.2
ARG NPM_REGISTRY=https://registry.npmmirror.com
# Build hosts behind a restricted network cannot reach deb.debian.org; the
# mirror is overridable, and an empty value keeps the image's own sources.
ARG APT_MIRROR=mirrors.huaweicloud.com

ENV NODE_ENV=production \
    DATA_ROOT=/data \
    PORT=8080 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DSH_BIN=/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js

# Build toolchain is a product requirement, not a convenience: plugins that ship
# native modules (node-pty, ssh2, better-sqlite3) run `node-gyp` at install time
# inside the user's own profile. Without gcc/make/python3 every such plugin
# fails, which removes a large part of why dsh is extensible at all.
# Costs roughly 300 MB in the image; it does not slow down users who install
# pure-JS plugins, because nothing is compiled for them.
RUN if [ -n "${APT_MIRROR}" ]; then \
      for source in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$source" ]; then \
          sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" "$source"; \
        fi; \
      done; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      sudo util-linux ca-certificates \
      build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# pnpm is needed the first time a user's profile installs its bundles.
RUN corepack enable \
 && npm config set registry "${NPM_REGISTRY}" \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

COPY gateway/ /opt/v-harness/gateway/
COPY gateway/vos.patch.yml /usr/local/share/v-harness/vos.patch.yml
COPY bin/ /opt/v-harness/bin/
# Product skills are discovered through DSH_BUNDLED_SKILL_DIR (see
# gateway/instances.mjs) and stay root-owned, so a tenant cannot edit them.
COPY skills/ /opt/v-harness/skills/
# Browser plugins built from this repository. A user's dsh profile installs its
# web bundles from the registry, so gateway/plugins.mjs copies each of these
# over the published copy right after dsh finishes installing the profile.
COPY --from=plugins /build/plugins/ /opt/v-harness/plugins/
RUN set -eu; for name in dsh-client-ui-settings-models dsh-llm-pi-ai dsh-api-session-controller dsh-api-remotes dsh-client-locale; do \
      source="/opt/v-harness/plugins/$name"; \
      target="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/$(basename "$source")"; \
      test -f "$target/package.json"; \
      cp -R "$source/lib/." "$target/lib/"; \
      if [ -d "$source/locale" ]; then cp -R "$source/locale/." "$target/locale/"; fi; \
    done

# Agent-side tool plugins plus their carrier bundle (manifest.json lists the
# plugins); gateway/plugins.mjs copies them into each tenant profile and
# mounts the carrier before dsh starts.
COPY --from=agent-plugins /build/agent-plugins/ /opt/v-harness/agent-plugins/

RUN chmod 0755 /opt/v-harness/bin/vh-userctl /opt/v-harness/bin/vh-file /opt/v-harness/bin/vh-jail \
      /opt/v-harness/bin/vh-file-impl.mjs /opt/v-harness/bin/entrypoint /opt/v-harness/bin/sandbox-probe.mjs \
 && chmod 0755 /opt/v-harness/skills/voffice/scripts/voffice.mjs /opt/v-harness/skills/album/scripts/album.mjs /opt/v-harness/skills/weknora/scripts/weknora.mjs \
 && chown -R root:root /opt/v-harness/bin \
 && printf 'root ALL=(root) NOPASSWD: /opt/v-harness/bin/vh-userctl, /opt/v-harness/bin/vh-file\n' > /etc/sudoers.d/vh \
 && chmod 0440 /etc/sudoers.d/vh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/__vh/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/v-harness/bin/entrypoint"]
