# Overriding System Prompts in AiderDesk Extensions

## A Developer Guide for Multi-Agent Orchestrators

This guide explains how to override the AiderDesk system prompt from an extension — specifically, how to build a **generic structural base** that preserves tool availability checks, and inject **per-agent behavioral instructions** on top of it.

This is the pattern you need when building a multi-agent orchestrator where different agents require different personas, workflows, and directives, but all share the same tool infrastructure.

---

## Table of Contents

1. [How the System Prompt is Built](#1-how-the-system-prompt-is-built)
2. [The Two Hooks You Need](#2-the-two-hooks-you-need)
3. [The Architecture: Strip + Inject](#3-the-architecture-strip--inject)
4. [What's in the Template Data](#4-whats-in-the-template-data)
5. [The System Prompt Template Structure](#5-the-system-prompt-template-structure)
6. [Implementation: onPromptTemplate (The Stripper)](#6-implementation-onprompttemplate-the-stripper)
7. [Implementation: onAgentStarted (The Injector)](#7-implementation-onagentstarted-the-injector)
8. [Complete Working Example](#8-complete-working-example)
9. [Critical Rules](#9-critical-rules)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. How the System Prompt is Built

Understanding the rendering pipeline is essential. Here's the exact sequence:

```
1. PromptsManager.getSystemPrompt() is called
   ├── calculateToolPermissions() builds the toolPermissions object
   ├── PromptTemplateData is assembled (OS, date, paths, toolPermissions, etc.)
   ├── PromptsManager.render('workflow', data) is called
   │   ├── Handlebars renders workflow.hbs with data
   │   ├── onPromptTemplate is dispatched (event.name === 'workflow')
   │   └── Returns rendered workflow string
   ├── data.workflow = rendered workflow string
   ├── PromptsManager.render('system-prompt', data) is called
   │   ├── Handlebars renders system-prompt.hbs with data
   │   ├── onPromptTemplate is dispatched (event.name === 'system-prompt')
   │   └── Returns rendered system prompt string
   └── Returns final system prompt

2. Agent.runAgent() is called
   ├── systemPrompt = result from PromptsManager.getSystemPrompt()
   ├── onAgentStarted is dispatched
   │   └── Extensions can modify systemPrompt, agentProfile, etc.
   └── Final systemPrompt is used for the LLM call
```

**Key insight**: `onPromptTemplate` fires **twice** per system prompt — once for `workflow` and once for `system-prompt`. You must check `event.name` to handle each correctly.

---

## 2. The Two Hooks You Need

| Hook | When it fires | What you get | What you can modify | Best for |
|------|--------------|-------------|-------------------|----------|
| `onPromptTemplate` | After Handlebars renders each template | `event.data` (raw template data including `toolPermissions`), `event.prompt` (rendered string) | `event.prompt` | Stripping behavioral sections, re-rendering with custom templates |
| `onAgentStarted` | After system prompt is fully built, before LLM call | `event.agentProfile`, `event.systemPrompt`, `event.contextMessages`, `event.contextFiles` | `event.systemPrompt`, `event.agentProfile`, `event.contextMessages`, `event.contextFiles`, `event.blocked` | Per-agent prompt injection, blocking agents |

---

## 3. The Architecture: Strip + Inject

```
┌─────────────────────────────────────────────────┐
│           DEFAULT SYSTEM PROMPT                  │
│  ┌───────────────────────────────────────────┐  │
│  │ <Objective> ... </Objective>              │  │  ← STRIP in onPromptTemplate
│  │ <Persona> ... </Persona>                  │  │  ← STRIP
│  │ <CoreDirectives> ... </CoreDirectives>    │  │  ← STRIP
│  │ <ToolUsageGuidelines> ... </ToolUsage...> │  │  ← KEEP (structural)
│  │ <SubagentsProtocol> ... </Subagents...>   │  │  ← KEEP (conditional on toolPermissions)
│  │ <TodoManagement> ... </TodoManagement>    │  │  ← KEEP (conditional on toolPermissions)
│  │ <MemoryTools> ... </MemoryTools>          │  │  ← KEEP (conditional on toolPermissions)
│  │ <AiderTools> ... </AiderTools>            │  │  ← KEEP (conditional on toolPermissions)
│  │ <PowerTools> ... </PowerTools>            │  │  ← KEEP (conditional on toolPermissions)
│  │ <ResponseStyle> ... </ResponseStyle>      │  │  ← STRIP
│  │ <RefusalPolicy> ... </RefusalPolicy>      │  │  ← STRIP
│  │ <SystemInformation> ... </SystemInfo>     │  │  ← KEEP (structural)
│  │ <Knowledge> ... </Knowledge>             │  │  ← KEEP (structural, but strip CustomInstructions)
│  │ <Workflow> ... </Workflow>               │  │  ← STRIP (replace with generic or empty)
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │
                        ▼ onAgentStarted
┌─────────────────────────────────────────────────┐
│         PER-AGENT ADDITIONS                      │
│  ┌───────────────────────────────────────────┐  │
│  │ <Objective> Agent-specific objective </Objective>  │
│  │ <Persona> Agent-specific persona </Persona>       │
│  │ <CoreDirectives> Agent-specific directives </...> │
│  │ <Workflow> Agent-specific workflow </Workflow>    │
│  │ <ResponseStyle> Agent-specific style </...>       │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## 4. What's in the Template Data

The `event.data` field in `onPromptTemplate` contains the full `PromptTemplateData` object. This is what the Handlebars template receives. Here's the exact type:

```typescript
interface PromptTemplateData {
  projectDir: string;           // Project root directory
  taskDir: string;              // Task working directory
  additionalInstructions?: string;
  osName: string;               // e.g., "macOS Sequoia"
  currentDate: string;          // e.g., "Fri Apr 24 2026"
  rulesFiles: string;           // Rendered content of AGENTS.md, CONVENTIONS.md, etc.
  customInstructions: string;   // From agentProfile.customInstructions
  toolPermissions: ToolPermissions;  // ← THIS IS WHAT YOU WANT TO PRESERVE
  toolConstants: Record<string, string>;  // Tool group/name constants
  workflow: string;             // Pre-rendered workflow template
  projectGitRootDirectory?: string;
}
```

### The `toolPermissions` Object

This drives all the conditional sections in the template. Its exact shape:

```typescript
interface ToolPermissions {
  aiderTools: boolean;
  powerTools: {
    semanticSearch: boolean;
    fileRead: boolean;
    fileWrite: boolean;
    fileEdit: boolean;
    glob: boolean;
    grep: boolean;
    bash: boolean;
    anyEnabled: boolean;
  };
  todoTools: boolean;
  subagents: boolean;
  memory: {
    enabled: boolean;
    retrieveAllowed: boolean;
    storeAllowed: boolean;
    listAllowed: boolean;
    deleteAllowed: boolean;
  };
  skills: {
    allowed: boolean;
  };
  autoApprove: boolean;
}
```

Every `{{#if toolPermissions.xxx}}` block in the template is driven by this object. If you re-render a custom template with this data, your template will automatically include only the tool sections that the agent actually has access to.

---

## 5. The System Prompt Template Structure

The `system-prompt.hbs` template produces XML-like output. Here's the structural breakdown with annotations:

```xml
<AiderDeskSystemPrompt version="1.0">
  <!-- BEHAVIORAL: Strip and replace per-agent -->
  <Agent name="AiderDesk">
    <Objective>...</Objective>
  </Agent>
  <Persona>...</Persona>
  <CoreDirectives>...</CoreDirectives>

  <!-- STRUCTURAL: Keep — these are tool usage rules, not agent behavior -->
  <ToolUsageGuidelines>...</ToolUsageGuidelines>

  <!-- STRUCTURAL: Keep — conditional on toolPermissions.subagents -->
  <SubagentsProtocol enabled="true">...</SubagentsProtocol>

  <!-- STRUCTURAL: Keep — conditional on toolPermissions.todoTools -->
  <TodoManagement enabled="true">...</TodoManagement>

  <!-- STRUCTURAL: Keep — conditional on toolPermissions.memory.enabled -->
  <MemoryTools>...</MemoryTools>

  <!-- STRUCTURAL: Keep — conditional on toolPermissions.aiderTools -->
  <AiderTools>...</AiderTools>

  <!-- STRUCTURAL: Keep — conditional on toolPermissions.powerTools.anyEnabled -->
  <PowerTools>...</PowerTools>

  <!-- BEHAVIORAL: Strip and replace per-agent -->
  <ResponseStyle>...</ResponseStyle>
  <RefusalPolicy>...</RefusalPolicy>

  <!-- STRUCTURAL: Keep — system info the agent needs -->
  <SystemInformation>...</SystemInformation>

  <!-- STRUCTURAL: Keep — but strip <CustomInstructions> sub-section -->
  <Knowledge>
    <Rules>{{{rulesFiles}}}</Rules>
    <CustomInstructions>{{{cdata customInstructions}}}</CustomInstructions>
  </Knowledge>

  <!-- BEHAVIORAL: Strip and replace per-agent -->
  {{{workflow}}}
</AiderDeskSystemPrompt>
```

---

## 6. Implementation: onPromptTemplate (The Stripper)

This hook strips behavioral sections from the rendered prompt, leaving only the structural base.

### Strategy: Regex-based XML section removal

Since the prompt is a rendered string (not a template), you use regex to remove specific XML sections:

```typescript
import type { Extension, ExtensionContext, PromptTemplateEvent } from '@aiderdesk/extensions';

// Sections to REMOVE from the system prompt (behavioral, agent-specific)
const BEHAVIORAL_SECTIONS = [
  'Objective',
  'Persona',
  'CoreDirectives',
  'ResponseStyle',
  'RefusalPolicy',
  'CustomInstructions',
];

// The parent tags that wrap behavioral sections
const BEHAVIORAL_PARENTS = ['Agent'];

function stripSection(prompt: string, tagName: string): string {
  // Match self-closing or open/close tags with content (including attributes)
  const regex = new RegExp(
    `\\s*<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>\\s*`,
    'g'
  );
  return prompt.replace(regex, '\n');
}

function stripSelfClosingSection(prompt: string, tagName: string): string {
  const regex = new RegExp(`\\s*<${tagName}(?:\\s[^>]*)?\\s*\\/?>\\s*`, 'g');
  return prompt.replace(regex, '\n');
}

export class PromptOverrideExtension implements Extension {
  static metadata = {
    name: 'prompt-override',
    version: '1.0.0',
    description: 'Strips behavioral sections from system prompt for per-agent injection',
    author: 'your-team',
  };

  async onPromptTemplate(
    event: PromptTemplateEvent,
    context: ExtensionContext
  ): Promise<void | Partial<PromptTemplateEvent>> {
    // Handle the workflow template — replace with empty/minimal workflow
    if (event.name === 'workflow') {
      return {
        prompt: '',  // Strip the default workflow entirely
      };
    }

    // Handle the system-prompt template
    if (event.name === 'system-prompt') {
      let prompt = event.prompt;

      // Strip behavioral parent sections (like <Agent>)
      for (const parent of BEHAVIORAL_PARENTS) {
        prompt = stripSection(prompt, parent);
      }

      // Strip individual behavioral sections
      for (const section of BEHAVIORAL_SECTIONS) {
        prompt = stripSection(prompt, section);
      }

      // Strip the workflow injection point ({{{workflow}}} renders as raw XML)
      // The workflow content is already handled above, but the injection
      // point in the system prompt may leave empty whitespace
      prompt = prompt.replace(/\s*<Workflow>[\s\S]*?<\/Workflow>\s*/g, '\n');

      // Clean up excessive blank lines
      prompt = prompt.replace(/\n{3,}/g, '\n\n');

      return { prompt };
    }
  }
}
```

### Important: The `event.data` is available

If you want to **re-render** a custom template instead of regex-stripping, you have access to the full template data:

```typescript
async onPromptTemplate(
  event: PromptTemplateEvent,
  context: ExtensionContext
): Promise<void | Partial<PromptTemplateEvent>> {
  if (event.name === 'system-prompt') {
    // Access the template data
    const data = event.data as PromptTemplateData;

    // You can use toolPermissions to build conditional sections
    if (data.toolPermissions.todoTools) {
      // Include todo management instructions
    }

    // You can use toolConstants for correct tool names
    const todoToolName = data.toolConstants.TODO_TOOL_GET_ITEMS;

    // Re-render with your own Handlebars instance
    // (you'd need to import Handlebars in your extension)
    const customPrompt = myCustomTemplate(data);
    return { prompt: customPrompt };
  }
}
```

**However**, the regex-stripping approach is simpler and doesn't require bundling Handlebars in your extension. The structural sections are already correctly rendered by the default template — you just need to remove the behavioral ones.

---

## Accessing the Agent ID in `onPromptTemplate`

The `PromptTemplateEvent` does not contain the agent profile directly. However, you can access it through the `ExtensionContext` — the task is always available when rendering `system-prompt` or `workflow`.

```typescript
async onPromptTemplate(
  event: PromptTemplateEvent,
  context: ExtensionContext
): Promise<void | Partial<PromptTemplateEvent>> {
  const taskContext = context.getTaskContext();  // TaskContext | null (sync)
  if (taskContext) {
    const agentProfile = await taskContext.getTaskAgentProfile();  // async — returns AgentProfile | null
    const agentId = agentProfile?.id;  // e.g., "conductor", "investigator", "implementor"
  }
}
```

### Why this works

When `PromptsManager.getSystemPrompt()` is called, it passes the `Task` object through to `render()`, which passes it to `dispatchEvent()`. The `ExtensionManager` then creates an `ExtensionContextImpl` with that task, so `getTaskContext()` will return a valid `TaskContext` (not null) for both the `workflow` and `system-prompt` template renders.

### When to use this

This is useful if you want to do **per-agent stripping** in `onPromptTemplate` — for example, stripping different sections for different agents, or only stripping for specific agents while leaving the default prompt intact for others:

```typescript
async onPromptTemplate(
  event: PromptTemplateEvent,
  context: ExtensionContext
): Promise<void | Partial<PromptTemplateEvent>> {
  if (event.name === 'system-prompt') {
    const taskContext = context.getTaskContext();
    const agentProfile = taskContext ? await taskContext.getTaskAgentProfile() : null;
    const agentId = agentProfile?.id;

    // Only strip for agents in our orchestrator; leave default agents untouched
    if (agentId && AGENT_CONFIGS[agentId]) {
      let prompt = event.prompt;
      for (const section of BEHAVIORAL_SECTIONS) {
        prompt = stripXmlSection(prompt, section);
      }
      return { prompt };
    }
  }

  if (event.name === 'workflow') {
    const taskContext = context.getTaskContext();
    const agentProfile = taskContext ? await taskContext.getTaskAgentProfile() : null;
    const agentId = agentProfile?.id;

    if (agentId && AGENT_CONFIGS[agentId]) {
      return { prompt: '' };
    }
  }
}
```

### API reference

| Method | Returns | Async? | Notes |
|--------|---------|--------|-------|
| `context.getTaskContext()` | `TaskContext \| null` | No | Returns `null` if no task is active (should not happen for `system-prompt` renders) |
| `taskContext.getTaskAgentProfile()` | `Promise<AgentProfile \| null>` | **Yes** | Must be `await`ed. Returns `null` if no profile is assigned |
| `agentProfile.id` | `string` | No | The agent profile ID (e.g., `"conductor"`, `"pirate"`) |

### ⚠️ Important

- `getTaskAgentProfile()` is **async**. Since `onPromptTemplate` is awaited by the `ExtensionManager`, using `await` inside it is safe and will not break the dispatch chain.
- The `TaskContext` is only available when a task is active. For template renders outside of a task context (e.g., `commit-message` rendered independently), `getTaskContext()` may return `null`. Always null-check.

---

## 7. Implementation: onAgentStarted (The Injector)

This is where you inject per-agent instructions. The `AgentStartedEvent` gives you the full `agentProfile`, so you can customize per agent.

```typescript
import type {
  Extension,
  ExtensionContext,
  AgentStartedEvent,
  AgentProfile,
} from '@aiderdesk/extensions';

// Define per-agent prompt additions
interface AgentPromptConfig {
  objective: string;
  persona: string[];
  coreDirectives: { id: string; text: string }[];
  responseStyle: { id: string; text: string }[];
  workflow: string;
  refusalPolicy?: string;
}

const AGENT_CONFIGS: Record<string, AgentPromptConfig> = {
  'conductor': {
    objective: 'You are the Conductor — you plan, delegate, and verify. You NEVER edit files directly.',
    persona: [
      'Act as a meticulous project manager and architect.',
      'Be decisive in delegation but thorough in verification.',
      'Maintain a helpful and proactive demeanor.',
    ],
    coreDirectives: [
      { id: 'delegate-first', text: 'Gather context by delegating to the Investigator. Their output satisfies this requirement.' },
      { id: 'spec-first', text: 'Create/update the SPEC.md BEFORE any delegation.' },
      { id: 'wait-for-approval', text: 'Present the plan and STOP. Wait for user approval before delegating implementation tasks.' },
    ],
    responseStyle: [
      { id: 'conciseness', text: 'Keep responses brief. Use one-word confirmations like "Done" after successful actions.' },
    ],
    workflow: `<Workflow>
  <Step number="1" title="Understand">Clarify the user's request. Delegate to the Investigator if needed.</Step>
  <Step number="2" title="Plan">Write the spec. Present and wait for approval.</Step>
  <Step number="3" title="Delegate">Use delegate-to-agent for each implementation task.</Step>
  <Step number="4" title="Verify">Delegate to Verifier, then Reviewer.</Step>
  <Step number="5" title="Complete">Update spec with final status. Summarize to user.</Step>
</Workflow>`,
    refusalPolicy: 'When unable to comply, state inability clearly and offer alternatives.',
  },

  'investigator': {
    objective: 'You are the Investigator — you explore, analyze, and report. You NEVER edit files.',
    persona: [
      'Act as a thorough code analyst and researcher.',
      'Be exhaustive in your investigation.',
      'Report findings with exact code snippets and file paths.',
    ],
    coreDirectives: [
      { id: 'no-edits', text: 'You NEVER edit files directly. You only read and analyze.' },
      { id: 'exact-code', text: 'Always include exact code snippets, type definitions, and file paths in your reports.' },
    ],
    responseStyle: [
      { id: 'detail', text: 'Provide full detail with code snippets. Do not summarize.' },
    ],
    workflow: `<Workflow>
  <Step number="1" title="Search">Use grep, glob, and file read tools to find relevant code.</Step>
  <Step number="2" title="Analyze">Read and understand the code structure and patterns.</Step>
  <Step number="3" title="Report">Report findings with exact code, types, and file paths.</Step>
</Workflow>`,
  },

  'implementor': {
    objective: 'You are the Implementor — you write code and execute implementation plans.',
    persona: [
      'Act as an expert, detail-oriented software engineer.',
      'Follow established project patterns and conventions.',
      'Be cautious with code changes — understand before modifying.',
    ],
    coreDirectives: [
      { id: 'patterns', text: 'Follow established project patterns, code style, and conventions.' },
      { id: 'security-first', text: 'Never introduce code that exposes secrets or compromises security.' },
    ],
    responseStyle: [
      { id: 'conciseness', text: 'Keep responses brief. Confirm actions with one word.' },
    ],
    workflow: `<Workflow>
  <Step number="1" title="Understand">Read the task description and identify all files to modify.</Step>
  <Step number="2" title="Implement">Make the planned changes using appropriate tools.</Step>
  <Step number="3" title="Verify">Run type checks and tests to verify changes.</Step>
</Workflow>`,
  },
};

function buildAgentPrompt(profile: AgentProfile): string {
  const config = AGENT_CONFIGS[profile.id];
  if (!config) {
    return '';  // No custom prompt for unknown agents
  }

  const sections: string[] = [];

  // Objective
  sections.push(`  <Objective>${config.objective}</Objective>`);

  // Persona
  const traits = config.persona.map(t => `    <Trait>${t}</Trait>`).join('\n');
  sections.push(`  <Persona>\n${traits}\n  </Persona>`);

  // Core Directives
  const directives = config.coreDirectives
    .map(d => `    <Directive id="${d.id}">${d.text}</Directive>`)
    .join('\n');
  sections.push(`  <CoreDirectives>\n${directives}\n  </CoreDirectives>`);

  // Workflow
  sections.push(config.workflow);

  // Response Style
  const styles = config.responseStyle
    .map(s => `    <Rule id="${s.id}">${s.text}</Rule>`)
    .join('\n');
  sections.push(`  <ResponseStyle>\n${styles}\n  </ResponseStyle>`);

  // Refusal Policy
  if (config.refusalPolicy) {
    sections.push(`  <RefusalPolicy>\n    <Rule>${config.refusalPolicy}</Rule>\n  </RefusalPolicy>`);
  }

  return '\n\n' + sections.join('\n\n');
}

export class AgentPromptExtension implements Extension {
  static metadata = {
    name: 'agent-prompts',
    version: '1.0.0',
    description: 'Injects per-agent behavioral instructions into the system prompt',
    author: 'your-team',
  };

  async onAgentStarted(
    event: AgentStartedEvent,
    context: ExtensionContext
  ): Promise<void | Partial<AgentStartedEvent>> {
    const agentPrompt = buildAgentPrompt(event.agentProfile);

    if (!agentPrompt) {
      return;  // No custom prompt for this agent
    }

    // Append the agent-specific prompt to the stripped base
    // Insert before the closing </AiderDeskSystemPrompt> tag
    const basePrompt = event.systemPrompt ?? '';
    const closingTag = '</AiderDeskSystemPrompt>';
    const insertIndex = basePrompt.lastIndexOf(closingTag);

    let newPrompt: string;
    if (insertIndex !== -1) {
      newPrompt =
        basePrompt.slice(0, insertIndex) +
        agentPrompt + '\n' +
        basePrompt.slice(insertIndex);
    } else {
      // Fallback: just append
      newPrompt = basePrompt + agentPrompt;
    }

    context.log(
      `Injected custom prompt for agent: ${event.agentProfile.id}`,
      'info'
    );

    return { systemPrompt: newPrompt };
  }
}
```

---

## 8. Complete Working Example

Combine both hooks into a single extension:

```typescript
import type {
  Extension,
  ExtensionContext,
  PromptTemplateEvent,
  AgentStartedEvent,
  AgentProfile,
  ExtensionMetadata,
} from '@aiderdesk/extensions';

// ─── Configuration ───────────────────────────────────────────────

const BEHAVIORAL_SECTIONS = [
  'Objective', 'Persona', 'CoreDirectives',
  'ResponseStyle', 'RefusalPolicy', 'CustomInstructions',
];
const BEHAVIORAL_PARENTS = ['Agent'];

// Define your per-agent prompts here (see Section 7 for full example)
const AGENT_CONFIGS: Record<string, AgentPromptConfig> = {
  // ... your agent configs
};

// ─── Helpers ─────────────────────────────────────────────────────

function stripXmlSection(prompt: string, tagName: string): string {
  const regex = new RegExp(
    `\\s*<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>\\s*`,
    'g'
  );
  return prompt.replace(regex, '\n');
}

function buildAgentPrompt(profile: AgentProfile): string {
  const config = AGENT_CONFIGS[profile.id];
  if (!config) return '';
  // ... build prompt from config (see Section 7)
  return '';
}

// ─── Extension ───────────────────────────────────────────────────

export default class MultiAgentPromptExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: 'multi-agent-prompts',
    version: '1.0.0',
    description: 'Generic structural base + per-agent behavioral injection',
    author: 'your-team',
    capabilities: ['agents'],
  };

  async onLoad(context: ExtensionContext): Promise<void> {
    context.log('Multi-agent prompt extension loaded', 'info');
  }

  // ── Hook 1: Strip behavioral sections from the rendered prompt ──

  async onPromptTemplate(
    event: PromptTemplateEvent,
    context: ExtensionContext
  ): Promise<void | Partial<PromptTemplateEvent>> {
    // Strip the default workflow
    if (event.name === 'workflow') {
      return { prompt: '' };
    }

    // Strip behavioral sections from the system prompt
    if (event.name === 'system-prompt') {
      let prompt = event.prompt;

      // Remove behavioral parent sections
      for (const parent of BEHAVIORAL_PARENTS) {
        prompt = stripXmlSection(prompt, parent);
      }

      // Remove individual behavioral sections
      for (const section of BEHAVIORAL_SECTIONS) {
        prompt = stripXmlSection(prompt, section);
      }

      // Remove the rendered workflow block
      prompt = prompt.replace(
        /\s*<Workflow>[\s\S]*?<\/Workflow>\s*/g,
        '\n'
      );

      // Clean up blank lines
      prompt = prompt.replace(/\n{3,}/g, '\n\n');

      return { prompt };
    }
  }

  // ── Hook 2: Inject per-agent behavioral instructions ──

  async onAgentStarted(
    event: AgentStartedEvent,
    context: ExtensionContext
  ): Promise<void | Partial<AgentStartedEvent>> {
    const agentPrompt = buildAgentPrompt(event.agentProfile);
    if (!agentPrompt) return;

    const basePrompt = event.systemPrompt ?? '';
    const closingTag = '</AiderDeskSystemPrompt>';
    const insertIndex = basePrompt.lastIndexOf(closingTag);

    let newPrompt: string;
    if (insertIndex !== -1) {
      newPrompt =
        basePrompt.slice(0, insertIndex) +
        agentPrompt + '\n' +
        basePrompt.slice(insertIndex);
    } else {
      newPrompt = basePrompt + agentPrompt;
    }

    context.log(
      `Injected prompt for agent: ${event.agentProfile.id}`,
      'info'
    );

    return { systemPrompt: newPrompt };
  }
}
```

---

## 9. Critical Rules

### You MUST return a partial object, not just mutate

The `dispatchEvent` method in `ExtensionManager` uses a waterfall pattern:

```typescript
let currentEvent = { ...event };  // Shallow copy ONCE at the start

for (const extension of sortedExtensions) {
  const result = await handler.call(instance, currentEvent, context);

  if (result && typeof result === 'object') {
    currentEvent = { ...currentEvent, ...result };  // MERGE on return
  }
}
return currentEvent;
```

**What this means:**

- ✅ **Returning a partial works**: `return { prompt: 'new' }` — the merge overwrites the field
- ⚠️ **Direct mutation also works** (because `currentEvent` is passed by reference), but it's fragile and not the intended pattern
- ❌ **Returning `undefined` or `void`** means your changes are NOT merged — but if you mutated `currentEvent` directly, the mutation persists because it's the same object reference

**Best practice**: Always return a partial object. This is explicit, safe, and won't break if the dispatch mechanism changes.

```typescript
// ✅ GOOD — return a partial
async onPromptTemplate(event, context) {
  return { prompt: event.prompt + ' extra' };
}

// ❌ BAD — relying on mutation (fragile, not the intended pattern)
async onPromptTemplate(event, context) {
  event.prompt = event.prompt + ' extra';
  // No return — mutation persists by reference but is not guaranteed
}
```

### You MUST check `event.name` in `onPromptTemplate`

The hook fires for **every** template render, not just `system-prompt`. Available template names:

| Template Name | Purpose |
|--------------|---------|
| `system-prompt` | Main agent system prompt |
| `workflow` | Step-by-step workflow instructions |
| `init-project` | Project initialization prompt |
| `compact-conversation` | Conversation compaction |
| `commit-message` | Git commit message generation |
| `task-name` | Task name generation |
| `conflict-resolution` | Conflict resolution |
| `conflict-resolution-system` | Conflict resolution system prompt |
| `update-task-state` | Task state update |
| `handoff` | Task handoff |
| `code-inline-request` | Inline code request |

If you don't check `event.name`, you'll accidentally modify other templates.

### Extension execution order matters

Extensions are executed in order: **Global extensions first, then Project extensions**. If multiple extensions modify the same event, the last one to return a partial wins (because of the merge: `{ ...currentEvent, ...partialEvent }`).

### `event.data` is typed as `unknown`

The `PromptTemplateEvent.data` field is typed as `unknown`. To access the template data with types, cast it:

```typescript
const data = event.data as PromptTemplateData;
```

The actual shape is `PromptTemplateData` (defined in `src/main/prompts/types.ts`), but this type is not exported to extensions. You may need to define the interface yourself or use `as any` for deep access.

### Getting the agent profile in `onPromptTemplate`

`PromptTemplateEvent` does not include the `AgentProfile`. If you need to know which agent is running inside `onPromptTemplate`, use the `ExtensionContext`:

```typescript
async onPromptTemplate(event: PromptTemplateEvent, context: ExtensionContext) {
  const taskContext = context.getTaskContext();
  if (taskContext) {
    const profile = await taskContext.getTaskAgentProfile();
    // profile is AgentProfile | null
    // NOTE: This is async! But onPromptTemplate is awaited, so it works.
  }
}
```

**However**, for the strip+inject pattern, you don't need the agent profile in `onPromptTemplate` — you strip the same sections regardless of which agent is running, and inject per-agent content in `onAgentStarted` where the profile is directly available.

### The `workflow` template is rendered separately

The workflow is rendered first as its own template, then its output is injected into the system prompt via `{{{workflow}}}`. This means:

1. `onPromptTemplate` fires for `workflow` first
2. Then it fires for `system-prompt` (with the workflow output already embedded)
3. If you strip the workflow in step 1, the system prompt in step 2 will have an empty workflow section
4. You should still clean up the empty `<Workflow></Workflow>` tags in step 2

---

## 10. Troubleshooting

### The agent doesn't use tools correctly

**Cause**: You stripped too much. The `<ToolUsageGuidelines>`, `<TodoManagement>`, `<MemoryTools>`, `<AiderTools>`, `<PowerTools>`, and `<SubagentsProtocol>` sections contain the instructions that tell the LLM how to use each tool. If you remove these, the agent won't know how to call tools correctly.

**Fix**: Only strip the behavioral sections listed in the example. Keep all tool-related sections.

### The agent ignores my custom instructions

**Cause**: Your injected prompt may be outside the `<AiderDeskSystemPrompt>` root tag, or the XML structure may be malformed.

**Fix**: Insert your content **before** the closing `</AiderDeskSystemPrompt>` tag (as shown in the example). Ensure your XML is well-formed.

### Multiple extensions conflict

**Cause**: If another extension also modifies `systemPrompt` in `onAgentStarted`, the last one to execute wins.

**Fix**: Consider appending rather than replacing. Use `event.systemPrompt + yourAddition` instead of overwriting.

### The `event.data` cast fails

**Cause**: The `PromptTemplateData` type is not exported to extensions.

**Fix**: Define the interface yourself in your extension, or access fields with bracket notation:

```typescript
const data = event.data as Record<string, unknown>;
const toolPerms = data.toolPermissions as Record<string, unknown>;
```

### Custom instructions appear twice

**Cause**: The default template includes `{{#if customInstructions}}<CustomInstructions>...</CustomInstructions>{{/if}}`. If you inject custom instructions via `onAgentStarted` but don't strip the `<CustomInstructions>` section in `onPromptTemplate`, they'll appear twice.

**Fix**: Add `CustomInstructions` to your `BEHAVIORAL_SECTIONS` list (it's already included in the example).

---

## Quick Reference: Event Handler Signatures

```typescript
// Strip behavioral sections from rendered templates
onPromptTemplate(
  event: PromptTemplateEvent,   // { name: string, data: unknown, prompt: string }
  context: ExtensionContext
): Promise<void | Partial<PromptTemplateEvent>>
// Return: { prompt: modifiedString }

// Inject per-agent instructions before LLM call
onAgentStarted(
  event: AgentStartedEvent,     // { agentProfile, systemPrompt, contextMessages, ... }
  context: ExtensionContext
): Promise<void | Partial<AgentStartedEvent>>
// Return: { systemPrompt: modifiedString }
```

## Quick Reference: What to Keep vs Strip

| Section | Keep? | Reason |
|---------|-------|--------|
| `<Agent><Objective>` | ❌ Strip | Agent-specific purpose |
| `<Persona>` | ❌ Strip | Agent-specific behavior |
| `<CoreDirectives>` | ❌ Strip | Agent-specific rules |
| `<ToolUsageGuidelines>` | ✅ Keep | Structural — how to use tools |
| `<SubagentsProtocol>` | ✅ Keep | Conditional on `toolPermissions.subagents` |
| `<TodoManagement>` | ✅ Keep | Conditional on `toolPermissions.todoTools` |
| `<MemoryTools>` | ✅ Keep | Conditional on `toolPermissions.memory.enabled` |
| `<AiderTools>` | ✅ Keep | Conditional on `toolPermissions.aiderTools` |
| `<PowerTools>` | ✅ Keep | Conditional on `toolPermissions.powerTools.anyEnabled` |
| `<ResponseStyle>` | ❌ Strip | Agent-specific output format |
| `<RefusalPolicy>` | ❌ Strip | Agent-specific refusal behavior |
| `<SystemInformation>` | ✅ Keep | Structural — OS, date, paths |
| `<Knowledge><Rules>` | ✅ Keep | Structural — AGENTS.md, CONVENTIONS.md |
| `<Knowledge><CustomInstructions>` | ❌ Strip | Agent-specific instructions |
| `<Workflow>` (from `{{{workflow}}}`) | ❌ Strip | Agent-specific workflow steps |