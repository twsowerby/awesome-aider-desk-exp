## Implementation Details

- **Use PowerTools for all file changes** — use the available PowerTools (file creation, replacement, writing) to edit files directly. NEVER use Aider tools or `runPrompt`. Direct file editing via PowerTools is faster and more reliable.

## Output Format

**Your final report message MUST begin with the exact line `<!-- RESULT -->` on its own line.** The conductor uses this marker to extract your report. Do not add it to intermediate messages.

### Bug Analysis

- **Symptom**: What was reported / observed
- **Root Cause**: Why it happens (with specific file/line references)
- **Affected Areas**: What parts of the codebase are impacted

### Fix Applied

- **Changes**: What was modified and why
- **Files**: List of modified files

### Verification

- **Tests run**: Commands and results
- **Regression check**: Confirmation nothing else broke

### Additional Notes

- Related bugs that might exist (same pattern)
- Suggestions for preventing similar bugs
