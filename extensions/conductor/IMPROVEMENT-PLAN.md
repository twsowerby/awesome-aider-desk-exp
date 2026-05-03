# Conductor Extension — Improvement Plan

Phased plan to improve agent reliability and reduce token consumption in the Conductor multi-agent orchestration extension.

---

## Problem Statement

When a specialist subagent fails (API error, context overflow from unbounded tool output, etc.), the current result extraction mechanism crashes the entire process:

1. `delegateViaSubtask` calls `getContextMessages()` on the subtask — this returns ALL messages including token bombs
2. It scans for a `<!-- RESULT -->` marker — a soft prompt contract that agents frequently ignore or misformat
3. When the marker is missing, it falls back to the **longest** assistant message — which is typically the token bomb or error trace itself
4. This unbounded content is injected into the Conductor's tool result, overflowing its context
5. The Conductor then tries to manually investigate the failed subtask, making it unrecoverable

Secondary issue: the Conductor's system prompt contains ~1500 tokens of Post-Implementation Pipeline instructions that are only relevant after implementation waves, wasting tokens on every turn.

---

## Phase 1: Crash Prevention ✅

**Goal:** Eliminate unrecoverable crashes from token bombs and failed subtasks.

**Status:** Implemented.

|| # | Change | File | Status |
||---|--------|------|--------|
|| 1a | Add `report-result` tool for specialist agents. Tool `execute` stores result by task ID in an instance `Map<string, string>`, caps at 4000 chars | `index.ts` | ✅ |
|| 1b | Replace `<!-- RESULT -->` message scanning in `delegateViaSubtask` with Map lookup. Remove `getContextMessages()` call, remove longest-message fallback. Return bounded error message for missing result | `index.ts` | ✅ |
|| 1c | Capture `runPrompt` errors separately from missing-result errors. Include specific error info in tool result | `index.ts` | ✅ |
|| 1d | Replace `<!-- RESULT -->` instructions with `report-result` tool instructions in all specialist agent `operationalNotes` | `agent-configs.ts` | ✅ |
|| 1e | Update `.md` files for consistency (functionally dead but avoids reader confusion) | `agents/*.md` | ✅ |

**Result:** No unbounded data ever flows from subtask to Conductor. Any subtask failure produces a bounded, specific error message.

### Revision 1: Error Classification ✅

**Added after Phase 1 implementation.** Provider API errors like `{"code":400,"message":"Provider returned error","metadata":{"error_type":"invalid_request"}}` are opaque. The Conductor and user need to know whether an error is transient (worth retrying) or persistent (requires action).

|| # | Change | File | Status |
||---|--------|------|--------|
|| 1c-rev1 | Classify `runPrompt` errors as transient (429, 500-503, timeout, rate limit, overloaded) vs persistent (400, invalid_request, etc.). Include classification + actionable retry hint in the error message: transient → "This error may be transient — retry is likely to succeed."; persistent → "This error is likely persistent — consider simplifying the task or switching model." | `index.ts` | ✅ Implemented |

This classification also feeds Phase 3: transient errors enable the `retry-subtask` tool; persistent errors skip it.

---

## Phase 2: Failure Handling

**Goal:** Prevent the Conductor from spiraling when delegation fails.

|| # | Change | File |
||---|--------|------|
|| 2a | Add "Delegation Failure Handling" section to Conductor's `operationalNotes`: don't retry unchanged, don't investigate with own tools, report to user with options (simplify task, switch model, skip step) | `agent-configs.ts` |
|| 2b | Add corresponding "Delegation Failure Handling" section to `conductor.md` | `agents/conductor.md` |

**Result:** Conductor responds to failures by reporting to the user with options, not by entering retry loops or manual investigation.

---

## Phase 3: Subtask Retry

**Goal:** Allow failed subtasks to resume with full context preserved.

Uses AiderDesk platform APIs:
- `TaskContext.redoLastUserPrompt()` — re-runs the last prompt in the task, preserving all prior conversation context
- `ProjectContext.forkTask(taskId, messageId)` — safety net: fork from last known-good message if failure corrupted the conversation

|| # | Change | File |
||---|--------|------|
|| 3a | Add `retry-subtask` tool (conductor-only, subtask mode): takes a subtask ID, gets the subtask's `TaskContext`, calls `redoLastUserPrompt()` on it, waits for completion, extracts result via the `report-result` Map | `index.ts` |
|| 3b | Store failed subtask IDs in an instance Map so the Conductor can reference them | `index.ts` |
|| 3c | Add "Retry" as an explicit option in the Conductor's failure handling instructions, with the subtask ID included in the error message | `agent-configs.ts`, `agents/conductor.md` |

**Result:** When a subtask fails due to a transient error (API blip, rate limit), the Conductor can offer the user a retry that preserves all prior work and context.

---

## Phase 4: Skill-Based Pipeline

**Goal:** Remove the Post-Implementation Pipeline instructions from the Conductor's always-on system prompt, load on demand.

The AiderDesk skills system loads instruction files on demand via a tool call. They are never pre-loaded into the system prompt. Skill content survives conversation compaction. This is ideal for pipeline instructions that are only relevant after implementation waves.

|| # | Change | File |
||---|--------|------|
|| 4a | Extract Post-Implementation Pipeline content from Conductor's `operationalNotes` into a `conductor-post-implementation-pipeline/SKILL.md` file in `.aider-desk/skills/` (written during `onLoad`) | `index.ts` |
|| 4b | Replace full pipeline detail in `operationalNotes` with brief directive: "After every implementation wave, activate the `conductor-post-implementation-pipeline` skill and follow it" | `agent-configs.ts` |
|| 4c | Enable `useSkillsTools: true` on the Conductor agent profile | Already set in overrides — no change needed |
|| 4d | Same extraction for `conductor.md` | `agents/conductor.md` |

**Result:** ~1500 tokens saved per Conductor turn when the pipeline isn't active. ~24K tokens saved per typical 20-turn session.

---

## Phase 5: Agent Consolidation

**Goal:** Reduce agent count from 8 to 6, cutting token overhead and delegation complexity.

The harness best practices doc supports this: *"Keep it monolithic until complexity demands otherwise. Multi-agent systems introduce the same complexity as microservices, compounded by non-determinism."*

**Critic**: Spec review is well within the Conductor's capability. It doesn't need a separate agent with its own context window.

**Simplifier**: The Implementor can handle post-implementation simplification as a directive — it already has file-editing capability and knowledge of what changed.

|| # | Change | File |
||---|--------|------|
|| 5a | Remove Critic agent from `agents/index.json` | `agents/index.json` |
|| 5b | Add spec review checklist to Conductor's workflow step 2 ("Plan") in `agent-configs.ts` | `agent-configs.ts` |
|| 5c | Remove Simplifier agent from `agents/index.json` | `agents/index.json` |
|| 5d | Add simplification directive to Implementor's `coreDirectives`: "After implementing, review your own changes for simplification opportunities before reporting completion" | `agent-configs.ts` |
|| 5e | Remove Critic and Simplifier from the specialist table in Conductor's `operationalNotes` and `conductor.md` | `agent-configs.ts`, `agents/conductor.md` |
|| 5f | Update Post-Implementation Pipeline skill: remove Simplifier step, adjust step numbering | skill file |
|| 5g | Remove `agents/critic.md` and `agents/simplifier.md` | filesystem |

**Result:** ~6-8K tokens saved per task. Fewer delegation decisions. Fewer failure points.

---

## Dependency Graph

```
Phase 1 (crash prevention) ✅
  ├── Phase 2 (failure handling) — depends on Phase 1
  └── Phase 3 (subtask retry) — depends on Phase 1 + Revision 1

Phase 4 (skill-based pipeline) — independent, can be done anytime after Phase 1
Phase 5 (agent consolidation) — independent, can be done anytime
```

Phases 1–3 are the critical path (fix the crash). Phases 4–5 are independent performance improvements.
