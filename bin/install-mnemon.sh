#!/bin/sh
set -eu

case "$(dpkg --print-architecture)" in
  amd64)
    mnemon_sha=fb5cab88886fb1f82d04d81efe17834976e30ceb2f2d0a20c87c31960bafe686
    ;;
  arm64)
    mnemon_sha=f9cfe773fb2de3f156ca76f8d0173e566d4008257b2aa6ce6fb8290b7c7f024f
    ;;
  *) printf '%s\n' 'Unsupported architecture for built-in skill tools' >&2; exit 1 ;;
esac

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fetch_binary() {
    url=$1
    sha256=$2
    binary=$3
    archive="$scratch/$binary.tar.gz"
    if ! curl -fsSL --connect-timeout 10 --max-time 120 --retry 1 "$url" -o "$archive"; then
        curl -fsSL --connect-timeout 10 --max-time 120 --retry 1 "${SKILL_GITHUB_MIRROR:-https://ghfast.top}/$url" -o "$archive"
    fi
    printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c -
    tar -xzf "$archive" -C "$scratch" "$binary"
    install -m 0755 "$scratch/$binary" "/usr/local/bin/$binary"
}

fetch_binary "https://github.com/mnemon-dev/mnemon/releases/download/v0.2.13/mnemon_0.2.13_linux_$(dpkg --print-architecture).tar.gz" "$mnemon_sha" mnemon
