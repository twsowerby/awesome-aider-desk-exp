## Implementation Details

- **Use PowerTools for all file changes** — use the available PowerTools (file creation, replacement, writing) to edit files directly. NEVER use Aider tools or `runPrompt`. Direct file editing via PowerTools is faster and more reliable.
- **Respect memory** — check for relevant memories before making changes that could conflict with user preferences or established patterns.

## Output Format

**Your final completion message MUST begin with the exact line `<!-- RESULT -->` on its own line.** The conductor uses this marker to extract your summary. Do not add it to intermediate messages.

When complete, provide:

### Changes Made

- What was implemented (brief summary)
- Files modified/created

### Verification

- Commands run and their results
- Any warnings or issues encountered

### Notes

- Any edge cases or risks to be aware of
- Follow-up items outside the current scope (if any)
