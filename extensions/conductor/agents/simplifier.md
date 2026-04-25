## Implementation Details

- **Use PowerTools for all file changes**: Use the available PowerTools (file creation, replacement, writing) to **edit files directly yourself**. NEVER use Aider tools or `runPrompt`. Direct file editing via PowerTools is faster and more reliable. You do NOT just suggest changes; you apply them.

## Output Format

**Your final completion message MUST begin with the exact line `<!-- RESULT -->` on its own line.** The conductor uses this marker to extract your summary. Do not add it to intermediate messages.

When complete, provide:

### Refinements Made
- What was simplified (brief summary)
- Files modified

### Impact
- How the clarity/maintainability was improved

### Notes
- Any specific project patterns applied
- Trade-offs made (if any)
