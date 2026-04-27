## Skills in Extensions

### How Skills Work

Skills are markdown instruction files that agents load into their context **on demand** via a tool call. They are never pre-loaded into the system prompt.

**Before activation**, the agent only sees skill names and descriptions — listed in the `skills---activate_skill` tool description:

```xml
<available_skills>
<skill>
<name>product-marketing-context</name>
<description>Guides the agent through discovering and documenting product marketing context</description>
<location>project</location>
</skill>
</available_skills>
```

The agent does **not** see the SKILL.md content at this point. It only knows the skill exists and what it's for.

**When the agent decides to activate**, it calls:

```json
{ "skill": "product-marketing-context" }
```

The `execute` function reads the full `SKILL.md` file from disk and returns it as a **tool result message** — a standard string return, just like any other tool output. The agent sees the full skill content in its next iteration.

**After activation**, the skill content lives in the conversation history as a tool result. During conversation compaction, `findSkillActivationMessages` in `task.ts` preserves the most recent activation of each skill, so the instructions survive context window trimming.

| | System Prompt | Skill Content |
|---|---|---|
| When loaded | At agent start | On demand, when agent calls the tool |
| Where it lives | `systemPrompt` parameter | Conversation history (tool result message) |
| Who decides | Always present | Agent decides based on task |
| Persistence | Always in context | Preserved during compaction |
| User approval | N/A | Goes through tool approval flow |

### Skill File Format

Each skill is a directory containing a `SKILL.md` file with YAML front-matter:

```
my-skill/
  └── SKILL.md
```

```markdown
---
name: my-skill
description: Brief description shown to the agent when choosing which skill to activate
---

# My Skill

Detailed instructions that get injected into the agent's context
when this skill is activated...
```

Only two front-matter fields are required: `name` and `description`. The rest of the file is free-form markdown that becomes the skill's instructions.

### Skill Discovery Locations

Skills are discovered by scanning directories. Priority order (first match wins by name):

| Location | Path | Scope |
|----------|------|-------|
| Project | `.aider-desk/skills/` | Current project only |
| Global | `~/.aider-desk/skills/` | All projects |
| Builtin | `resources/skills/` (app bundle) | All projects, shipped with AiderDesk |

A project-level skill with the same `name` as a global or builtin skill will shadow it.

### The Extension API Gap

The `Extension` interface has no `getSkills()` method, no `onSkillActivated` event, and no way to register virtual skills programmatically. Skills are a **file-system-based** mechanism.

However, extensions run in the main process with full Node.js access, so they can write skill files to the project directory during `onLoad`, making them discoverable by the standard skills system.

---

## Bundling Skills with Extensions

### The Problem

You want to ship an extension (e.g., "Tilly") that includes skills (e.g., `product-marketing-context`), without requiring the user to install the extension and the skills separately.

### The Solution: Write Skills During `onLoad`

Bundle your `SKILL.md` files as string constants within the extension, and write them to the project's `.aider-desk/skills/` directory when the extension loads. The skills system will discover them when the `skills---activate_skill` tool is created for the next agent session.

```typescript
import fs from 'fs/promises';
import path from 'path';
import type {
  Extension,
  ExtensionContext,
  ExtensionMetadata,
  AgentProfile,
  AgentStartedEvent,
  ToolCalledEvent,
} from '@aiderdesk/extensions';

// ─── Bundled Skill Definitions ──────────────────────────────────

// Each skill is a name + content pair. The content is the full SKILL.md
// including YAML front-matter.
const BUNDLED_SKILLS: Record<string, string> = {
  'product-marketing-context': `---
name: product-marketing-context
description: Guides the agent through discovering and documenting product marketing context. Use when marketing context documents are missing from the project.
---

# Product Marketing Context Skill

When this skill is activated, you must check for the following marketing context
documents in the project. If any are missing, create them by interviewing the user:

1. **target-audience.md** — Who are we marketing to? Demographics, psychographics, pain points.
2. **value-proposition.md** — What unique value does the product offer? Key differentiators.
3. **messaging-framework.md** — Core messages, taglines, tone of voice guidelines.
4. **competitive-landscape.md** — Who are the competitors? Positioning analysis.

## Workflow

1. Check the project directory for existing marketing context documents
2. For each missing document, ask the user targeted questions
3. Synthesize their answers into a structured markdown document
4. Save each document in the project's \`marketing/\` directory
5. Confirm completion and summarize what was created
`,
  'content-brief': `---
name: content-brief
description: Creates a structured content brief for marketing assets. Use when the user needs a blog post, landing page, email campaign, or similar content.
---

# Content Brief Skill

When this skill is activated, create a content brief by gathering the following:

1. **Objective** — What should this content achieve?
2. **Audience** — Which segment from target-audience.md?
3. **Key Message** — From messaging-framework.md
4. **CTA** — What action should the reader take?
5. **SEO Keywords** — If applicable
6. **Tone** — From messaging-framework.md tone guidelines
7. **Format** — Blog post, email, landing page, social, etc.
8. **Length** — Word count or format constraints

## Output

Produce a structured brief document and save it to the project.
`,
};

// ─── Extension ───────────────────────────────────────────────────

const AIDER_DESK_DIR = '.aider-desk';
const SKILLS_DIR_NAME = 'skills';
const SKILL_NAMESPACE = 'tilly';  // Prefix to avoid collisions with user skills

export default class TillyExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: 'tilly',
    version: '1.0.0',
    description: 'Marketing specialist with bundled skills',
    author: 'your-team',
    capabilities: ['agents'],
  };

  // ── Lifecycle: Write bundled skills to project dir ──

  async onLoad(context: ExtensionContext): Promise<void> {
    const projectDir = context.getProjectDir();
    const skillsDir = path.join(projectDir, AIDER_DESK_DIR, SKILLS_DIR_NAME);

    await fs.mkdir(skillsDir, { recursive: true });

    for (const [skillName, content] of Object.entries(BUNDLED_SKILLS)) {
      const namespacedName = `${SKILL_NAMESPACE}-${skillName}`;
      const skillDir = path.join(skillsDir, namespacedName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        content.replace(`name: ${skillName}`, `name: ${namespacedName}`)
      );
    }

    context.log('Tilly: Bundled skills installed', 'info');
  }

  // ── Agents: Register Tilly ──

  getAgents(_context: ExtensionContext): AgentProfile[] {
    return [
      {
        id: 'tilly',
        name: 'Tilly',
        provider: 'openai',
        model: 'gpt-4o',
        maxIterations: 50,
        minTimeBetweenToolCalls: 0,
        toolApprovals: {
          'power---file_read': 1,    // ToolApprovalState.Always
          'power---file_write': 1,
          'power---glob': 1,
          'power---grep': 1,
          'skills---activate_skill': 1,
          'memory---store_memory': 1,
          'memory---retrieve_memory': 1,
        },
        toolSettings: {},
        includeContextFiles: false,
        includeRepoMap: false,
        usePowerTools: true,
        useAiderTools: false,
        useTodoTools: true,
        useSubagents: true,
        useTaskTools: false,
        useMemoryTools: true,
        useSkillsTools: true,   // ← Required for skills---activate_skill
        useExtensionTools: false,
        customInstructions: `You are Tilly, a marketing specialist.

WORKFLOW:
1. When asked to do something, FIRST check the project for marketing context documents
   (look in the marketing/ directory for: target-audience.md, value-proposition.md,
   messaging-framework.md, competitive-landscape.md)
2. If ANY of these documents are missing, immediately activate the
   tilly-product-marketing-context skill using the skills tool
3. Once context is established, proceed with the marketing task
4. For content creation tasks, activate the tilly-content-brief skill

Always check for context BEFORE starting any marketing work.`,
        enabledServers: [],
        subagent: {
          enabled: true,
          systemPrompt: 'You are a marketing subagent working under Tilly.',
          invocationMode: 'on-demand' as any,
          color: '#E91E63',
          description: 'Marketing specialist — creates content, briefs, and marketing strategy',
          contextMemory: 'off' as any,
        },
        ruleFiles: [],
      },
    ];
  }

  // ── Optional: Detect when Tilly activates a skill ──

  async onToolCalled(
    event: ToolCalledEvent,
    context: ExtensionContext
  ): Promise<void | Partial<ToolCalledEvent>> {
    if (event.toolName === 'skills---activate_skill') {
      const skillName = event.input?.skill as string;
      if (skillName?.startsWith('tilly-')) {
        context.log(`Tilly activated skill: ${skillName}`, 'info');
      }
    }
  }
}
```

### How This Works End-to-End

```
1. Extension loads (onLoad)
   └── Writes tilly-product-marketing-context/SKILL.md to .aider-desk/skills/
   └── Writes tilly-content-brief/SKILL.md to .aider-desk/skills/

2. User selects Tilly agent and gives a task
   └── Agent starts → skills---activate_skill tool description now includes
       the bundled skills (discovered from .aider-desk/skills/)
   └── Tilly sees skill names + descriptions in the tool description
   └── Tilly does NOT see the SKILL.md content yet

3. Tilly reads her custom instructions
   └── "FIRST check for marketing context documents"
   └── Tilly uses power---glob and power---file_read to check
   └── Documents are missing → Tilly calls skills---activate_skill
       with skill: "tilly-product-marketing-context"

4. Skills tool reads .aider-desk/skills/tilly-product-marketing-context/SKILL.md
   └── Returns full skill content as a tool result message
   └── Tilly now has the skill's instructions in her conversation context

5. Tilly follows the skill's workflow
   └── Interviews user, creates marketing context documents
   └── Proceeds with the original marketing task

6. Even after conversation compaction
   └── findSkillActivationMessages preserves the skill activation
   └── Tilly still has the skill instructions in context
```

### Key Design Decisions

#### Namespace your skills

Prefix skill names with your extension name (e.g., `tilly-product-marketing-context` instead of `product-marketing-context`). This:
- Avoids collisions with user-created skills or other extensions
- Makes it clear which extension owns the skill
- Allows the extension to detect its own skills in `onToolCalled`

#### Enable `useSkillsTools: true` on the agent profile

The `skills---activate_skill` tool is only available when the agent profile has `useSkillsTools: true`. Without this, the agent won't have the skill tool at all, and the `{{#if toolPermissions.skills.allowed}}` block in the system prompt won't render.

#### `onLoad` fires before agent start

`onLoad` is called during `ExtensionManager.init()` (for global extensions) or `reloadProjectExtensions()` (when a project opens). This happens before any agent session starts, so skills written during `onLoad` will be discovered when the `skills---activate_skill` tool is created.

#### `onUnload` does NOT receive `ExtensionContext`

The `onUnload` signature is `onUnload?(): void | Promise<void>` — it receives no context. This means you cannot easily determine the project directory to clean up skill files. See the cleanup strategies below.

### Cleanup Strategies

Since `onUnload` doesn't provide context, you have two options:

**Option A: Leave the skills in place (recommended)**

Skills are small markdown files. Leaving them in `.aider-desk/skills/` after the extension is removed is harmless — they'll appear as regular project skills. If the extension is re-installed, `onLoad` will overwrite them.

**Option B: Track the project directory and clean up on `onUnload`**

```typescript
const installedProjectDirs: string[] = [];

export default class TillyExtension implements Extension {
  async onLoad(context: ExtensionContext): Promise<void> {
    const projectDir = context.getProjectDir();
    installedProjectDirs.push(projectDir);
    // ... write skills
  }

  async onUnload(): Promise<void> {
    for (const projectDir of installedProjectDirs) {
      for (const skillName of Object.keys(BUNDLED_SKILLS)) {
        const namespacedName = `${SKILL_NAMESPACE}-${skillName}`;
        const skillDir = path.join(
          projectDir, AIDER_DESK_DIR, SKILLS_DIR_NAME, namespacedName
        );
        try {
          await fs.rm(skillDir, { recursive: true, force: true });
        } catch {
          // Directory may already be removed
        }
      }
    }
  }
}
```

**⚠️ Important**: `onUnload` is called during app shutdown and when an extension file is removed/changed. It is **NOT** called when an extension is merely disabled in settings — disabled extensions are filtered out from active toolsets but their `onUnload` is not triggered.

---

## Other Ways Extensions Interact with Skills

### Intercept skill activation via `onToolApproval`

Control which skills can be activated:

```typescript
async onToolApproval(
  event: ToolApprovalEvent,
  context: ExtensionContext
): Promise<void | Partial<ToolApprovalEvent>> {
  if (event.toolName === 'skills---activate_skill') {
    const skillName = event.input?.skill;

    // Auto-approve your own skills
    if (typeof skillName === 'string' && skillName.startsWith('tilly-')) {
      return { allowed: true };
    }
  }
}
```

### Modify skill content via `onToolFinished`

Transform the skill content after it's been read but before it reaches the agent:

```typescript
async onToolFinished(
  event: ToolFinishedEvent,
  context: ExtensionContext
): Promise<void | Partial<ToolFinishedEvent>> {
  if (event.toolName === 'skills---activate_skill') {
    if (typeof event.output === 'string') {
      // Add extra context to the skill content
      const extra = '\n\n## Additional Project Context\n...';
      return { output: event.output + extra };
    }
  }
}
```

### Detect skill activation via `onToolCalled`

All tools — including `skills---activate_skill` — go through the standard tool execution pipeline that dispatches `onToolCalled`:

```typescript
async onToolCalled(
  event: ToolCalledEvent,
  context: ExtensionContext
): Promise<void | Partial<ToolCalledEvent>> {
  if (event.toolName === 'skills---activate_skill') {
    const skillName = event.input?.skill as string;
    context.log(`Skill activated: ${skillName}`, 'info');
  }
}
```

---

## Alternative: Skip the Skills System Entirely

If you want full control and don't need the skills tool's on-demand discovery and approval features, you can inject skill content directly via `onAgentStarted`:

```typescript
async onAgentStarted(
  event: AgentStartedEvent,
  context: ExtensionContext
): Promise<void | Partial<AgentStartedEvent>> {
  if (event.agentProfile.id !== 'tilly') return;

  // Inject skill content directly as context messages
  const skillContent = BUNDLED_SKILLS['product-marketing-context'];

  const skillMessage = {
    id: 'tilly-skill-injection',
    role: 'user' as const,
    content: `The following skill has been automatically activated for Tilly:\n\n${skillContent}`,
  };
  const ackMessage = {
    id: 'tilly-skill-injection-ack',
    role: 'assistant' as const,
    content: 'Understood. I will follow the skill instructions.',
  };

  return {
    contextMessages: [skillMessage, ackMessage, ...event.contextMessages],
  };
}
```

### Trade-offs

| Aspect | Skills System (`onLoad` + files) | Direct Injection (`onAgentStarted`) |
|--------|----------------------------------|-------------------------------------|
| Agent discovers skills | ✅ Appears in tool description | ❌ No discovery — content is injected |
| Agent chooses when to activate | ✅ Agent decides based on conditions | ❌ Always injected, no agent choice |
| Survives conversation compaction | ✅ `findSkillActivationMessages` preserves it | ❌ May be lost during compaction |
| User approval on activation | ✅ Goes through tool approval flow | ❌ No approval step |
| No filesystem side effects | ❌ Writes files to project dir | ✅ Pure in-memory |
| Conditional activation | ✅ Agent activates when needed | ⚠️ Requires custom logic in extension |

**Recommendation**: Use the skills system (`onLoad` + files) when the agent should **decide** when to activate a skill based on conditions. Use direct injection when the skill should **always** be active for a specific agent. For the Tilly use case — where she checks for context documents and only activates the skill if they're missing — the skills system is the right choice.

## Loading skills from a bundled directory within the extension

Rather than hard coding the skill infdormation into extension code, it is possible to keep skills in an extension directory and copy them to the correct location at run time as follows:

```typescript
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Extension, ExtensionContext, ExtensionMetadata } from '@aiderdesk/extensions';

// Find this extension's own directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AIDER_DESK_DIR = '.aider-desk';
const SKILLS_DIR_NAME = 'skills';
const SKILL_NAMESPACE = 'tilly';

export default class TillyExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: 'tilly',
    version: '1.0.0',
    description: 'Marketing specialist with bundled skills',
    author: 'your-team',
    capabilities: ['agents'],
  };

  async onLoad(context: ExtensionContext): Promise<void> {
    const projectDir = context.getProjectDir();
    const targetSkillsDir = path.join(projectDir, AIDER_DESK_DIR, SKILLS_DIR_NAME);

    // Source: skills/ directory inside this extension
    const sourceSkillsDir = path.join(__dirname, 'skills');

    // Copy each skill directory to the project's .aider-desk/skills/
    const entries = await fs.readdir(sourceSkillsDir);
    for (const entry of entries) {
      const sourceDir = path.join(sourceSkillsDir, entry);
      const stat = await fs.stat(sourceDir);
      if (!stat.isDirectory()) continue;

      const skillMdPath = path.join(sourceDir, 'SKILL.md');
      try {
        await fs.access(skillMdPath);
      } catch {
        continue; // No SKILL.md, skip
      }

      // Namespace the directory name to avoid collisions
      const namespacedDir = path.join(targetSkillsDir, `${SKILL_NAMESPACE}-${entry}`);
      await fs.mkdir(namespacedDir, { recursive: true });
      await fs.copyFile(skillMdPath, path.join(namespacedDir, 'SKILL.md'));
    }

    context.log('Tilly: Bundled skills installed', 'info');
  }
}
```

Your extension's file structure would look like:

```
tilly/
├── index.ts              ← Extension entry point
└── skills/
    ├── product-marketing-context/
    │   └── SKILL.md
    └── content-brief/
        └── SKILL.md
```

**One thing to watch**: the `name` field in each SKILL.md's front-matter should match the namespaced directory name (e.g., `name: tilly-product-marketing-context`), otherwise the skills system won't find it when the agent calls `skills---activate_skill` with that name. You can either:

- **Name the directories and front-matter consistently** from the start (simplest)
- **Rewrite the `name` field during copy** if you want to keep the source files clean:

```typescript
let content = await fs.readFile(skillMdPath, 'utf8');
content = content.replace(
  /^name: (.+)$/m,
  `name: ${SKILL_NAMESPACE}-$1`
);
await fs.writeFile(path.join(namespacedDir, 'SKILL.md'), content);
```