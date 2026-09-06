// GENERATED from tests/fixtures/task-transition-contract.json — do not hand-edit.
// Regenerate with: node dashboard/scripts/generate-task-contract.mjs
//
// The fixture is byte-identical in uhsJARVIS, where the Python half
// (scripts/agent_os/task_contract.py) loads it directly. Keeping the rules in
// data rather than in three hand-written copies is what stops the validator
// that blocks a write and the projector that renders it from disagreeing.

import type { TransitionContract } from './task-contract.js';

export const TRANSITION_CONTRACT = {
  "contract_version": 1,
  "description": "OS-02 canonical work-contract transition rules. Byte-identical in the uhsJARVIS repo (tests/fixtures/) and the CortexOS repo (tests/fixtures/). The Python half (scripts/agent-os/task_contract.py) and the TypeScript half (src/bus/task-contract.ts + dashboard/src/lib/task-transition.ts) both load it, so the writer that mutates a store and the reader that renders it cannot disagree about what a legal transition is. Complements task-status-contract.json, which owns identity + lane projection; this file owns which transitions are permitted and what proof each one costs.",
  "canonical_states": [
    "backlog",
    "ready",
    "doing",
    "verify",
    "waiting",
    "done",
    "cancelled",
    "failed_terminal"
  ],
  "terminal_states": [
    "done",
    "cancelled",
    "failed_terminal"
  ],
  "waiting_subtypes": [
    "human",
    "retry",
    "dependency",
    "external"
  ],
  "run_statuses": [
    "started",
    "succeeded",
    "failed",
    "abandoned"
  ],
  "allowed_transitions": {
    "backlog": [
      "ready",
      "waiting",
      "cancelled",
      "failed_terminal"
    ],
    "ready": [
      "doing",
      "backlog",
      "waiting",
      "cancelled"
    ],
    "doing": [
      "verify",
      "waiting",
      "cancelled"
    ],
    "verify": [
      "done",
      "doing",
      "waiting",
      "cancelled"
    ],
    "waiting": [
      "ready",
      "doing",
      "verify",
      "backlog",
      "cancelled",
      "failed_terminal"
    ],
    "done": [],
    "cancelled": [],
    "failed_terminal": [
      "waiting"
    ]
  },
  "requirements": {
    "ready": {
      "fields": [
        "outcome",
        "agent_role_id_or_human_accountable_id",
        "acceptance_criteria"
      ],
      "dependencies_satisfied": true,
      "reason": "Plan section 4: Ready requires owner, outcome, sufficient input context, acceptance criteria, and satisfied dependencies/authority."
    },
    "verify": {
      "evidence_keys_any": [
        "artifact",
        "artifacts",
        "result",
        "pr",
        "release",
        "receipt",
        "run_id"
      ],
      "reason": "Plan section 4: Doing to Verify requires an artifact/result. A model saying done, an exit code, or HTTP 200 alone is insufficient."
    },
    "done": {
      "acceptance_checks_all_pass": true,
      "verifier_required": true,
      "verifier_distinct_from_author_for": [
        "code",
        "external",
        "high_impact"
      ],
      "machine_validator_allowed_for": [
        "low_impact_deterministic"
      ],
      "reason": "Plan section 4: Verify to Done requires the stated acceptance checks and independent verification for code, external writes, and high-impact results. Low-impact deterministic jobs may use a machine validator."
    },
    "failed_terminal": {
      "forbidden_for_types": [
        "obligation"
      ],
      "fields": [
        "reason",
        "disposition"
      ],
      "reason": "Plan section 3: failed_terminal is allowed only for non-obligation work with reason and disposition. Obligations cannot be silently cancelled or dead-lettered."
    },
    "cancelled": {
      "fields": [
        "reason",
        "actor"
      ],
      "reason": "Plan section 3: Cancellation is a distinct terminal state with reason and actor."
    }
  },
  "impact_classes": [
    "low_impact_deterministic",
    "code",
    "external",
    "high_impact"
  ],
  "work_types": [
    "work",
    "obligation",
    "improvement"
  ],
  "native_to_canonical": {
    "cortexos_tasks": {
      "pending": "backlog",
      "in_progress": "doing",
      "blocked": "waiting",
      "completed": "done",
      "cancelled": "cancelled"
    },
    "jarvis_tasks": {
      "pending": "backlog",
      "in_progress": "doing",
      "blocked": "waiting",
      "failed": "waiting",
      "completed": "done",
      "cancelled": "cancelled"
    },
    "jarvis_skill_runs": {
      "in_progress": "doing",
      "blocked": "waiting",
      "complete": "done",
      "abandoned": "cancelled"
    }
  },
  "canonical_to_native": {
    "cortexos_tasks": {
      "backlog": "pending",
      "ready": "pending",
      "doing": "in_progress",
      "verify": "in_progress",
      "waiting": "blocked",
      "done": "completed",
      "cancelled": "cancelled",
      "failed_terminal": "blocked"
    },
    "jarvis_tasks": {
      "backlog": "pending",
      "ready": "pending",
      "doing": "in_progress",
      "verify": "in_progress",
      "waiting": "blocked",
      "done": "completed",
      "cancelled": "cancelled",
      "failed_terminal": "failed"
    }
  },
  "legacy_completion_label": "historical, evidence not recorded",
  "interactive_paths": {
    "backlog": {
      "doing": [
        "ready",
        "doing"
      ]
    },
    "doing": {
      "done": [
        "verify",
        "done"
      ]
    },
    "waiting": {
      "done": [
        "verify",
        "done"
      ]
    }
  },
  "legacy_grandfather": {
    "description": "Plan section 4 migration: 'enable required fields for new work first' and give legacy work a documented, audited path forward. A record that predates the contract carries none of its required fields, so the Ready gate would strand it forever. It may be advanced by a named human who either supplies the missing fields (the upgrade path, preferred) or waives them explicitly (the fallback path). Neither is silent: both append an event to the journal naming the actor, the reason and the fields that were missing.",
    "waivable_violations": [
      "missing_outcome",
      "missing_owner",
      "missing_acceptance_criteria"
    ],
    "never_waivable": [
      "illegal_transition",
      "unsatisfied_dependencies",
      "missing_evidence",
      "acceptance_checks_incomplete",
      "acceptance_check_failed",
      "missing_verifier",
      "verifier_is_author",
      "obligation_cannot_fail_terminal",
      "missing_reason",
      "missing_actor",
      "missing_disposition"
    ],
    "fields": [
      "actor",
      "reason"
    ],
    "eligible_when": "The item was NOT created under the contract (no contract_version) AND is missing at least one field the contract requires. A contract-era item is never eligible, however incomplete it is.",
    "done_requires_evidence_without_criteria": true,
    "reason": "Plan section 12 hard invariant: no verified Done without proof. Grandfathering buys entry into the working states, never the proof gate at completion. An item with no acceptance criteria must still produce an artifact and a named verifier to reach done, so an empty criteria list can never be read as 'nothing to check'."
  }
} as unknown as TransitionContract;
