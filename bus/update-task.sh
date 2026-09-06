#!/usr/bin/env bash
# update-task.sh — wrapper for Node.js CLI
# Usage: update-task.sh <id> <status> [note] [blocked_by] [--origin interactive|writer]
#                       [--canonical <state>] [--fields <json>] [--grandfather <json>]
#                       [--expected-version <n>]
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
#
# --canonical says which canonical state the move is aiming at. It is needed
# because the native vocabulary is coarser than the canonical one: backlog and
# ready are both "pending", so without it a backlog -> ready leg looks like a
# no-op and skips the Ready gate entirely.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
STATUS="${2:-}"

if [[ -z "$ID" || -z "$STATUS" ]]; then
  echo "Usage: update-task.sh <id> <status> [note] [blocked_by] [--origin interactive|writer] [--canonical <state>] [--fields <json>] [--grandfather <json>] [--expected-version <n>]" >&2
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
    --origin|--fields|--grandfather|--canonical|--actor|--expected-version)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; exit 1; }
      FLAG_ARGS+=("$1" "$2")
      shift 2
      ;;
    --origin=*|--fields=*|--grandfather=*|--canonical=*|--actor=*|--expected-version=*)
      FLAG_ARGS+=("${1%%=*}" "${1#*=}")
      shift
      ;;
    *) shift ;;
  esac
done

exec node "$CLI" bus update-task "$ID" "$STATUS" ${FLAG_ARGS[@]+"${FLAG_ARGS[@]}"}
