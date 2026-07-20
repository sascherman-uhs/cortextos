#!/usr/bin/env bash
# verify-local-mods.sh — Post-merge integrity check for all UHS local CortexOS mods
# Run BEFORE and AFTER every `git merge upstream/main` or `git pull`
#
# Exit codes:
#   0 = all mods intact
#   1 = one or more mods missing or broken
#
# Usage:
#   bash ~/cortextos/scripts/verify-local-mods.sh
#   bash ~/cortextos/scripts/verify-local-mods.sh --fix   (auto-repair what it can)

set -euo pipefail

CORTEXTOS_ROOT="$HOME/cortextos"
DASHBOARD_ROOT="$CORTEXTOS_ROOT/dashboard"
PASS=0
FAIL=0
FIX_MODE=false
[[ "${1:-}" == "--fix" ]] && FIX_MODE=true

green()  { echo -e "\033[0;32m✓ $*\033[0m"; }
red()    { echo -e "\033[0;31m✗ $*\033[0m"; }
yellow() { echo -e "\033[0;33m⚠ $*\033[0m"; }

check() {
  local desc="$1"; local file="$2"; local pattern="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    green "$desc"
    ((PASS++))
    return 0
  else
    red "$desc"
    red "  Missing in: $file"
    red "  Expected:   $pattern"
    ((FAIL++))
    return 1
  fi
}

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║      CortexOS UHS Local Mods — Integrity Check          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── MOD #1: Next.js 16 middleware → proxy rename ───────────────────────────
echo "── MOD #1: Next.js middleware → proxy rename"
if [[ -f "$DASHBOARD_ROOT/src/proxy.ts" ]]; then
  green "proxy.ts exists"
  ((PASS++))
else
  red "proxy.ts MISSING (should be renamed from middleware.ts)"
  ((FAIL++))
fi

if [[ -f "$DASHBOARD_ROOT/src/middleware.ts" ]]; then
  red "middleware.ts still exists (should have been renamed to proxy.ts)"
  ((FAIL++))
else
  green "middleware.ts absent (correct)"
  ((PASS++))
fi

check "proxy.ts exports function named 'proxy'" \
  "$DASHBOARD_ROOT/src/proxy.ts" \
  "export async function proxy"

echo ""

# ─── MOD #2: Heartbeat CTX_AGENT_NAME pass-through ──────────────────────────
echo "── MOD #2: fast-checker CTX_AGENT_NAME pass-through"
check "childEnv defined with CTX_AGENT_NAME" \
  "$CORTEXTOS_ROOT/src/daemon/fast-checker.ts" \
  "CTX_AGENT_NAME.*agentName"

check "execFile uses childEnv (env: childEnv)" \
  "$CORTEXTOS_ROOT/src/daemon/fast-checker.ts" \
  "env: childEnv"

echo ""

# ─── MOD #3: Wiki org defaults to 'uhs' ─────────────────────────────────────
echo "── MOD #3: Wiki defaults to 'uhs' org"
check "wiki page.tsx defaults to uhs" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/wiki/page.tsx" \
  "'uhs'"

check "wiki tree route defaults to uhs" \
  "$DASHBOARD_ROOT/src/app/api/wiki/tree/route.ts" \
  "'uhs'"

check "vault.ts has UHS PARA_DIRS (business, clients)" \
  "$DASHBOARD_ROOT/src/lib/vault.ts" \
  "'business'"

check "orgs/uhs/knowledge.md exists" \
  "$CORTEXTOS_ROOT/orgs/uhs/knowledge.md" \
  "vault"

echo ""

# ─── MOD #4: AUTH_URL persistence through .env.local regen ─────────────────
echo "── MOD #4: AUTH_URL persists in dashboard.ts"
check "dashboard.ts reads AUTH_URL" \
  "$CORTEXTOS_ROOT/src/cli/dashboard.ts" \
  "AUTH_URL"

check "dashboard.env has AUTH_URL" \
  "$HOME/.cortextos/default/dashboard.env" \
  "AUTH_URL="

echo ""

# ─── MOD #5: sync.ts Supabase row guard ──────────────────────────────────────
echo "── MOD #5: sync.ts protects Supabase-sourced task rows"
check "activePaths branch has supabase guard" \
  "$DASHBOARD_ROOT/src/lib/sync.ts" \
  "source_file NOT LIKE 'supabase://%'"

# Must appear TWICE (one in each DELETE branch)
COUNT=$(grep -c "source_file NOT LIKE 'supabase://%'" "$DASHBOARD_ROOT/src/lib/sync.ts" 2>/dev/null || echo 0)
if [[ "$COUNT" -ge 2 ]]; then
  green "supabase guard present in BOTH delete branches ($COUNT occurrences)"
  ((PASS++))
else
  red "supabase guard found only $COUNT time(s) — should be in BOTH delete branches"
  ((FAIL++))
fi

echo ""

# ─── MOD #6: supa_ task PATCH + Complete button + approvals filter ───────────
echo "── MOD #6: supa_ PATCH fast-path + UI fixes"
check "route.ts imports db" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "import { db } from"

check "route.ts has supa_ fast-path handler" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "id.startsWith('supa_')"

check "route.ts calls Supabase REST for supa_ tasks" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "rest/v1/tasks"

check "task-detail-sheet has Complete on pending" \
  "$DASHBOARD_ROOT/src/components/tasks/task-detail-sheet.tsx" \
  "label: 'Complete'.*status: 'completed'"

# Check approvals filter (pending|in_progress only)
check "approvals page filters to pending/in_progress only" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/approvals/page.tsx" \
  "t.status === 'pending'"

check ".env.local has SUPABASE_URL" \
  "$DASHBOARD_ROOT/.env.local" \
  "SUPABASE_URL="

check ".env.local has SUPABASE_KEY" \
  "$DASHBOARD_ROOT/.env.local" \
  "SUPABASE_KEY="

check "route.ts has supa_ fast-path for DELETE (Jun 1 fix)" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "supa_ DELETE error"

echo ""

# ─── MOD #7: Task numbers, search, recurring tab ─────────────────────────────
echo "── MOD #7: Task numbers, search, two-tab tasks page, recurring management"

# New UHS-owned files (safe zone — upstream never writes here)
for f in \
  "$DASHBOARD_ROOT/src/components/uhs/task-number-badge.tsx" \
  "$DASHBOARD_ROOT/src/components/uhs/recurring-tasks-tab.tsx" \
  "$DASHBOARD_ROOT/src/app/api/uhs/recurring-tasks/route.ts"; do
  if [[ -f "$f" ]]; then
    green "$(basename "$f") exists in uhs/ safe zone"
    ((PASS++))
  else
    red "$(basename "$f") MISSING — expected at $f"
    ((FAIL++))
  fi
done

# Hooks in upstream files (minimal 1-line imports)
check "task-card.tsx imports TaskNumberBadge" \
  "$DASHBOARD_ROOT/src/components/tasks/task-card.tsx" \
  "from '@/components/uhs/task-number-badge'"

check "task-list-table.tsx imports getTaskNumber" \
  "$DASHBOARD_ROOT/src/components/tasks/task-list-table.tsx" \
  "from '@/components/uhs/task-number-badge'"

check "task-filters.tsx has onSearchChange prop (search isolated from filters)" \
  "$DASHBOARD_ROOT/src/components/tasks/task-filters.tsx" \
  "onSearchChange"

check "task-filters.tsx search fires on Enter/click (not keypress)" \
  "$DASHBOARD_ROOT/src/components/tasks/task-filters.tsx" \
  "commitSearch"

check "task-detail-sheet.tsx imports RecurringPanel" \
  "$DASHBOARD_ROOT/src/components/tasks/task-detail-sheet.tsx" \
  "RecurringPanel"

check "tasks/page.tsx imports RecurringTasksTab" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/tasks/page.tsx" \
  "RecurringTasksTab"

check "tasks/page.tsx has Tabs structure" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/tasks/page.tsx" \
  "TabsContent.*recurring"

check "tasks/page.tsx has isolated searchQuery state (not inside filters)" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/tasks/page.tsx" \
  "searchQuery, setSearchQuery"

check "api/tasks/[id]/route.ts enriches with recurring info" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "recurring_task_id"

check "api/tasks/[id]/route.ts fetches result+error for supa_ tasks" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "supaResult"

check "task-detail-sheet.tsx renders result section" \
  "$DASHBOARD_ROOT/src/components/tasks/task-detail-sheet.tsx" \
  "supaResult"

check "approvals/page.tsx imports TaskNumberBadge" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/approvals/page.tsx" \
  "TaskNumberBadge"

check "task-list-table.tsx has task_num sort field" \
  "$DASHBOARD_ROOT/src/components/tasks/task-list-table.tsx" \
  "task_num"

echo ""

# ─── MOD #8: Delete/Archive recurring tasks from UI ──────────────────────────
echo "── MOD #8: Recurring task delete — trash button + inline confirm + DELETE API"

check "recurring-tasks-tab.tsx imports IconTrash" \
  "$DASHBOARD_ROOT/src/components/uhs/recurring-tasks-tab.tsx" \
  "IconTrash"

check "recurring-tasks-tab.tsx has deleteState" \
  "$DASHBOARD_ROOT/src/components/uhs/recurring-tasks-tab.tsx" \
  "deleteState"

check "recurring-tasks route.ts has DELETE handler" \
  "$DASHBOARD_ROOT/src/app/api/uhs/recurring-tasks/route.ts" \
  "export async function DELETE"

check "recurring-tasks-tab.tsx shows RT-N badge" \
  "$DASHBOARD_ROOT/src/components/uhs/recurring-tasks-tab.tsx" \
  "RT-{task.id}"

echo ""

# ─── MOD #9: SUPABASE_URL/KEY persistence through .env.local regen ────────────
echo "── MOD #9: SUPABASE keys persist in dashboard.ts (stop .env.local clobber)"

check "dashboard.ts reads SUPABASE_URL" \
  "$CORTEXTOS_ROOT/src/cli/dashboard.ts" \
  "const supaUrl = process.env.SUPABASE_URL"

check "dashboard.ts reads SUPABASE_KEY" \
  "$CORTEXTOS_ROOT/src/cli/dashboard.ts" \
  "const supaKey = process.env.SUPABASE_KEY"

check "dashboard.ts writes SUPABASE_URL into nextEnvLines" \
  "$CORTEXTOS_ROOT/src/cli/dashboard.ts" \
  "SUPABASE_URL="

check "dashboard.env has SUPABASE_URL" \
  "$HOME/.cortextos/default/dashboard.env" \
  "SUPABASE_URL="

check "dashboard.env has SUPABASE_KEY" \
  "$HOME/.cortextos/default/dashboard.env" \
  "SUPABASE_KEY="

echo ""

# ─── MOD #10: Trillion report callback bridge ───────────────────────────────
echo "── MOD #10: Trillion report callback bridge"

check "fast-checker routes Trillion report callbacks" \
  "$CORTEXTOS_ROOT/src/daemon/fast-checker.ts" \
  "trillion_(fix|skip|run)"

check "fast-checker converts Trillion callback to yes fix command" \
  "$CORTEXTOS_ROOT/src/daemon/fast-checker.ts" \
  "Trillion report callback routed as command"

echo ""

# ─── MOD #11: Drag-to-agent task routing (Task #889 / L6-01) ─────────────────
echo "── MOD #11: Drag-to-agent task routing"

if [[ -f "$DASHBOARD_ROOT/src/components/uhs/agent-routing-board.tsx" ]]; then
  green "agent-routing-board.tsx exists"
  ((PASS++))
else
  red "agent-routing-board.tsx MISSING (UHS MOD #11 routing board)"
  ((FAIL++))
fi

check "kanban-board.tsx has renderCard prop (MOD #11)" \
  "$DASHBOARD_ROOT/src/components/tasks/kanban-board.tsx" \
  "renderCard"

check "tasks page renders AgentRoutingBoard (MOD #11)" \
  "$DASHBOARD_ROOT/src/app/(dashboard)/tasks/page.tsx" \
  "AgentRoutingBoard"

check "route.ts PUT has supa_ assignee branch (MOD #11)" \
  "$DASHBOARD_ROOT/src/app/api/tasks/[id]/route.ts" \
  "supa_ PUT error"


# ─── MOD #12: hook-crash-alert transient vs quota rate-limit split ─────────
echo "── MOD #12: hook-crash-alert transient vs quota rate-limit split"
check "detectRateLimitInLog returns quota|transient|null (MOD #12)" \
  "$CORTEXTOS_ROOT/src/hooks/hook-crash-alert.ts" \
  "ALWAYS_SILENT_TYPES"
check "rate-limited-transient is always silent (MOD #12)" \
  "$CORTEXTOS_ROOT/src/hooks/hook-crash-alert.ts" \
  "rate-limited-transient"
check "quota exhaustion message says quota not rate limit (MOD #12)" \
  "$CORTEXTOS_ROOT/src/hooks/hook-crash-alert.ts" \
  "quota exhausted"

echo ""

# ─── MOD #13: Deepgram Nova-3 primary transcriber, whisper.cpp fallback ───────
echo "── MOD #13: Deepgram speech-in with whisper fallback"
check "transcribe.ts has Deepgram helper (MOD #13)" \
  "$CORTEXTOS_ROOT/src/telegram/transcribe.ts" \
  "transcribeViaDeepgram"
check "transcribe.ts calls Deepgram before whisper (MOD #13)" \
  "$CORTEXTOS_ROOT/src/telegram/transcribe.ts" \
  "UHS MOD #13"

echo ""

# ─── MOD #42: Deepgram Nova-3 primary for /jarvis web STT, whisper.cpp fallback ─
echo "── MOD #42: Deepgram speech-in for Cosmos web voice (/api/uhs/stt)"
check "stt route has Deepgram helper (MOD #42)" \
  "$DASHBOARD_ROOT/src/app/api/uhs/stt/route.ts" \
  "transcribeViaDeepgram"
check "stt route tries Deepgram before whisper (MOD #42)" \
  "$DASHBOARD_ROOT/src/app/api/uhs/stt/route.ts" \
  "JARVIS MOD #42"

echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════╗"
if [[ $FAIL -eq 0 ]]; then
  echo "║  ✓ ALL MODS INTACT  ($PASS checks passed, $FAIL failed)   ║"
else
  echo "║  ✗ MODS MISSING  ($PASS passed, $FAIL FAILED)             ║"
fi
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "Run with --fix to attempt auto-repair, or see:"
  echo "  memory/project_cortextos_local_mods.md"
  echo ""
  exit 1
fi

exit 0
