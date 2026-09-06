#!/usr/bin/env bash
# delete-task.sh — wrapper for Node.js CLI
# Usage: delete-task.sh <task-id> <reason> [--force] [--org <name>]
#
# Removes a task and every actionable remnant of it (record, audit, journal,
# claim, deliverables, and any unacked inbox/inflight message naming the id).
# Refused for an obligation or for work that is not already terminal — cancel
# those with update-task instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

TASK_ID="${1:-}"
REASON="${2:-}"

if [[ -z "$TASK_ID" || -z "$REASON" ]]; then
  echo "Usage: delete-task.sh <task-id> <reason> [--force] [--org <name>]" >&2
  exit 1
fi

exec node "$CLI" bus delete-task --id "$TASK_ID" --reason "$REASON" "${@:3}"
