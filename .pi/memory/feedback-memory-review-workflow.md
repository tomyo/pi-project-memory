---
name: memory-review-workflow
description: User favors explicit review of agent-derived knowledge before closing Pi, with minimal automation machinery.
metadata:
  type: feedback
---

For memory UX proposals, favor an explicit end-session review while Pi is still open: the agent proposes durable knowledge learned during the session, the user confirms what to retain, then the user can close Pi.

**Why:** The user often starts work with a short instruction such as "continue with plan" and expects useful knowledge from the agent's subsequent work to be considered, rather than having to summarize it manually. They rejected shutdown-time confirmation as impractical because Pi is closing, suggested a function or skill instead of pending queues, and raised concerns about introducing anti-patterns or interfering with automatic Dream.

**How to apply:** Explain existing Extract and Dream behavior before proposing changes. Keep review distinct from consolidation, ask before saving candidates in the proposed workflow, and distinguish an optional review habit from an enforced approval barrier. This is a design preference, not approval to implement or disable automatic memory. See [[verify-before-diagnosing]].
