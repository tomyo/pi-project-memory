# Plan: Keep provenance and safety, remove the manual review workflow

## Goal

Keep the useful parts of the reviewed-memory work (provenance on writes, baseline validation, recovery journal) and remove the parts that failed in practice (proposal staging for every extraction/Dream, manual accept/reject commands, write/edit guards in reviewed mode). The end state: automatic extraction and Dream write directly to operative memory, every maintenance write carries lightweight provenance, and an interrupted application can still be recovered safely.

## Decisions recorded (from this conversation)

- Reviewed mode is removed because it does not scale: 152 pending proposals accumulated across 4 projects; no human will review them one by one. User preference confirmed in memory (`feedback-memory-review-workflow.md`).
- Provenance fields worth keeping: `role`, timestamp, `sessionId`, model. `operationId` is dropped as redundant — `(sessionId, role, timestamp)` is already unique for this use case.
- `projectMemoryDirectory` / `useProjectMemory` / `.em` container stays — that is a separate, successful feature.
- `review.enabled` config field is removed (or retained as a no-op alias only if trivial; prefer removal and document migration).
- Existing 152 pending proposals: one final cherry-pick prompt run per project is offered, then the review store directories are deleted. No code path depends on them after removal.

## Scope

### Keep (already exists, minor changes only)

1. **Baseline-checked atomic writes** (`src/child-tools.ts` `commitMemory` via `atomicWriteIfBaseline`, `safeDeleteMemoryFile`) — unchanged.
2. **Recovery journal** (`src/review-store.ts` journal + `recoverReviewStore`) — retained but detached from proposals: used for grouped atomic application of extraction/Dream writes, recoverable via an explicit `/memory recover` only when a journal exists. Proposed-but-not-applied proposals disappear as a concept.
3. **`projectMemoryDirectory` + validation + session pinning** (`src/config.ts`, `src/paths.ts`, `index.ts`) — unchanged.

### Remove

1. **`review.enabled` config field** and its parse/default/doc entries.
2. **Reviewed child-run staging path** in `src/models.ts` (`runChildAgent` review branch, `ReviewedChildRunResult`, staging rules injection). Extraction and Dream always run `runUnreviewedChildAgent` against operative memory.
3. **Proposal concepts and APIs** in `src/review-store.ts`: `prepareReviewWorkspace`, `finalizeReviewProposal`, `listReviewProposals`, `readReviewProposal`, `rejectReviewProposal`, `acceptReviewProposals` (in proposal form), `ReviewProposal` metadata type, proposals directory layout.
4. **Commands** in `index.ts`: `/memory review`, `/memory accept`, `/memory reject` and their UI/format helpers. `/memory recover` stays.
5. **Parent write/edit guards** keyed on review mode (index.ts `tool_call` blocking for reviewed mode) — removed; default direct-write behavior applies.
6. **Prompt changes for reviewed mode** (`src/prompts.ts`) — removed.
7. **Docs and tests** for the removed workflow (`docs/reviewed-memory.md` if present, review sections in README/configuration docs, `tests/review-store.test.ts` proposal-specific cases, `tests/review-integration.test.ts` proposal/guard cases).

### Add

1. **Lightweight provenance on maintenance writes.** When the extractor or Dream writes/updates a topic file, append/merge a provenance block into the topic frontmatter:
   ```yaml
   provenance:
     role: extractor        # or dream
     at: 2026-11-24T12:00:00.000Z
     session: <sessionId>
     model: litellm/openai/gpt-6.1-terra   # actual runtime model, provider/id; omitted if unknown
   ```
   Rules:
   - Provenance records the *last* maintenance operation that touched the file (updated in place on each write).
   - Direct writes by the main agent (user-asked saves) get `role: agent` with session/model — distinguishes "user-asked" from "background-extracted".
   - Existing files without provenance keep working; the block is added on next background update. No migration run.
   - External editors are not required to add provenance; its absence means "externally edited, unattributed" — this is honest unknown, matching the earlier design principle.
2. **Provenance index (audit trail).** A single append-only JSONL file under the private state area (`memory-roots/<hash>/provenance.jsonl`), one line per maintenance write:
   ```json
   {"at":"...","role":"extractor","session":"...","model":"...","path":"topic.md","action":"create|update|delete","baseline":"<sha256-before|null>","result":"<sha256-after|null>"}
   ```
   - Written by the same write path that already computes baselines — cheap, no extra scans.
   - Bounded: rotated at e.g. 5 MB into `provenance.jsonl.1` (keep one rotation, older deleted). This is a local audit convenience, not a compliance system.
3. **Grouped recovery retained.** Extraction/Dream multi-file writes continue to journal (journal file in the private area) so an interrupted multi-file update can be rolled forward with `/memory recover`. Journal identity uses `(sessionId, role, startedAt)` in the journal header instead of proposal IDs.
4. **CLI helper for one-time cleanup** (optional, small): a `scripts/drain-reviews.mjs` that reads each `review/proposals/*.json` with non-empty `after`, extracts topic contents to `.em/memory/` and updates the index — the automated version of the cherry-pick prompt, run once per project, then the review directories are deleted. If this proves fiddly, the manual prompt fallback is acceptable; the plan does not depend on it.

## Compatibility

- Default behavior is identical to upstream: extraction/Dream write operative memory directly. `review.enabled` in an existing config.json is now an unknown field and is ignored (parse already ignores unknown fields) — document that in the changelog.
- No data migration required. Provenance blocks appear on topics as background maintenance touches them.
- The `.em` container, symlinks from `.pi`, and session pinning behavior are untouched.
- Pi sessions that are mid-review-acceptance when the update lands: the journal recovery path keeps working; orphaned proposal files in the private store are inert and can be deleted manually.

## Testing

- Unit: provenance frontmatter merge rules (create/update/delete, existing file without provenance, agent-role writes, model unknown).
- Unit: provenance.jsonl append, rotation, and baseline/result hashing.
- Unit: recovery journal with new header identity; interrupted apply + `/memory recover` roll-forward; external-edit conflict fails closed (carry over existing store tests, minus proposal APIs).
- Integration: extraction and Dream in default mode write operative memory with provenance; interrupted journal withholds recall until recover (keep this safety behavior — it guards journal recovery, not proposals); direct parent writes succeed unguarded in default mode; `.em` pinning unchanged.
- Regression: full existing suite minus removed proposal tests passes; typecheck and lint clean.

## Documentation

- README: remove review commands row and reviewed-mode bullet; add a short "Provenance" section (what is recorded, where the audit log lives, limits — provenance describes operations, not truth).
- docs/configuration.md: remove `review.enabled`; document that unknown fields are ignored so stale configs keep working.
- Remove docs/reviewed-memory.md (or replace with a short provenance doc if the content is worth keeping).
- PLAN.md/GATES.md of the previous effort remain as history; do not delete.

## Execution order (final, two commits)

1. **Commit 1 (removal)**: strip review config field, staging path, commands, guards, proposal store, journal/recover (journal existed only for proposal acceptance; upstream per-file atomic writes already tolerate partial Dream state), docs, and proposal-specific tests. Untrack generated `.pi/`/`.em/` blobs and gitignore project-local containers. Keep projectMemoryDirectory work and its tests.
2. **Commit 2 (provenance)**: provenance frontmatter merge + provenance.jsonl audit log in the existing write path, tests, docs.
3. One-time local cleanup (outside repo): drain or delete the 152 proposal files under `~/.pi/agent/project-memory/memory-roots/*/review/` after the commits land; not part of either commit.

## Out of scope

- Project-level config overrides (discussed, deferred upstream).
- Upstream PR preparation (separate effort; the removal diff actually improves upstreamability since default behavior matches upstream).
- Any model-trust ranking, epistemic taxonomy, or acceptance automation.
