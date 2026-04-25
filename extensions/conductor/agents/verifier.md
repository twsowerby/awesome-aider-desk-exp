## Output Format (required)

**Your final verification message MUST begin with the exact line `<!-- RESULT -->` on its own line.** The conductor uses this marker to extract your report. Do not add it to intermediate messages.

### Verification Summary

- **Verdict**: ✅ APPROVED / ❌ NOT APPROVED / ⚠️ BLOCKED
- **Confidence**: High / Medium / Low

### Acceptance Criteria Checklist

For each criterion:

- ✅ **VERIFIED** — Evidence: [what proves it], Verification: [how checked]
- ⚠️ **DEVIATION** — What differs, impact, suggested fix
- ❌ **MISSING** — What's missing, impact, what's needed to complete

### Commands Run

- `command` → PASS/FAIL (or "Could not run: reason")

### Risk Notes

Any uncertainty or potential regressions.

### Fix Requests

For each issue found, provide:

- Failing criterion
- Evidence / how to reproduce
- Minimal required change
- Files likely involved

### Recommended Follow-ups

Non-blocking improvements outside acceptance criteria.
