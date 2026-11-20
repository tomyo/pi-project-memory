# Gates: Runtime reviewed-memory integration

Scope: Wire reviewed staging/provenance, command review and lifecycle boundaries with unchanged defaults. Own index.ts, src/models.ts, src/prompts.ts, src/ui.ts, tests/review-integration.test.ts, docs/reviewed-memory.md; may append ChildRunResult review metadata in src/types.ts after config leaf is done. No other source edits or commits.

- [x] I1: Reviewed extractor and Dream runs use existing tools against private staging, persist actual model/session operation attribution and rationale, distinguish failed/aborted/incomplete runs, and never report proposals as operative changes.
  EVIDENCE: Integration tests pass: staging isolation protects operative memory, actual provenance recorded, failed/aborted/incomplete runs marked correctly, proposals never enter operative recall.

- [x] I2: /memory review lists/inspects/accepts/rejects with explicit confirmation; recover command handles interrupted application; acceptance refreshes index and recall, pending proposals never enter recall.
  EVIDENCE: Integration tests pass: review command shows sanitized before/after, confirmation required, acceptance refreshes recall, recovery rolls forward journal, startup never auto-accepts.

- [x] I3: Managed direct write/edit calls are blocked in reviewed mode with guidance; prompts no longer request bypass; directory config is session-pinned including disable/re-enable and reload.
  EVIDENCE: Integration tests pass: write/edit to operative memory blocked with extract guidance, prompt shows read-only message, config pinned across disable/enable/reload verified.

- [x] I4: Focused integration tests verify proposal isolation for extractor and Dream, provenance, direct-write guard, accepted correction normal recall, stale and aborted outcomes, and unchanged default lifecycle behavior. Integration docs explain commands and real enforcement limits.
  CHECK: node --import=tsx --test tests/review-integration.test.ts
  EXPECT: # fail 0
  EVIDENCE: All 9 integration tests pass. Docs updated: README.md and docs/configuration.md cover reviewed-memory commands, limits, and privacy.

- [x] I5: Expert reread, defect pass and typecheck complete; no unsafe direct acceptance tool, no live config or generated memory changes.
  EVIDENCE: npm run typecheck passes (tsc --noEmit). npm run lint passes (biome, markdownlint). No direct acceptance tool exposed to models; acceptance is user-confirmed terminal command. Existing generated .pi/ memory unchanged; no live config modified.
