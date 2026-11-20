# Plan: Reviewed memory without replacing the extension

## Scope and compatibility

User authorized Unlazy implementation of opt-in reviewed memory and configurable project-local container naming. Default extraction, Dream cadence, recall, storage, and commands stay compatible. No memory migration, model prestige ranking, universal epistemic schema, daemon, or source-repository memory publication is included. Existing generated `.pi/` changes are outside the implementation diff.

## Current-code fit

- `src/models.ts:507` is the shared extraction/Dream execution seam. Keep native child tools and their safety checks; reviewed runs use a private snapshot workspace instead of writing operative memory.
- `src/child-tools.ts:185` already provides baseline-checked atomic mutations; deletion has a separate restricted-bash path. Staging both paths avoids duplicating their mutation semantics.
- `index.ts:1195` and `index.ts:1328` dispatch the two maintenance roles. Pending proposals must not trigger operative-memory change notifications or recall invalidation.
- `index.ts:501` can block managed parent write/edit calls in reviewed mode. Shell/external writers remain outside the enforcement boundary and must never receive fabricated attribution.
- `index.ts:700` handles config reload; `index.ts:877` initializes paths. All directory-affecting configuration must be pinned to the session boundary, including disable/re-enable.
- `src/paths.ts:290` currently hardcodes `.pi/memory` and `.pi/memory-state`; preserve the existing local-mode precedence over `autoMemoryDirectory`.

## Contracts

- Add `review: { enabled: false }` and `projectMemoryDirectory: ".pi"` to global JSON configuration. `projectMemoryDirectory` is one safe directory component (e.g. `.em`), never an absolute path/traversal/reserved `.git` name. Invalid inputs fall back to `.pi`; validate also at exported path API boundary.
- Extend `resolveProjectPaths(cwd, autoMemoryDirectory, useProjectMemory, projectMemoryDirectory = ".pi")` compatibly. Both `memory/` and `memory-state/` move beneath the selected container only on a new session; do not move files.
- Reviewed maintenance runs stage a bounded snapshot of operative Markdown, execute existing child tools against that workspace, then save a pending proposal. Operative recall scans only the unchanged original root. Proposal metadata contains runtime operation/session/model identity, source baseline, exact before/after content (therefore recoverable diffs), timestamp, model-attributed rationale, and outcome. Failed/aborted runs must not become silently acceptable normal proposals.
- Store proposals/history privately beside the existing shared memory-root lock namespace, not among recalled Markdown. Existing content has unknown historical authorship.
- Review commands list/inspect/accept/reject proposals. Acceptance is an explicit user command with confirmation in interactive mode, not a model-callable acceptance tool. Use a shared application lock and optimistic baseline validation. Validate resulting index references, group index/topic changes, journal before applying, recover interrupted application without silently overwriting intervening external writes, retain history.
- Parent managed write/edit calls to operative memory are blocked only when review is enabled, with actionable proposal/extract guidance. Detect external modifications as unattributed, not as accepted reviewed operations. This is cooperative workflow enforcement, not filesystem isolation.
- No claim of automatic fact verification. Rationale/evidence are attributed model text; reviewer responsibility is explicit. Runtime model attribution is per operation, not inferred from the session's initial model.

## Execution tree and file ownership

1. Storage/proposal engine leaf: `src/review-store.ts`, `tests/review-store.test.ts` only. Implement staging/provenance persistence, review/accept/reject, index checks, recoverable apply and tests.
2. Local storage configuration leaf: `src/config.ts`, `src/types.ts`, `src/paths.ts`, `tests/config.test.ts`, `tests/paths.test.ts`, `config.example.json` only. New optional result metadata in ChildRunResult may be integrated by parent later.
3. Runtime integration leaf (after 1/2): `src/models.ts`, `index.ts`, `src/prompts.ts`, UI if needed, new integration tests and docs. Wire store API, parent mutation guard, review commands, lifecycle pinning, default compatibility.
4. Parent integration: verify each leaf, run full suite, adversarial independent review, fix defects, document and commit only implementation files.

Each implementation leaf receives a narrow gates file. Parent re-runs its checks. Shared integration changes happen after disjoint leaves complete.

## Status log

- Initial gates and current-code map created. Pre-existing `.pi/` generated changes preserved. No live config changed.
