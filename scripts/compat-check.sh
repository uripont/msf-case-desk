#!/bin/sh
# Runs the repository tests of every frozen iteration against the latest
# migrations, so the newest schema is proven to keep older versions working.
# See docs/compatibility.md.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work="$root/.snapshots/compat"
tags=$(git -C "$root" tag --list 'iter*' | sort -V)

if [ -z "$tags" ]; then
  echo "No frozen iterations yet."
  exit 0
fi

for tag in $tags; do
  if ! git -C "$root" cat-file -e "refs/tags/$tag:apps/api/migrations" 2>/dev/null; then
    echo "$tag: no backend, nothing to check"
    continue
  fi
  target="$work/$tag"
  rm -rf "$target"
  mkdir -p "$target"
  git -C "$root" archive "refs/tags/$tag" | tar -x -C "$target"
  rm -rf "$target/apps/api/migrations"
  cp -R "$root/apps/api/migrations" "$target/apps/api/migrations"
  (cd "$target" && pnpm install --frozen-lockfile --silent)
  echo "$tag: running its repository tests on the latest schema"
  (cd "$target/apps/api" && pnpm exec vitest run src/d1Repository.test.ts src/compat.test.ts)
done
