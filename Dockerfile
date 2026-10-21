# v-harness container: gateway + one dsh process per user.
#
# No `# syntax=` frontend directive on purpose: it makes the build pull
# docker/dockerfile from Docker Hub before the first instruction runs, and a
# build host that cannot reach Docker Hub dies with "frontend grpc server closed
# unexpectedly". Everything below, including `RUN --mount=type=cache`, is
# understood by the frontend built into the engine (Docker 23+ / BuildKit).
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
# Build hosts behind a restricted network cannot reach deb.debian.org; the
# mirror is overridable, and an empty value keeps the image's own sources.
# USTC is the default because it measured about four times faster than the Ali
# mirror from the build hosts in use. Keep the value stable: it is part of the
# cache key for the toolchain stage below.
ARG APT_MIRROR=mirrors.ustc.edu.cn

# ============================================================
# Stage: build toolchain shared by every later stage
# ============================================================
# Build toolchain is a product requirement, not a convenience: plugins that ship
# native modules (node-pty, ssh2, better-sqlite3) run `node-gyp` at install time
# inside the user's own profile. Without gcc/make/python3 every such plugin
# fails, which removes a large part of why dsh is extensible at all.
# Costs roughly 300 MB in the image; it does not slow down users who install
# pure-JS plugins, because nothing is compiled for them.
#
# One stage installs it for both consumers: the dsh build compiles native
# dependencies too, and the runtime ships the toolchain for user profiles.
# This stage reads only the base image and the mirror argument, so its layers
# stay cached across source changes; the apt lists live in a cache mount, which
# keeps them between builds without leaving them in the image.
FROM ${BASE_IMAGE} AS base-tools

ARG APT_MIRROR

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    if [ -n "${APT_MIRROR}" ]; then \
      for source in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$source" ]; then \
          sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" "$source"; \
        fi; \
      done; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      sudo util-linux ca-certificates \
      git build-essential python3

# ============================================================
# Stage: browser plugins built from this repository
# ============================================================
# A user's dsh profile installs its web bundles from the npm registry, so a
# panel built in this repository would be replaced by the published copy the
# first time a user signs in. The image therefore carries its own build; the
# profile copy gateway/plugins.mjs writes is a fallback, because dsh resolves a
# bundle from its own installation tree before it looks at the profile.
#
# The build happens here so that every build host needs only Docker: the
# toolchain, the dependency install, and the compilation all run inside the
# image, and the same source produces the same plugin on every host. The
# alternative -- building the plugin on the host and copying the result in --
# makes the image depend on the build host's Node toolchain and on whatever
# happened to be in the build directory, so a second host builds a different
# image.
FROM base-tools AS plugins

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

# Compile each plugin's project graph, then bundle it. A bundle is the browser
# artifact gateway/plugins.mjs ships into each user's profile.
RUN pnpm exec tsc -b packages/client/ui-knowledge/tsconfig.json packages/client/ui-user-questions/tsconfig.json \
 && pnpm --filter @deepseek-ai/dsh-client-ui-knowledge bundle \
 && pnpm --filter @deepseek-ai/dsh-client-ui-user-questions bundle \
 && for plugin in ui-knowledge ui-user-questions; do \
      mkdir -p "/build/plugins/dsh-client-$plugin" \
      && cp -R \
           "packages/client/$plugin/package.json" \
           "packages/client/$plugin/lib" \
           "packages/client/$plugin/locale" \
           "/build/plugins/dsh-client-$plugin/"; \
    done

# ============================================================
# Stage: the dsh runtime built from this repository
# ============================================================
# The image runs this checkout, not the published package: publishing a change
# under `packages/` is a separate release sequence, so an image built from the
# registry would keep shipping whatever that sequence last published.
#
# This stage reuses the plugins stage's workspace, so the dependency install,
# the generated declarations and the toolchain are not repeated. `pack` writes
# one tarball per publishable package, and the runtime installs those tarballs
# rather than resolving versions: a version that already exists on the registry
# must never stand in for the build.
FROM plugins AS dsh

# The client build stamps the commit it compiled into every bundle, and it
# reads that value from git only when the variable below is unset. The build
# context excludes .git, so the value arrives as an argument: the checkout the
# host built from is the authority, and a placeholder keeps a bare
# `docker build` from failing on a repository it cannot see.
#
# Declared here rather than above the toolchain on purpose: this value changes
# with every commit, and a declaration invalidates the cache of every RUN that
# follows it. With the toolchain moved to base-tools, a new commit reruns only
# this build instead of the apt install as well.
ARG GIT_COMMIT=0000000
ENV DSH_CLIENT_COMMIT_HASH=${GIT_COMMIT}

RUN pnpm run build:artifacts

RUN node --import tsx/esm scripts/release/pack.ts --family dsh --out /build/npm/dsh \
 && node --import tsx/esm scripts/release/pack.ts --family vendor --out /build/npm/vendor \
 && node --import tsx/esm scripts/packed-runtime-manifest.ts \
      --out /build/runtime \
      --install-prefix /build/npm \
      --from /build/npm/dsh \
      --from /build/npm/vendor

# Install the runtime in this stage, not in the final image. The tarballs are
# build inputs, and installing them in the runtime stage would leave a COPY
# layer holding every `.tgz` behind the `rm` that deletes them: a later layer
# only adds a whiteout, so the bytes stay in the image. Installing here keeps
# the tarballs in a stage the image never carries, and the final stage copies
# one directory that is already a working installation.
RUN cd /build/runtime \
 && npm install --omit=optional --no-audit --no-fund --package-lock=false \
 && npm cache clean --force \
 && rm -rf /build/npm

# ============================================================
# Stage: runtime image
# ============================================================
# The toolchain, certificates and `sudo` come from base-tools: the runtime
# ships them for user profiles, and the build needs them too, so one stage
# installs them once and both consumer stages inherit the same layer.
FROM base-tools

ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV NODE_ENV=production \
    DATA_ROOT=/data \
    PORT=8080 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DSH_BIN=/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js

# One directory, already installed: the `dsh` stage resolved every dependency
# from the tarballs it packed and deleted that pack output afterwards, so this
# layer holds the runtime and nothing else. Optional dependencies are omitted
# for the same reason the release verification omits them: the Landlock
# platform packages behind them need a per-architecture build, and the runtime
# must start without them.
COPY --from=dsh /build/runtime/ /opt/dsh-runtime/

# pnpm is needed the first time a user's profile installs its bundles.
RUN corepack enable \
 && npm config set registry "${NPM_REGISTRY}"

COPY gateway/ /opt/v-harness/gateway/
COPY bin/ /opt/v-harness/bin/
# Product skills are discovered through DSH_BUNDLED_SKILL_DIR (see
# gateway/instances.mjs) and stay root-owned, so a tenant cannot edit them.
COPY skills/ /opt/v-harness/skills/
# Browser plugins built from this repository, read by gateway/plugins.mjs. dsh
# resolves a bundle from its installation tree before a profile, so this is the
# fallback copy for a profile whose own bundle would otherwise stay published.
COPY --from=plugins /build/plugins/ /opt/v-harness/plugins/

RUN chmod 0755 /opt/v-harness/bin/vh-userctl /opt/v-harness/bin/vh-file /opt/v-harness/bin/vh-jail \
      /opt/v-harness/bin/vh-file-impl.mjs /opt/v-harness/bin/entrypoint /opt/v-harness/bin/sandbox-probe.mjs \
 && chmod 0755 /opt/v-harness/skills/voffice/scripts/voffice.mjs /opt/v-harness/skills/weknora/scripts/weknora.mjs /opt/v-harness/skills/album/scripts/album.mjs \
 && chown -R root:root /opt/v-harness/bin \
 && printf 'root ALL=(root) NOPASSWD: /opt/v-harness/bin/vh-userctl, /opt/v-harness/bin/vh-file\n' > /etc/sudoers.d/vh \
 && chmod 0440 /etc/sudoers.d/vh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/__vh/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/v-harness/bin/entrypoint"]
