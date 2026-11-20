---
name: harness-independent-memory
description: Tomyo is evaluating this extension as a stepping stone toward harness-independent project memory for Epistemic Machine.
metadata:
  type: project
---

Tomyo is trying this local memory extension both for Pi use and to explore the Epistemic Machine goal: eventually a project folder could carry an `.em` directory and operate as a "machine" independently of a particular agent harness, with its own retained memory.

**Why:** He wants knowledge retained in a project to remain useful to other agents/harnesses, rather than belong exclusively to Pi. This motivates questioning the Pi-specific storage name and exploring a more general project-local convention.

Tomyo also wants provenance for memory rewrites, including which model made each change. He reports that this conversation began with a less capable model and that a later model corrected its mistakes; he worries that a future less capable session could corrupt the corrected memory. This is his motivating concern, not a verified attribution of individual historical edits. He regards stable epistemic labels and not asserting more than evidence supports as important workflow principles; how to account for differing model capabilities remains an open design question.

**How to apply:** Evaluate memory ownership, portability, correction, discovery, and revision provenance across harnesses, not just Pi automation. Discuss safeguards against losing supported understanding without treating model identity as proof of correctness. The assistant's suggestions of runtime-captured attribution, recoverable revisions, and bounded write authority remain proposals, not adopted policy or implementation authorization. Treat `.em` as his eventual direction, not an adopted storage standard or authorization to rename directories, implement adapters, or revise Epistemic Machine architecture. The assistant's proposed `.em/memory/` layout and two-harness trial remain proposals, not user-approved decisions. Understand existing behavior before changing it; see [[memory-review-workflow]].
