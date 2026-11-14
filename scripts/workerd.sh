#!/bin/sh
# Builds Quoroom and serves it on plain workerd at http://127.0.0.1:8787,
# with the database in .local/workerd-data (demo) or .local/workerd-data-pilot
# (pilot). Usage: pnpm workerd [--mode demo|pilot] [port]
#
# Both serve the same Quoroom code (D20); the mode chooses the imports and the
# data folder.
# demo (default): the built-in templates, the accounts from `pnpm users:add`
# and the first administrator written by `pnpm grant-admin --env workerd`.
# pilot: the built-in templates and that first administrator only.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
usage() {
  echo "Usage: pnpm workerd [--mode demo|pilot] [port]" >&2
  exit 2
}
# NOTE: --mode X and --mode=X in any position; any other flag is an error.
mode=demo
port=
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      [ $# -ge 2 ] || usage
      mode=$2
      shift 2
      ;;
    --mode=*)
      mode=${1#--mode=}
      shift
      ;;
    -*) usage ;;
    *)
      [ -z "$port" ] || usage
      port=$1
      shift
      ;;
  esac
done
case "$mode" in
  demo | pilot) ;;
  *) usage ;;
esac
case "${port:=8787}" in
  *[!0-9]*) usage ;;
esac
# NOTE: for the test of the argument parsing: print and stop.
if [ "${WORKERD_PARSE_ONLY:-}" = "1" ]; then
  echo "$mode $port"
  exit 0
fi
if [ "$mode" = "pilot" ]; then
  data="$root/.local/workerd-data-pilot"
else
  data="$root/.local/workerd-data"
fi

pnpm --dir "$root" --filter @case-desk/web build >/dev/null
node "$root/apps/api/scripts/build-workerd.mjs" --mode "$mode"
mkdir -p "$data"

echo "Quoroom ($mode) on http://127.0.0.1:$port"
exec pnpm --dir "$root/apps/api" exec workerd serve workerd/case-desk.capnp \
  --directory-path "assets=$root/apps/web/dist" \
  --directory-path "data=$data" \
  --socket-addr "http=127.0.0.1:$port" \
  --experimental
