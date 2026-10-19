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
FROM ${BASE_IMAGE}

ARG DSH_VERSION=0.2.1-rc.2
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV NODE_ENV=production \
    DATA_ROOT=/data \
    PORT=8080 \
    DSH_BIN=/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js

RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm is needed the first time a user's profile installs its bundles.
RUN corepack enable \
 && npm config set registry "${NPM_REGISTRY}" \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

COPY gateway/ /opt/v-harness/gateway/
COPY bin/ /opt/v-harness/bin/

RUN chmod 0755 /opt/v-harness/bin/vh-userctl /opt/v-harness/bin/vh-file \
      /opt/v-harness/bin/vh-file-impl.mjs /opt/v-harness/bin/entrypoint /opt/v-harness/bin/sandbox-probe.mjs \
 && chown -R root:root /opt/v-harness/bin \
 && printf 'root ALL=(root) NOPASSWD: /opt/v-harness/bin/vh-userctl, /opt/v-harness/bin/vh-file\n' > /etc/sudoers.d/vh \
 && chmod 0440 /etc/sudoers.d/vh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/__vh/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/v-harness/bin/entrypoint"]
