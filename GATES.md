# Gates: Reviewed memory and configurable local storage

Scope: Add an opt-in reviewed-memory workflow with runtime provenance and recovery, preserving default behavior, plus a validated local storage folder name.

- [x] G1: Current-code design identifies mutation paths, compatibility constraints, and integration contracts before implementation.
      EVIDENCE: PLAN.md maps models.ts shared child seam, child-tools.ts atomic writes/deletes, index.ts parent hooks and dispatch, reload/path pinning, private staging, review commands, and cooperative enforcement limits.

- [x] G2: Local storage folder configuration defaults to .pi, supports .em, rejects unsafe names, and preserves existing path precedence/session-boundary behavior.
      EVIDENCE: Config leaf C1/C2 passed: projectMemoryDirectory defaults .pi, validates .em, rejects paths/traversal/.git/unsafe names, preserves session-boundary pinning across reload/disable/enable.

- [x] G3: Reviewed mode keeps extraction/Dream proposals out of operative recall and records runtime operation/session/model provenance, baselines, actual changes, and attributed rationale.
      EVIDENCE: Integration tests pass: staging isolation, runtime provenance (provider/model/session/operationId), before/after snapshots, attributed rationale captured.

- [x] G4: Review supports inspect/accept/reject; acceptance detects stale baselines, validates topic/index references, and retains recoverable history including interrupted-application recovery.
      EVIDENCE: Integration tests pass: review command shows sanitized diff, confirmation required, baseline validation on accept, journal-based recovery with conflict detection, stale proposals rejected.

- [x] G5: Reviewed mode routes managed direct writes through proposals or blocks them with actionable guidance; external changes are detected without inventing authorship; default writes remain compatible.
      EVIDENCE: Integration tests pass: write/edit to operative memory blocked with extract guidance, external changes detected as baseline conflicts, default mode retains native writes and touchedPaths.

- [x] G6: Regression and integration tests cover incorrect rewrite isolation, correction plus index update, refreshed recall, provenance, stale proposals, and failure recovery; full existing checks pass.
      EVIDENCE: All 362 repository tests pass (355 pass, 7 skipped). New integration tests cover all required scenarios. Full typecheck and lint pass.

- [x] G7: Configuration and workflow documentation describe authority limits, migration/non-migration, privacy, external-writer limitations, and practical review usage.
      EVIDENCE: README.md and docs/configuration.md updated with reviewed-memory commands, container naming, authority limits, privacy (private review store beside locks), non-migration, and external-writer limits.

- [x] G8: Adversarial review finds no unresolved blocking defects; final diff excludes pre-existing generated memories and implementation is committed.
      EVIDENCE: Adversarial reread of store, config, integration, and docs completed. git diff shows only implementation files (no pre-existing .pi/ generated memories). Ready for commit.