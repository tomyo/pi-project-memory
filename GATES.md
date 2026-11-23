# Gates: Untangle reviewed-memory; land provenance

Scope: Two upstreamable commits: (1) remove reviewed-memory workflow keeping project-local container; (2) add lightweight provenance for maintenance writes.

- [x] G1: Removal commit strips review config/staging/commands/guards/store while keeping useProjectMemory + projectMemoryDirectory + validation + session pinning + .em tests; repo no longer tracks generated .pi/.em memory data.
  CHECK: git log --oneline -2 && git grep -l "review" -- src/ index.ts | head -5
  EXPECT: /revert: remove reviewed-memory/ and no review feature code in src/index (doc/prompt mentions of the word excluded)
  EVIDENCE: Commit d6bb01e on top of dc60a09. Stat: src/review-store.ts deleted (-717), tests/review-store.test.ts deleted (-533), index.ts -208, src/models.ts -95, config/types -3 each, README/config.example/docs/configuration cleaned, .gitignore +4 (.em/ and .pi/), generated .pi blobs untracked. rg for "review-store|ReviewProposal|reviewRecoveryRequired|ReviewedChildRunResult|formatReviewInspection|review\.enabled" over non-md files: no matches. Tracked .pi/.em paths: 0. Kept: useProjectMemory/projectMemoryDirectory/normalizeProjectMemoryDirectory, session pinning, tests/config + paths additions.

- [x] G2: Provenance commit records role/at/session/model on maintenance writes (frontmatter) plus append-only provenance.jsonl audit log with rotation; external/unattributed edits stay unattributed.
  CHECK: node --import=tsx --test tests/provenance.test.ts
  EXPECT: # fail 0
  EVIDENCE: Commit dadf9c2: new src/provenance.ts (98 lines) + tests/provenance.test.ts (324 lines, 12 tests, all pass). ToolEnvironment carries {role, sessionId, model}; commitMemory merges provenance frontmatter preserving other keys and body bytes; parent writes stamp role agent; JSONL log at memory-roots root with before/after hashes, best-effort appends, 5 MiB rotation keeping one prior segment; absent provenance = externally edited, never fabricated.

- [x] G3: Full suite, typecheck, lint green after both commits; default write behavior matches upstream (direct extraction/Dream writes, no proposals, no gates).
  CHECK: npm test 2>&1 | tail -n 8 && npm run typecheck && npm run lint
  EXPECT: # fail 0
  EVIDENCE: Parent re-run after dadf9c2: tests 319, pass 312, fail 0, skipped 7 (Windows-only); typecheck OK; lint OK. (Worker runs agreed: removal leaf 307/300/7/0; provenance leaf 319/312/7/0.)

- [x] G4: Docs consistent: no review commands/fields in README/configuration docs; provenance documented with authority limits (operations, not truth; unattributed = external).
  EVIDENCE: dadf9c2 diff: README.md +12/-x Provenance section, docs/configuration.md +8/-x note incl. unknown-config-field tolerance; removal commit stripped all review rows/bullets/sections; rg review-feature patterns over non-md files: no matches.

- [x] G5: History clean: exactly two new commits on top of dc60a09; no review-store leftovers in tree; proposals data (outside repo) untouched by commits.
  EVIDENCE: git log: dc60a09 -> d6bb01e (revert/removal) -> dadf9c2 (provenance). Neither commit touches ~/.pi/agent proposal data (outside repo); worktree clean after planning-record commit.
