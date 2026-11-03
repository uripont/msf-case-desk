#!/bin/sh
# Builds Case Desk and serves it on plain workerd at http://127.0.0.1:8787,
# with the database in .local/workerd-data. Usage: pnpm workerd [port]
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
port=${1:-8787}
data="$root/.local/workerd-data"

pnpm --dir "$root" --filter @case-desk/web build >/dev/null
node "$root/apps/api/scripts/build-workerd.mjs"
mkdir -p "$data"

echo "Case Desk on http://127.0.0.1:$port"
exec pnpm --dir "$root/apps/api" exec workerd serve workerd/case-desk.capnp \
  --directory-path "assets=$root/apps/web/dist" \
  --directory-path "data=$data" \
  --socket-addr "http=127.0.0.1:$port" \
  --experimental
