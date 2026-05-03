# Goal

Build a Conductor orchestration extension for Pi Coding Harness that provides declarative config-based specialist agents, real-time TUI observability with pause/steer, per-agent tool/MCP scoping, structured response validation, and security safeguards — all following established Pi conventions.

## Acceptance Criteria

- [ ] Agent definitions follow Pi's `.pi/agents/*.md` convention (YAML frontmatter + Markdown body)
- [ ] Extended frontmatter supports: `name`, `description`, `model`, `tools`, `mcp_servers`, `custom_tools`, `output_schema`, `directives`
- [ ] Conductor agent delegates to specialists via a `delegate` tool that spawns child-process subagents
- [ ] Each subagent runs as an isolated `pi --mode json` process with scoped toolset
- [ ] `report-result` tool injected into every subagent with TypeBox schema validation
- [ ] Structured handoff: chain mode with `{previous}` placeholder for pipeline enforcement
- [ ] Real-time TUI dashboard widget shows all running subagents, their status, and current activity
- [ ] Pause/steer: user can pause a running subagent and inject a mid-flight correction message
- [ ] Spec review: conductor creates SPEC.md, presents it, waits for user approval before delegating
- [ ] Security: `tool_call` event interception blocks destructive bash commands (configurable denylist)
- [ ] Security: `tool_call` event interception blocks writes to protected file patterns
- [ ] Security: subagent bash commands require user confirmation for dangerous patterns
- [ ] Post-implementation pipeline (Verify → Review → Analyze) enforced via chain mode
- [ ] Per-agent custom models, MCP servers, and CLI tools configurable in agent .md frontmatter
- [ ] Atomic git commits with LLM-generated messages
- [ ] Todo tracking and spec management as registered tools
- [ ] File mutation queue (`withFileMutationQueue`) used for parallel tool calls to prevent race conditions
- [ ] Extension uses `withSession` pattern to handle context staleness during session replacements

## Non-goals

- Porting the AiderDesk-specific UI (buttons, panels)
- Replacing the existing Conductor extension
- Building MCP server infrastructure (we consume existing MCP servers)
- Building a hard sandbox / containerization (Pi has none; we use event interception)
- Building a custom TUI framework (use pi-tui components)

## Assumptions

- Pi's child-process subagent pattern (from examples/extensions/subagent/) is the stable orchestration model
- Pause/steer requires sending a message to a running subagent's stdin
- The `tool_call` event hook is sufficient for implementing security gates
- `jiti` can load our extension TypeScript directly without a build step

## Extension Identity

- **Name**: pi-code-conductor
- **Source directory**: `pi-extensions/pi-code-conductor/`
- **Entry point**: `pi-extensions/pi-code-conductor/index.ts`

## File Structure

### Extension Source (pi-extensions/pi-code-conductor/)
```
pi-extensions/pi-code-conductor/
├── package.json              ← { "name": "pi-code-conductor", "pi": { "extensions": ["./index.ts"] } }
├── index.ts                  ← Extension entry point: registers tools, events, widgets
├── agents.ts                 ← Agent discovery (loadAgentsFromDir pattern)
├── subagent-process.ts       ← Child process management (spawn, stream, abort)
├── pause-steer.ts            ← Pause/steer/abort controls
├── event-bridge.ts           ← Parse child stdout JSON → forward as session entries
├── agent-dashboard.ts        ← ctx.ui.setWidget TUI dashboard
├── result-capture.ts         ← report-result tool + TypeBox validation
├── spec-manager.ts           ← SPEC.md CRUD tools
├── todo-manager.ts           ← Todo CRUD tools
├── commit-tool.ts            ← Atomic git commit tool
├── security-gate.ts          ← tool_call event handler + security policy loader
├── output-schemas.ts         ← TypeBox schemas for each output_schema type
└── agents/                   ← DEFAULT agent definitions (bundled, overridable by user)
    ├── conductor.md
    ├── investigator.md
    ├── implementor.md
    ├── verifier.md
    ├── reviewer.md
    ├── critic.md
    ├── debugger.md
    └── simplifier.md
```

### User Project Runtime (.pi/ in each project)
```
my-project/.pi/
├── agents/                          ← User's custom/override agent .md files
│   └── my-specialist.md             ← (overrides or extends the bundled defaults)
├── conductor-security.yaml          ← Project-specific security policy
├── settings.json                    ← Pi settings (may include MCP config)
└── extensions/                      ← Project-local extensions
    └── pi-code-conductor/ -> symlink or installed
```

### Global Runtime (~/.pi/agent/)
```
~/.pi/agent/
├── agents/                          ← Global agent overrides
├── extensions/
│   └── pi-code-conductor/           ← Installed extension
└── settings.json
```

### Agent Discovery (two sources, merged)

1. **Bundled defaults**: `pi-extensions/pi-code-conductor/agents/*.md`
2. **User overrides**: `.pi/agents/*.md` (project-local) + `~/.pi/agent/agents/*.md` (global)
3. **Merge rule**: User .md files with same `name` frontmatter override bundled defaults

### Agent .md Format (follows Pi convention)
```markdown
---
name: implementor
description: Executes implementation plans with file editing capabilities
model: claude-sonnet-4-5
tools: read, write, edit, bash, grep, find, ls
mcp_servers:
  - name: github
    command: mcp-server-github
    args: []
custom_tools:
  - name: run-tests
    command: npm test -- --filter={{args}}
    description: Run the project test suite
output_schema: implementation-result
directives:
  - Always commit changes atomically
  - Follow the SPEC.md precisely
---

[Full system prompt as Markdown body]

## Output Format
When finished, call the report-result tool with:
{
  "completed": true,
  "files_changed": ["path/to/file.ts"],
  "summary": "What was done",
  "issues": []
}
```

### Installation Methods

1. **Dev**: `pi -e pi-extensions/pi-code-conductor/index.ts` (instant, no install)
2. **Project-local**: `pi install pi-extensions/pi-code-conductor` (symlinks into .pi/extensions/)
3. **Global**: copy/symlink to `~/.pi/agent/extensions/pi-code-conductor/`

### Extended AgentConfig Interface
```typescript
export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
  // Extended fields:
  mcp_servers?: McpServerConfig[];
  custom_tools?: CustomToolConfig[];
  output_schema?: string;
  directives?: string[];
}
```

### Extension Entry Point
```typescript
// index.ts
export default function(pi: ExtensionAPI) {
  pi.registerTool(delegateTool);
  pi.registerTool(reportResultTool);
  pi.registerTool(specUpdateTool);
  pi.registerTool(specReadTool);
  pi.registerTool(todoSetTool);
  pi.registerTool(todoGetTool);
  pi.registerTool(todoUpdateTool);
  pi.registerTool(pauseAgentTool);
  pi.registerTool(steerAgentTool);
  pi.registerTool(commitTool);
  pi.on("tool_call", securityGate);
  pi.on("session_start", initDashboard);
  pi.registerCommand("/agents", listAgentsCommand);
  pi.registerCommand("/delegate", delegateCommand);
}
```

### Security Architecture (3 layers)

1. **Tool Scoping**: Agent `tools` frontmatter → `--tools` flag limits subagent capabilities
2. **Event Interception**: `pi.on("tool_call", ...)` blocks/confirms before execution
3. **Security Policy**: `.pi/conductor-security.yaml` denylist + confirmlist

```yaml
# .pi/conductor-security.yaml
deny_patterns:
  bash: ["rm -rf /", "rm -rf ~", "git push --force", "git push -f", "drop database"]
  files: [".env", ".env.*", "**/credentials*", "**/secrets*", "**/*.pem", "**/*.key"]
confirm_patterns:
  bash: ["rm ", "git push", "npm publish", "docker *", "sudo *"]
  files: ["package.json", "package-lock.json", "*.lock", ".pi/*"]
```

### Subagent Spawning
```bash
pi --mode json \
   --no-session \
   --append-system-prompt "<system prompt from .md body>" \
   --model <from frontmatter> \
   --tools <from frontmatter> \
   --extension pi-extensions/pi-code-conductor/index.ts
```

### Result Validation
1. `report-result` tool injected into every subagent, TypeBox schema per `output_schema`
2. Subagent calls `report-result({ ... })` as final action
3. TypeBox validates; invalid results flagged with warning
4. Fallback: extract last assistant message as unstructured result
5. Result stored in SubagentRegistry → returned as delegate tool output

### Chain Mode for Pipeline
```
Implementor → {previous} → Verifier → {previous} → Reviewer
```
Conductor remains in loop for analysis between steps.

### TUI Dashboard Widget
```
┌─ Conductor ───────────────────────────────────┐
│ ✅ investigator  DONE     3 tools | 12s        │
│ 🔄 implementor  RUNNING  editing src/auth.ts  │
│ ⏳ verifier      WAITING                        │
│ ⏳ reviewer      WAITING                        │
│                                                │
│ [p] pause  [s] steer  [a] abort  [i] inspect  │
└────────────────────────────────────────────────┘
```

### Pause/Steer Mechanism
1. Pause: Set buffer flag → stop forwarding child stdout events
2. Steer: User types message → write to child process stdin as new user message
3. Resume: Clear buffer → forward accumulated events
4. Keyboard shortcuts from dashboard widget: p=pause, s=steer, a=abort, i=inspect

### Critical Extension Lifecycle Notes
- `withSession`: Use after session replacement to avoid stale context
- `withFileMutationQueue`: Use for file-mutating tools to prevent race conditions
- `session_shutdown`: Clean up child processes, event listeners, dashboard widgets
- Context staleness: Never capture pi/ctx across session boundaries

## Verification Plan

- `pi -e pi-extensions/pi-code-conductor/index.ts` — Extension loads without errors
- Delegate to investigator → child spawns, events stream, result returns
- Dashboard shows agent status in TUI
- Pause/steer a running subagent
- Security gate blocks `rm -rf /`, prompts for `git push`
- Write to `.env` blocked
- Agent with custom model → child uses specified model
- Agent with MCP config → child loads MCP servers
- Spec review flow → conductor presents plan, waits for approval
- Pipeline chain: implementor → verifier → reviewer runs sequentially

## Implementation Waves

### Wave 1: Foundation & Security
- Extension scaffold (package.json, index.ts)
- Agent discovery (agents.ts) — extended AgentConfig, frontmatter parsing
- Subagent process spawning (subagent-process.ts) — based on subagent example
- Basic event streaming from child stdout (event-bridge.ts)
- Security gate (security-gate.ts) — tool_call handler + security policy YAML
- Result capture (result-capture.ts) — report-result tool + TypeBox validation

### Wave 2: Observability & Control
- TUI dashboard widget (agent-dashboard.ts)
- Pause/steer/abort controls (pause-steer.ts)
- Per-agent MCP server setup (temp settings injection)
- Per-agent custom tool generation (temp extension injection)
- Per-agent model configuration

### Wave 3: Conductor Workflow
- All agent system prompts (.md files in agents/)
- Spec management tools (spec-manager.ts)
- Todo management tools (todo-manager.ts)
- Atomic commit tool (commit-tool.ts)
- Chain mode for pipeline enforcement
- Output schemas and validation (output-schemas.ts)

## Status

Wave 1: pending
Wave 2: pending
Wave 3: pending
