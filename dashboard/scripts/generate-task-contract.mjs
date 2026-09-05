#!/usr/bin/env node
// Regenerates dashboard/src/lib/data/task-contract.generated.ts from the shared
// fixture at <repo>/tests/fixtures/task-status-contract.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fixture = path.join(repo, 'tests/fixtures/task-status-contract.json');
const out = path.join(repo, 'dashboard/src/lib/data/task-contract.generated.ts');

const data = JSON.parse(fs.readFileSync(fixture, 'utf-8'));
delete data.cases;

const header = `// GENERATED from tests/fixtures/task-status-contract.json — do not hand-edit.
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

export const TASK_CONTRACT = ${JSON.stringify(data, null, 2)} as unknown as TaskContract;
`;

fs.writeFileSync(out, header);
console.log(`wrote ${out}`);
