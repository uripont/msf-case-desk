#!/bin/sh
# Runs the repository tests of every frozen iteration against the latest
# migrations, so the newest schema is proven to keep older versions working.
# With arguments, checks those git refs instead (for example `HEAD`, to
# rehearse a freeze before tagging). See docs/compatibility.md.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work="$root/.snapshots/compat"
refs=${*:-$(git -C "$root" tag --list 'iter*' | sort -V)}

if [ -z "$refs" ]; then
  echo "No frozen iterations yet."
  exit 0
fi

# Contract tests a frozen version may carry. `iter1` has none, `iter2` the
# first two, `iter3` all three (the report repository contract).
contracts="src/d1Repository.test.ts src/compat.test.ts src/reportRepository.test.ts"

for ref in $refs; do
  commit=$(git -C "$root" rev-parse --verify --quiet "$ref^{commit}") || {
    echo "$ref: no such git ref" >&2
    exit 1
  }
  if ! git -C "$root" cat-file -e "$commit:apps/api/migrations" 2>/dev/null; then
    echo "$ref: no backend, nothing to check"
    continue
  fi
  files=""
  for file in $contracts; do
    if git -C "$root" cat-file -e "$commit:apps/api/$file" 2>/dev/null; then
      files="$files $file"
    fi
  done
  target="$work/$ref"
  rm -rf "$target"
  mkdir -p "$target"
  git -C "$root" archive "$commit" | tar -x -C "$target"
  rm -rf "$target/apps/api/migrations"
  cp -R "$root/apps/api/migrations" "$target/apps/api/migrations"
  (cd "$target" && pnpm install --frozen-lockfile --silent)
  echo "$ref: running$files on the latest schema"
  # shellcheck disable=SC2086
  (cd "$target/apps/api" && pnpm exec vitest run $files)
done
