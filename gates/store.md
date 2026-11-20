# Gates: Reviewed-memory storage engine

Scope: Implement src/review-store.ts and tests/review-store.test.ts only; no commits or edits outside these two files and this gates file.

- [x] S1: Snapshot staging and persisted proposals isolate operative Markdown, retain full before/after changes, runtime provenance, attributed rationale, and unavailable/failed outcomes.
  CHECK: node --import=tsx --test tests/review-store.test.ts
  EXPECT: # fail 0
  EVIDENCE: Latest focused run: 48 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo. Earlier combined run: 100 passed, 4 skipped, 0 failed. Repository typecheck passes.

- [x] S2: Acceptance/rejection validates pending status and baselines, resulting index links and deleted references, and protects history/proposal paths against unsafe traversal and symlinks.
  EVIDENCE: Tests verify baseline validation, index reference checks, and path traversal/symlink rejection in accept/reject/recover paths.

- [x] S3: Grouped acceptance uses an existing shared lock plus durable recovery journal; injected interruption can recover safely, and external conflicting edits are not overwritten by recovery.
  EVIDENCE: Integration test "interrupted journal withholds operative recall until explicit recover, never startup autoaccept" passes with injected journal interruption.

- [x] S4: Expert reread/adversarial pass completed; API documented for integrator and focused tests/typecheck verified without hiding pre-existing failures.
  EVIDENCE: Full adversarial reread confirms baseline validation, symlink containment, no-symlink staging, failed/aborted distinction, recovery conflict detection, and no migration of existing .pi memory.
