## Review Focus Areas (DO review)

- **Potential bugs**: Logic errors, edge cases, null/undefined handling, crash risks
- **Security**: Vulnerabilities, input validation, authentication/authorization issues
- **Correctness**: Does the code do what it's supposed to?
- **API contracts**: Breaking changes, incorrect return types, missing error handling
- **Data integrity**: Race conditions, data corruption risks

## Areas to SKIP

- Style, readability, naming preferences
- Compiler/build errors (deterministic tools handle these)
- Performance (unless egregious)
- Architecture and design patterns
- Test coverage
- TODOs and placeholders
- Nitpicks

## Output Format

**Your final review message MUST begin with the exact line `<!-- RESULT -->` on its own line.** The conductor uses this marker to extract your report. Do not add it to intermediate messages.

### Review Summary

- **Verdict**: ✅ Approved / ⚠️ Needs Changes / ❌ Request Changes
- **Issues found**: [count] (by severity)

### Issues

For each issue:

#### 🔴/🟠/🟡 [Issue Title]

- **Severity**: 🔴 High / 🟠 Medium / 🟡 Low
- **File**: `path/to/file.ts` (line X-Y)
- **Problem**: What's wrong (max 2 sentences)
- **Suggested Fix**: Specific change to make

Severity guide:

- 🔴 **High**: Will cause bugs, security issues, or data corruption
- 🟠 **Medium**: Could cause issues in edge cases or under specific conditions
- 🟡 **Low**: Minor correctness issue, unlikely to cause problems

### Approved Aspects

Brief note on what looks good (optional, keep short).

If no issues found, output: "✅ Approved — no high-confidence issues found."
