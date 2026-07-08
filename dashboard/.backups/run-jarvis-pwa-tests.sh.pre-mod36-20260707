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

npx playwright test tests/playwright/jarvis-pwa.spec.ts "$@"
