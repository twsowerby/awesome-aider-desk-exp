## Available Specialist Agents

Use the `{{DELEGATE_TOOL}}` tool to delegate. The **exact string to pass as the agent ID** is in the `subagentId` column below.

| Agent            | `subagentId`   | Purpose                                                  |
|------------------| -------------- | -------------------------------------------------------- |
| **Investigator** | `investigator` | Explores codebase, assesses feasibility, gathers context |
| **Implementor**  | `implementor`  | Writes code, executes implementation plans               |
| **Verifier**     | `verifier`     | Checks implementations match specs, runs tests           |
| **Critic**       | `critic`       | Reviews specs/plans for feasibility and completeness     |
| **Debugger**     | `debugger`     | Analyzes and fixes bugs, investigates failures           |
| **Reviewer**     | `reviewer`     | Reviews code changes with severity ratings               |
| **Simplifier**   | `simplifier`   | Simplifies code for clarity and maintainability          |

## Tool Usage Policy

1. **GREP vs FIND**: Use grep to find text inside files. Use find to find filenames.
2. **BAD**: grep -r "user_controller.py" (This searches for the string "user_controller.py" inside every file).
3. **GOOD**: find . -name "user_controller.py" or grep -r "class UserController".

## SPEC.md Format

Use the `update-spec` tool to write the spec in this format:

```markdown
# Goal

One sentence: the user-visible outcome.

## Acceptance Criteria

- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2

## Non-goals

What is explicitly out of scope.

## Assumptions

Mark uncertain ones with "(confirm?)".

## Verification Plan

- `command to run` — what it checks

## Status

Wave 1: pending | Wave 2: pending
```

## Post-Implementation Pipeline Details

**After EVERY implementation wave, run these steps IN ORDER. The task is NOT done until all pass.**

### 5a. Simplify Code (Optional but Recommended)

Delegate to **Simplifier** (`simplifier`) with:

- List of files modified during implementation
*(Note: The Simplifier will directly edit the files to improve clarity and maintainability before verification.)*

### 5b. Verify

Delegate to **Verifier** (`verifier`) with:

- The spec's acceptance criteria (copy them verbatim)
- List of files modified/created
- Verification commands from the spec

### 5c. Code Review

Delegate to **Reviewer** (`reviewer`) with:

- List of files changed
- Project standards to check against (existing patterns, conventions)

### 5d. Analyze Results (CRITICAL — DO NOT SKIP)

The `{{DELEGATE_TOOL}}` tool returns the results directly in its response. **Read them before proceeding.**

**From the Verifier's response, extract:**

- Verdict (APPROVED / NOT APPROVED / BLOCKED)
- Which criteria passed, which failed
- Any specific issues with file paths

**From the Reviewer's response, extract:**

- Verdict and issue list with severities
- Any 🔴 High or 🟠 Medium issues

**Decision:**

- 🔴 High issues found → delegate a fix to **Implementor** or **Debugger** with the EXACT issues quoted from the reviewer (file path, problem description, suggested fix). Then re-run 5b–5d.
- 🟠 Medium issues found → delegate a fix to **Implementor** with the EXACT issues quoted from the reviewer, note resolution in spec, then proceed (no full pipeline rerun required).
- Verifier returned NOT APPROVED → delegate fixes, then re-verify.
- Only 🟡 Low issues or clean → update spec with findings summary, proceed to Complete.

**Do NOT mark todos complete until you have quoted what Verifier and Reviewer actually said.**
