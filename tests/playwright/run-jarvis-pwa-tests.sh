#!/bin/bash
# JARVIS PWA test loop — run the /jarvis UI regression suite against the live
# dev dashboard (localhost:3000). Sources admin creds from dashboard/.env.local
# so the suite can drive the real login flow. Usage:
#   tests/playwright/run-jarvis-pwa-tests.sh [extra playwright args]
set -euo pipefail
cd "$(dirname "$0")/../.."

# Pull ADMIN_USERNAME / ADMIN_PASSWORD (and nothing else) from the dashboard env
eval "$(grep -E '^ADMIN_(USERNAME|PASSWORD)=' dashboard/.env.local | sed 's/^/export /')"

export DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"

# MOD #36: jarvis-voice.spec.ts joins the suite (open-mic wake gate / sign-off)
# MOD #107: jarvis-bargein.spec.ts (MODs #85-#89) had been written but never
#   added here, so the barge-in contract had ZERO coverage in the actual suite —
#   a spec that exists and is never run is worse than no spec, because it reads
#   as coverage. jarvis-realtime-el.spec.ts covers the Daniel lane.
npx playwright test \
  tests/playwright/jarvis-pwa.spec.ts \
  tests/playwright/jarvis-voice.spec.ts \
  tests/playwright/jarvis-bargein.spec.ts \
  tests/playwright/jarvis-realtime-el.spec.ts \
  "$@"
