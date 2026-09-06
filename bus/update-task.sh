#!/usr/bin/env bash
# update-task.sh — wrapper for Node.js CLI
# Usage: update-task.sh <id> <status> [note] [blocked_by] [--origin interactive|writer]
#
# --origin is forwarded to the CLI so a caller acting for a human at a UI can
# say so: interactive transitions are contract-ENFORCED regardless of the
# per-source shadow flag, which only ever covers migrating background writers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
STATUS="${2:-}"

if [[ -z "$ID" || -z "$STATUS" ]]; then
  echo "Usage: update-task.sh <id> <status> [note] [blocked_by] [--origin interactive|writer]" >&2
  exit 1
fi

# Scan the remaining arguments for --origin only. The legacy positional note /
# blocked_by args are still accepted and still ignored here; forwarding them
# blindly would hand the CLI positional arguments it does not take.
ORIGIN_ARGS=()
shift 2 || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin)
      [[ $# -ge 2 ]] || { echo "--origin requires a value" >&2; exit 1; }
      ORIGIN_ARGS=(--origin "$2")
      shift 2
      ;;
    --origin=*)
      ORIGIN_ARGS=(--origin "${1#--origin=}")
      shift
      ;;
    *) shift ;;
  esac
done

exec node "$CLI" bus update-task "$ID" "$STATUS" ${ORIGIN_ARGS[@]+"${ORIGIN_ARGS[@]}"}
