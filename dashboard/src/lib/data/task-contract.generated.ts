// GENERATED from tests/fixtures/task-status-contract.json — do not hand-edit.
// Regenerate with: node dashboard/scripts/generate-task-contract.mjs
//
// Why this exists rather than reading the JSON at runtime: this module is
// imported by Next.js server components, where __dirname is rewritten by the
// bundler and the repo's tests/ directory is not part of the deployed output.
// Reading from disk there is a page-breaking failure waiting to happen.
//
// The fixture remains the single source of truth: task-projection.test.ts
// asserts this object deep-equals the fixture's rules, and the Python half
// asserts the fixture's sha256, so all three cannot drift apart silently.

import type { TaskContract } from './task-projection';

export const TASK_CONTRACT = {
  "contract_version": 1,
  "description": "Shared task identity + status projection contract for OS-01. This file is byte-identical in the CortexOS repo (tests/fixtures/) and the uhsJARVIS repo (tests/fixtures/). Both the Python projector (uhsJARVIS scripts/task_projection.py) and the TypeScript projector (CortexOS dashboard/src/lib/data/task-projection.ts) load it and MUST agree on every case below. Slice 1 rule: the owning store's native status is preserved verbatim; lanes are a projection layer only. Do not rewrite native statuses to the canonical OS-02 vocabulary here.",
  "people": {
    "scott": {
      "display": "Scott Ascherman",
      "aliases": [
        "scott",
        "scott ascherman",
        "sascherman",
        "scott@utopiahomestaging.com"
      ],
      "legacy_aliases": [
        "human",
        "user",
        "owner"
      ]
    },
    "angelic": {
      "display": "Angelic Ferguson",
      "aliases": [
        "angelic",
        "angelic ferguson",
        "ange",
        "ange@utopiahomestaging.com"
      ],
      "legacy_aliases": []
    },
    "raquel": {
      "display": "Raquel Lopez",
      "aliases": [
        "raquel",
        "raquel lopez"
      ],
      "legacy_aliases": []
    }
  },
  "legacy_title_prefixes": [
    "[HUMAN]"
  ],
  "legacy_projects": [
    "human-tasks"
  ],
  "legacy_person": "scott",
  "agent_aliases": [
    "jarvis",
    "vera",
    "vivienne",
    "trillion-coder",
    "tron",
    "client-ops",
    "estimator",
    "marketing",
    "orchestrator",
    "claude-code",
    "codex",
    "hermes"
  ],
  "agent_alias_prefixes": [
    "jarvis-"
  ],
  "ambiguous_aliases": [
    "team",
    "staff",
    "uhs",
    "admin",
    "us",
    "someone",
    "anyone",
    "tbd",
    "unassigned"
  ],
  "legacy_status_map": {
    "duplicate": "cancelled",
    "archived": "cancelled"
  },
  "known_statuses": [
    "pending",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
    "failed"
  ],
  "terminal_statuses": [
    "completed",
    "cancelled"
  ],
  "status_lanes": {
    "pending": {
      "lane": "todo",
      "waiting_subtype": null
    },
    "in_progress": {
      "lane": "doing",
      "waiting_subtype": null
    },
    "blocked": {
      "lane": "waiting",
      "waiting_subtype": "unclassified"
    },
    "failed": {
      "lane": "waiting",
      "waiting_subtype": "retry"
    },
    "completed": {
      "lane": "done",
      "waiting_subtype": null
    },
    "cancelled": {
      "lane": "cancelled",
      "waiting_subtype": null
    }
  },
  "unknown_status_lane": {
    "lane": "waiting",
    "waiting_subtype": "unclassified"
  },
  "waiting_subtype_rules": [
    "needs_approval truthy on a non-terminal row => human",
    "owner_kind == person on a waiting row => human",
    "native status failed => retry",
    "otherwise the status_lanes default, which is unclassified for blocked and unknown statuses"
  ]
} as unknown as TaskContract;
