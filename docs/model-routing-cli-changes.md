# Model routing CLI — changes

## `role_capabilities` and `cortextos model role-capability` (fix4)

### The problem

A role in `orgs/<org>/model-registry.json` had exactly one capability field,
`required_capabilities`, and it means **"the MODEL must carry these tags"** —
`validateCandidate()` matches every value in it against a registry entry's
`capability_tags`, and a role whose list contains a tag no entry carries has no
viable candidate in any tier.

The weekly Kaizen cycle needs a different fact: **which roles participate in the
improvement loop**. That is a property of the role, not a requirement on the
model. Expressing it as `required_capabilities: ["continuous-improvement"]`
would have made every enrolled role unresolvable, because no model entry has (or
should have) a `continuous-improvement` tag. Leaving it undeclared was the
observed state: enrollment selected zero roles and the cycle exited 0 having
reached nobody.

### The field

`roles.<role>.role_capabilities` — a string array, absent means empty.

* Read only through `roleCapabilities(role)` in `src/bus/model-registry.ts`.
* **Never** read by `validateCandidate()`, `resolve()`, or anything else in the
  resolution path. A role carrying a nonsense role capability resolves exactly
  as it did before.
* Seeded with `continuous-improvement` on the ten roles that run a model worker
  and can act on a lesson about their own job: `dispatcher`, `revenue_ops`,
  `delivery_ops`, `finance_ops`, `listing_intel`, `growth_ops`, `vera`,
  `vivienne`, `builder`, `verifier`. `ingress` is deliberately excluded — it is
  a transport role that hands work to the roles above rather than owning an
  outcome it could improve against a metric.

### The verbs

```
cortextos model role-capability add    --role <role> --capability <cap> --reason "..." [--expected-revision N] [--json]
cortextos model role-capability remove --role <role> --capability <cap> --reason "..." [--expected-revision N] [--json]
cortextos model role-capability list   [--role <role>] [--json]
```

`add` and `remove` follow the same contract as `switch`/`pin`/`unpin`: CAS on
the expected revision, `--reason` required, one journal entry per state
transition in `orgs/<org>/model-events/`, revertible via
`cortextos model revert --operation <id>`.

They differ from every other mutating verb in one way: **a capability change
never restarts an agent.** `affectedAgents()` returns `[]` for the operation, so
the receipt reports `restart_required: false` and `restart_results: []` — an
empty restart list here means "nothing needed restarting", not "restarts were
skipped".

Adding a capability a role already has, or removing one it does not have, is
rejected rather than burning a revision and an audit event on a no-op.

### Consumer

JARVIS `scripts/agent-org/kaizen_weekly.py` enrolls on `role_capabilities`. An
empty enrollment remains a finding (`cycle_no_eligible_roles`, deduplicated on
the registry revision), never a quiet week.
