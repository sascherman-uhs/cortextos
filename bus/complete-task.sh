#!/usr/bin/env bash
# complete-task.sh — wrapper for Node.js CLI
# Usage: complete-task.sh <id> [result_summary] [--evidence <json>] [--origin interactive|writer]
#
# --origin is forwarded to the CLI so a caller acting for a human at a UI can
# say so: interactive completions are contract-ENFORCED regardless of the
# per-source shadow flag, which only ever covers migrating background writers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
RESULT=""
EXTRA=()

if [[ -z "$ID" ]]; then
  echo "Usage: complete-task.sh <id> [result_summary] [--evidence <json>] [--origin interactive|writer]" >&2
  exit 1
fi
shift

if [[ $# -gt 0 && "$1" != --* ]]; then
  RESULT="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin|--evidence)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; exit 1; }
      EXTRA+=("$1" "$2")
      shift 2
      ;;
    --origin=*|--evidence=*)
      EXTRA+=("${1%%=*}" "${1#*=}")
      shift
      ;;
    *) shift ;;
  esac
done

ARGS=("$ID")
[[ -n "$RESULT" ]] && ARGS+=(--result "$RESULT")

exec node "$CLI" bus complete-task "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
