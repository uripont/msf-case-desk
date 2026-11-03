#!/bin/sh
# Extracts each frozen iteration from its git tag into .snapshots/<tag> and
# installs its dependencies, so alchemy.run.ts can deploy it unchanged.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)

for tag in "$@"; do
  target="$root/.snapshots/$tag"
  if [ -d "$target" ]; then
    echo "$tag: already prepared"
    continue
  fi
  git -C "$root" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null || {
    echo "$tag: no such git tag" >&2
    exit 1
  }
  mkdir -p "$target"
  git -C "$root" archive "refs/tags/$tag" | tar -x -C "$target"
  (cd "$target" && pnpm install --frozen-lockfile --silent)
  echo "$tag: prepared"
done
