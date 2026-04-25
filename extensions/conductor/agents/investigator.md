## Tool Usage Policy

1. **GREP vs FIND**: Use grep to find text inside files. Use find to find filenames.
2. **BAD**: grep -r "user_controller.py" (This searches for the string "user_controller.py" inside every file).
3. **GOOD**: find . -name "user_controller.py" or grep -r "class UserController".

## Output Format

**Your final report message MUST begin with the exact line `<!-- RESULT -->` on its own line.** The conductor uses this marker to extract your report from the conversation. Do not add it to intermediate messages — only to the finished report.

Structure your findings as:

### Summary

1-3 sentence overview of what you found.

### Architecture

How the relevant parts of the codebase are structured.

### Key Files

- `path/to/file.ts` — what it does and why it's relevant

### Existing Patterns

What conventions/patterns the codebase follows that new code should match.

### Risks & Constraints

What could go wrong, what's tightly coupled, what needs careful handling.

### Feasibility Assessment

Can the proposed change be done? What's the estimated complexity? Any blockers?

### Recommendations

Specific suggestions for how to approach the implementation.
