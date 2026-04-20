# Conductor Extension Improvements Roadmap

This document outlines a phased roadmap of improvements for the Conductor extension, aimed at hardening the orchestration engine, refining prompt and state management, and expanding ecosystem capabilities.

---

### Phase 1: Hardening the Orchestration Engine (Core API)
*These improvements use AiderDesk's native events to enforce deterministic behavior and prevent LLM hallucinations from breaking the workflow.*

**COMPLETE - 1. Hardware-Level Sandboxing for Read-Only Agents**
*   **What:** Block write tools for read-only agents (`verifier`, `reviewer`, `critic`, `investigator`).
*   **Why:** Prevents the "grading your own homework" problem. If a Verifier hallucinates and tries to fix a failing test itself using `file_write` or `bash`, it bypasses the validation loop.
*   **How:** Implement `onToolApproval` in `index.ts`. If the agent profile matches a read-only agent and the tool is a write tool (`file_write`, `file_edit`, `bash`, `run_prompt`), return `{ blocked: true }`.

**COMPLETE - 2. Enforcing "report-result" (Catching Lazy Agents)**
*   **What:** Force subagents to call `report-result` before finishing.
*   **Why:** LLMs sometimes output conversational text and stop generating without calling the required tool, causing the delegation loop to fail.
*   **How:** Implement `onAgentStepFinished` in `index.ts`. If `event.finishReason === 'stop'` and `state.pendingReportResults` doesn't have the task ID, return an `other` finish reason and inject a system message forcing them to call the tool.

**COMPLETE - 3. The "Pinning" Pattern for Context Trimming**
*   **What:** Preserve the user's initial intent during long-running tasks.
*   **Why:** The current `onOptimizeMessages` blindly slices the last XX messages. On long tasks, this deletes the user's initial request and any mid-task course corrections, leading to goal drift.
*   **How:** Update `onOptimizeMessages` in `index.ts`. Instead of `messages.slice(-30)`, explicitly pin `messages[0]` (the original prompt) and any message where `role === 'user'` (direct user input), then fill the remaining budget with the most recent messages.

**COMPLETE - 4. Optimize Task Creation (API Round-trip)**
*   **What:** Remove the redundant `updateTask` call during delegation.
*   **Why:** Slightly faster delegation and cleaner state initialization.
*   **How:** In `src/delegation.ts` (`delegateViaSubtask`), pass `agentProfileId: profile.id` directly into the `createTaskParams` object. Remove the subsequent `await subtaskContext.updateTask()`.

---

### Phase 2: Prompt & State Management
*These improvements refine how agents interact with the file system, search tools, and their own instructions.*

**COMPLETE - 5. Search Strategies & CBM-First Resolution (Preventing 0-Result Loops)**
*   **What:** Stop agents from failing 10+ times when searching for files by giving them the repo map and strict search formatting rules.
*   **Why:** Agents currently guess exact file paths with `glob` (e.g., `src/auth.ts`) or forget that `cbm-search-graph` requires a regex, resulting in endless 0-result loops.
*   **How:** 
    *   Enable `"includeRepoMap": true` for the `conductor` and `investigator` in `agents/index.json` so they can pass exact paths downstream.
    *   Update the *Tool Selection Guide* in all specialist prompts (`investigator.md`, `debugger.md`, etc.) to explicitly instruct: 
        *   Use `.*` regex wildcards for `cbm-search-graph` (e.g., `.*Auth.*`).
        *   NEVER use exact strings for `glob`; always use `**/*` wildcards.

**COMPLETE - 6. Anti-Placeholder Prompting**
*   **What:** Explicitly ban lazy coding in the `implementor` prompt.
*   **Why:** LLMs are biased toward writing minimal/stub code (e.g., `// implementation here`) because it saves tokens and fulfills their internal reward function.
*   **How:** Add a hard rule to `agents/implementor.md`: *"NEVER use placeholders like `// implementation here` or `...`. You must write the complete, functional code."*

**POSTPONED -  DO NOT ACTION - 7. File-Based Agent Self-Improvement**
*   **What:** Store project-specific learnings in physical files, not internal databases.
*   **Why:** Knowledge hidden in an internal SQLite database cannot be version-controlled, reviewed in PRs, or shared with human developers.
*   **How:** Instruct the `conductor` or `documenter` to write project-specific rules (e.g., "Always use clsx") to `.aider-desk/instructions/` markdown files. The existing `path-instructions` extension will automatically inject these into future contexts.

---

### Phase 3: Ecosystem & Capability Upgrades
*These improvements expand the harness's ability to verify work in real-world scenarios.*

**8. Baseline Pre-flight Verification**
*   **What:** Verify the existing app works *before* touching code.
*   **Why:** If the previous session or human developer left the codebase in a broken state, the agent will waste cycles trying to fix bugs it didn't create, or assume its own changes caused them.
*   **How:** Add a step to the Conductor's `UNDERSTANDING` phase to run a baseline test suite or build command before delegating to the `implementor`. This functionality should be enabled/disabled at the config level (important for codebases that have errors elsewhere in them)

**POSTPONED - NOT NOT ACTION - 9. UI/Browser Automation for the Verifier**
*   **What:** Equip the `verifier` with browser automation tools.
*   **Why:** Currently, the verifier relies on unit tests and CLI commands. Agents will confidently mark UI features as "complete" without ever looking at the rendered application, missing visual bugs.
*   **How:** Integrate tools like Puppeteer or Playwright (via an MCP server) so the `verifier` can navigate the running app, take screenshots, and visually confirm changes.

---

### Phase 4: Advanced Harness Alignment
*These improvements align the extension with advanced agentic patterns, focusing on macro-determinism, loop protection, and model-specific tuning.*

**COMPLETE - 10. The Deterministic Implementation Loop ("Pull the Lever")**
*   **What:** Replace the manual Conductor QA delegation with a single `run-implementation-loop` tool executed in TypeScript.
*   **Why:** The Conductor currently acts as a micromanager, wasting context window and tokens arbitrating routine test failures. LLMs are bad at strictly following SOPs. 
*   **How:** Create a tool that encapsulates the entire build-and-verify cycle (Baseline Check -> Implementor -> Verifier -> Debugger). TypeScript handles the strict state machine of the inner loop, persisting logs to `QA_REPORT.md`, and only returns control to the Conductor when the feature is definitively done or hopelessly blocked.

**COMPLETE - 11. Infinite Reasoning Loop Protection (Reflection Points)**
*   **What:** Introduce a "soft" reflection point when subagents hit a specific message threshold.
*   **Why:** Agents (especially the Debugger) can get "tunnel vision," repeatedly trying the same failing bash command or regex. A hard cut-off (like max iterations) abruptly kills context, whereas a soft reflection point encourages them to pause and gracefully fail.
*   **How:** Use `onAgentStepFinished` to count turns within a subtask. If a threshold (e.g., 15 turns) is reached without calling `report-result`, inject a `ContextUserMessage` prompting the agent to pause, summarize its blockers, and return control to the Conductor.

**12. Model-Specific Tool Use Guidelines**
*   **What:** Dynamically adjust prompts, schemas, and tool availability based on the active LLM.
*   **Why:** Different models (e.g., Claude 3.5 Sonnet vs. Gemini Flash) interpret schemas differently and have varying reasoning capabilities. Some struggle with JSON arrays, others with complex Cypher queries.
*   **How:** In `onAgentStarted`, read `event.model` to inject model-specific caveats into the system prompt. Expand Zod preprocessors (`safeArray`) for schema leniency to catch known hallucinations, and dynamically filter out highly complex tools (like `cbm-query-graph`) for lower-tier "fast" models.
