#!/usr/bin/env bash
set -euo pipefail

APP_LABEL="v-harness"
TAG_PREFIX="vos-v-harness-v"
VERSION_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/VERSION"
REPO_ROOT="$(git -C "$(dirname "$VERSION_FILE")" rev-parse --show-toplevel)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/update_version.sh [patch|minor|major]

Updates ictrek.app/VERSION, commits it, creates a VOS CI trigger tag, and
pushes the branch and tag. GitHub Actions publishes the pull-mode tar on a
standard SemVer release tag.
Commit application code changes before running this script.
EOF
}

bump_version() {
  local part="$1" current major minor patch
  current="$(tr -d '[:space:]' < "$VERSION_FILE")"
  [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "invalid VERSION: $current" >&2
    exit 1
  }
  IFS=. read -r major minor patch <<< "$current"
  case "$part" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
    *) usage >&2; exit 1 ;;
  esac
  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

remote_tag_exists() {
  local tag="$1"
  git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1
}

part="${1:-patch}"
[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || { usage; exit 0; }

cd "$REPO_ROOT"
git diff --quiet && git diff --cached --quiet || {
  echo "worktree is not clean; commit code changes before releasing" >&2
  exit 1
}

version="$(bump_version "$part")"
tag="${TAG_PREFIX}${version}"
public_tag="v${version}"

if remote_tag_exists "$tag"; then
  echo "VOS trigger tag already exists on origin: ${tag}" >&2
  exit 1
fi

if remote_tag_exists "$public_tag"; then
  echo "public release tag already exists on origin: ${public_tag}" >&2
  exit 1
fi

printf '%s\n' "$version" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "chore: release VOS ${APP_LABEL} ${version}"
git tag "$tag"
branch="$(git branch --show-current)"
git push origin "$branch"
git push origin "$tag"

echo "Pushed ${tag}. GitHub Actions will build the pull tar and create release ${public_tag}."
