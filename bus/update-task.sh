#!/usr/bin/env bash
# update-task.sh — wrapper for Node.js CLI
# Usage: update-task.sh <id> <status> [note] [blocked_by] [--origin interactive|writer]
#                       [--fields <json>] [--grandfather <json>]
#
# --origin is forwarded to the CLI so a caller acting for a human at a UI can
# say so: interactive transitions are contract-ENFORCED regardless of the
# per-source shadow flag, which only ever covers migrating background writers.
#
# --fields carries contract fields a person supplied inline for a record that
# predates the contract (the upgrade path). --grandfather carries that person's
# explicit waiver when the information genuinely is not available (the fallback
# path). Both are audited by the store; neither is silent, and neither can buy
# an illegal transition or a Done without proof.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
STATUS="${2:-}"

if [[ -z "$ID" || -z "$STATUS" ]]; then
  echo "Usage: update-task.sh <id> <status> [note] [blocked_by] [--origin interactive|writer] [--fields <json>] [--grandfather <json>]" >&2
  exit 1
fi

# Scan the remaining arguments for the flags the CLI takes. The legacy
# positional note / blocked_by args are still accepted and still ignored here;
# forwarding them blindly would hand the CLI positional arguments it does not
# take.
FLAG_ARGS=()
shift 2 || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin|--fields|--grandfather)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; exit 1; }
      FLAG_ARGS+=("$1" "$2")
      shift 2
      ;;
    --origin=*|--fields=*|--grandfather=*)
      FLAG_ARGS+=("${1%%=*}" "${1#*=}")
      shift
      ;;
    *) shift ;;
  esac
done

exec node "$CLI" bus update-task "$ID" "$STATUS" ${FLAG_ARGS[@]+"${FLAG_ARGS[@]}"}
