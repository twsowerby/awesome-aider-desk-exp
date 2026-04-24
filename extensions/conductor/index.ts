import type {
  AgentFinishedEvent,
  AgentProfile,
  AgentStartedEvent,
  AgentStepFinishedEvent,
  Extension,
  ExtensionContext,
  ImportantRemindersEvent,
  PromptTemplateEvent,
  SubagentFinishedEvent,
  ToolDefinition,
  UIComponentDefinition
} from '@aiderdesk/extensions';
import { exec, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as git from './git';
import * as prompts from './prompts';

/** Extended profile that includes commit-specific model config. These fields are injected at runtime by loadAgents() spreading AgentDefaults, which is why they require a cast. */
interface ConductorAgentProfile extends AgentProfile {
  commitProvider?: string;
  commitModel?: string;
}

interface AgentConfigEntry {
  id: string;
  atomicCommit?: boolean;
  name: string;
  instructionsFile?: string;
  instructionsFileByMode?: Record<string, string>;
  overrides: Record<string, unknown>;
  overridesByMode?: Record<string, Record<string, unknown>>;
  subagent: {
    enabled: boolean;
    contextMemory: string;
    systemPrompt: string;
    invocationMode: string;
    color: string;
    description: string;
  };
}

interface AgentsConfig {
  defaults: Record<string, unknown>;
  agents: AgentConfigEntry[];
}

type DelegationMode = 'subtask' | 'subagent';

interface AgentDefaults {
  provider: string;
  model: string;
  commitProvider?: string;
  commitModel?: string;
  maxIterations: number;
  minTimeBetweenToolCalls: number;
  enabledServers: string[];
  toolApprovals: Record<string, unknown>;
  toolSettings: Record<string, unknown>;
  includeContextFiles: boolean;
  includeRepoMap: boolean;
  usePowerTools: boolean;
  useAiderTools: boolean;
  useTodoTools: boolean;
  useSubagents: boolean;
  useTaskTools: boolean;
  useMemoryTools: boolean;
  useSkillsTools: boolean;
  useExtensionTools: boolean;
  autoApprove: boolean;
}

interface ConductorConfig {
  delegationMode: DelegationMode;
  reflection?: {
    enabled: boolean;
    interval: number;
  };
  reminders?: {
    conductor?: string[];
    subagent?: string[];
  };
  defaults: AgentDefaults;
}

/**
 * Recursively merges two objects.
 * For primitives, arrays, or nulls, the second value replaces the first.
 * For plain objects, keys are merged recursively.
 */
function deepMerge<T>(target: T, source: any): T {
  if (source === undefined) return target;
  
  const isObject = (val: any): val is Record<string, any> => 
    val !== null && typeof val === 'object' && !Array.isArray(val);

  if (!isObject(target) || !isObject(source)) {
    return source;
  }

  const result = { ...target } as any;
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = deepMerge(result[key], source[key]);
  }
  return result;
}

function resolveSpecDir(ctx: ExtensionContext): string {
  const taskContext = ctx.getTaskContext()!;
  let taskId = taskContext.data.id;
  let parentId = taskContext.data.parentId;

  while (parentId) {
    const parentTask = ctx.getProjectContext().getTask(parentId);
    if (!parentTask) break;
    taskId = parentTask.data.id;
    parentId = parentTask.data.parentId;
  }

  return path.join(ctx.getProjectDir(), '.aider-desk', 'tasks', taskId);
}

function loadAgents(extensionDir: string, configDefaults: AgentDefaults, delegationMode: string, localAgentOverrides?: Record<string, Record<string, unknown>>): AgentProfile[] {
  const agentsDir = path.join(extensionDir, 'agents');
  const configPath = path.join(agentsDir, 'index.json');

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config: AgentsConfig = JSON.parse(raw);

  return config.agents.map(entry => {
    const instructionsFile = entry.instructionsFileByMode?.[delegationMode] ?? entry.instructionsFile ?? 'missing.md';
    const mdPath = path.join(agentsDir, instructionsFile);
    let instructions = '';
    try {
      instructions = fs.readFileSync(mdPath, 'utf-8').trim();
      instructions = applyModePlaceholders(instructions, delegationMode);
    } catch {
      instructions = `(Missing instructions file: ${instructionsFile})`;
    }

    const mergedOverrides = {
      ...entry.overrides,
      ...(entry.overridesByMode?.[delegationMode] || {})
    };

    const localOverrides = localAgentOverrides?.[entry.id];
    const finalOverrides = localOverrides ? deepMerge(mergedOverrides, localOverrides) : mergedOverrides;

    return {
      ...configDefaults,
      ...finalOverrides,
      id: entry.id,
      name: entry.name,
      customInstructions: instructions,
      subagent: entry.subagent
    } as AgentProfile;
  });
}

const DELEGATE_TOOLS: Record<string, string> = {
  subtask: 'delegate-to-agent',
  subagent: 'subagents---run_task'
};

function applyModePlaceholders(instructions: string, mode: string): string {
  const tool = DELEGATE_TOOLS[mode] ?? mode;
  return instructions.replace(/\{\{DELEGATE_TOOL}}/g, tool);
}

function loadConfig(extensionDir: string): ConductorConfig {
  const configPath = path.join(extensionDir, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function loadLocalConfig(projectDir: string): { defaults?: Record<string, unknown>; agents?: Record<string, Record<string, unknown>> } | null {
  const localConfigPath = path.join(projectDir, '.aider-desk', 'conductor.json');
  if (!fs.existsSync(localConfigPath)) {
    return null;
  }
  const raw = fs.readFileSync(localConfigPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Sanitizes a string for safe use in JSON and task descriptions.
 * Removes control characters (except \n, \r, \t) and fixes invalid escape sequences.
 */
function sanitizeTaskDescription(text: string): string {
  if (!text) {
    return '';
  }

  return (
    text
      // Remove control characters except newline, carriage return, and tab
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
      // Remove zero-width characters that can cause issues
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      // Normalize line endings to \n
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Remove invalid surrogate pairs
      .replace(/[\ud800-\udfff](?![\udc00-\udfff])/g, '')
      // Remove lone low surrogates
      .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      // Trim whitespace
      .trim()
  );
}

const CONFIGURABLE_FIELDS = [
  'provider',
  'model',
  'commitProvider',
  'commitModel',
  'maxIterations',
  'minTimeBetweenToolCalls',
  'enabledServers',
  'toolApprovals',
  'toolSettings',
  'includeContextFiles',
  'includeRepoMap',
  'usePowerTools',
  'useAiderTools',
  'useTodoTools',
  'useSubagents',
  'useTaskTools',
  'useMemoryTools',
  'useSkillsTools',
  'useExtensionTools',
  'autoApprove'
] as const;
// customInstructions and subagent are intentionally excluded because they're managed through the agents config, not user overrides.

/**
 * Returns a profile with only default/base values, used for diffing.
 */
function getBaseProfile(agentId: string, config: ConductorConfig, agentsConfig: AgentsConfig): AgentProfile {
  const entry = agentsConfig.agents.find(a => a.id === agentId);
  if (!entry) {
    throw new Error(`Agent config entry not found for ${agentId}`);
  }

  const mergedOverrides = {
    ...entry.overrides,
    ...(entry.overridesByMode?.[config.delegationMode] || {})
  };

  return {
    ...config.defaults,
    ...mergedOverrides,
    id: entry.id,
    name: entry.name,
    customInstructions: '',
    subagent: entry.subagent
  } as AgentProfile;
}

export default class ConductorExtension implements Extension {
  static metadata = {
    name: 'Conductor',
    version: '0.2.1',
    description: 'Spec-driven development and agent orchestration workflow',
    author: 'Paweł Klockiewicz',
    capabilities: ['agents', 'tools', 'ui']
  };

  private agents: AgentProfile[] = [];
  private agentsConfig!: AgentsConfig;
  private config!: ConductorConfig;
  private baseConfig!: ConductorConfig;
  private extensionDir = '';
  private localConfig: {
    reflection?: { enabled?: boolean; interval?: number };
    defaults?: Record<string, unknown>;
    agents?: Record<string, Record<string, unknown>>;
  } = {};
  private currentProjectDir: string = '';
  private stepCount: Map<string, number> = new Map();
  private lastReflectionStep: Map<string, number> = new Map();

  async onLoad(context: ExtensionContext): Promise<void> {
    this.extensionDir = path.resolve(__dirname);
    try {
      this.config = loadConfig(this.extensionDir);
      this.baseConfig = JSON.parse(JSON.stringify(this.config));

      const agentsDir = path.join(this.extensionDir, 'agents');
      this.agentsConfig = JSON.parse(fs.readFileSync(path.join(agentsDir, 'index.json'), 'utf-8'));

      // Refresh agents for the current project directory
      this.refreshAgents(context, context.getProjectDir());

      // Ensure agents are loaded even if refreshAgents returned early (no project dir)
      if (this.agents.length === 0 && this.config) {
        this.agents = loadAgents(this.extensionDir, { ...this.config.defaults }, this.config.delegationMode);
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      context.log(`[Conductor] extension failed to load: ${errorMessage}`, 'error');
    }
  }

  private refreshAgents(context: ExtensionContext, projectDir: string): void {
    if (!this.config) return;
    if (!projectDir) return;
    this.stepCount.clear();
    this.lastReflectionStep.clear();
    this.currentProjectDir = projectDir;

    // Load local config for this project
    let local: {
      reflection?: { enabled?: boolean; interval?: number };
      defaults?: Record<string, unknown>;
      agents?: Record<string, Record<string, unknown>>;
    } | null = null;
    try {
      local = loadLocalConfig(projectDir);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      context.log(`[Conductor] failed to load local config: ${msg}`, 'warn');
    }

    // Merge reflection config
    const mergedReflection = local?.reflection
      ? (deepMerge({ ...this.baseConfig.reflection }, local.reflection) as any)
      : { ...this.baseConfig.reflection };

    // Merge defaults
    const mergedDefaults = local?.defaults
      ? deepMerge({ ...this.baseConfig.defaults }, local.defaults)
      : { ...this.baseConfig.defaults };

    // Store localConfig for persistence
    this.localConfig = local || {};

    // Rebuild agents with the correct local overrides
    this.agents = loadAgents(this.extensionDir, mergedDefaults, this.config.delegationMode, local?.agents);

    // Update active config with merged reflection for current project
    this.config.reflection = mergedReflection;

    const overriddenAgents = Object.keys(local?.agents || {});
    if (local) {
      context.log(
        `[Conductor] refreshed agents for project ${path.basename(projectDir)} (overrides: defaults${overriddenAgents.length > 0 ? `, agents: ${overriddenAgents.join(', ')}` : ''})`,
        'info'
      );
    } else {
      context.log(
        `[Conductor] refreshed agents for project ${path.basename(projectDir)} (no local config)`,
        'info'
      );
    }
  }

  getAgents(context: ExtensionContext): AgentProfile[] {
    if (!this.config) return this.agents;
    const projectDir = context.getProjectDir();
    if (projectDir && projectDir !== this.currentProjectDir) {
      // Project directory changed since last refresh — refresh agents
      this.refreshAgents(context, projectDir);
    }
    return this.agents;
  }

  async onProjectStarted(event: { readonly baseDir: string }, context: ExtensionContext): Promise<void> {
    if (!this.config) return;
    const projectDir = event.baseDir;
    if (projectDir && projectDir !== this.currentProjectDir) {
      context.log(`[Conductor] project started: ${path.basename(projectDir)}`, 'info');
      this.refreshAgents(context, projectDir);
    }
  }

  getUIComponents(_context: ExtensionContext): UIComponentDefinition[] {
    return [
      {
        id: 'conductor-spec-button',
        placement: 'task-top-bar-right',
        loadData: true,
        jsx: `(props) => {
          const { Button } = props.ui;
          const { data, executeExtensionAction } = props;

          // Only show if SPEC.md exists
          if (!data?.exists) {
            return null;
          }

          return (
            <Button
              variant="subtle"
              size="compact-s"
              className="mr-2 px-2 py-1
                bg-bg-secondary text-text-tertiary
                hover:bg-bg-secondary-light hover:text-text-primary
                focus:outline-none
                transition-colors duration-200
                text-2xs
                border border-border-default"
              onClick={() => executeExtensionAction('open-spec')}
            >
              SPEC.md
            </Button>
          );
        }`
      }
    ];
  }

  async getUIExtensionData(componentId: string, context: ExtensionContext): Promise<unknown> {
    if (componentId !== 'conductor-spec-button') {
      return undefined;
    }

    const taskContext = context.getTaskContext();
    if (!taskContext) {
      return { exists: false };
    }

    try {
      const specDir = resolveSpecDir(context);
      const specPath = path.join(specDir, 'SPEC.md');
      const specExists = fs.existsSync(specPath);

      // Check if VS Code is available in PATH
      let codeAvailable = false;
      try {
        execSync('code --version', { stdio: 'ignore' });
        codeAvailable = true;
      } catch {
        // codeAvailable is already false from initialization
      }

      return { exists: specExists && codeAvailable, specPath };
    } catch (e: any) {
      context.log(`[Conductor] getUIExtensionData error: ${e.message}`, 'error');
      return { exists: false };
    }
  }

  async executeUIExtensionAction(
    componentId: string,
    action: string,
    _args: unknown[],
    context: ExtensionContext
  ): Promise<unknown> {
    if (componentId !== 'conductor-spec-button' || action !== 'open-spec') {
      return undefined;
    }

    const taskContext = context.getTaskContext();
    if (!taskContext) {
      return { success: false, error: 'No active task context' };
    }

    try {
      const specDir = resolveSpecDir(context);
      const specPath = path.join(specDir, 'SPEC.md');

      if (!fs.existsSync(specPath)) {
        return { success: false, error: 'SPEC.md does not exist' };
      }

      // Open SPEC.md in VS Code
      exec(`code "${specPath}"`, error => {
        if (error) {
          context.log(`[Conductor] Failed to open VS Code: ${error.message}`, 'error');
        } else {
          context.log(`[Conductor] Opened SPEC.md in VS Code: ${specPath}`, 'info');
        }
      });

      return { success: true, filePath: specPath };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async onAgentStarted(event: AgentStartedEvent, context: ExtensionContext): Promise<Partial<AgentStartedEvent>> {
    const agentId = event.agentProfile?.id;
    if (!agentId) return {};

    const conductorAgent = this.agents.find(a => a.id === agentId);

    // Build the return object
    const result: Partial<AgentStartedEvent> = {};

    // Check if enabledServers needs to be corrected
    if (conductorAgent) {
      const currentServers = event.agentProfile.enabledServers || [];
      const expectedServers = conductorAgent.enabledServers || [];

      if (JSON.stringify(currentServers) !== JSON.stringify(expectedServers)) {
        context.log(
          `[Conductor] onAgentStarted: correcting enabledServers for ${agentId} from [${currentServers}] to [${expectedServers}]`,
          'info'
        );
        result.agentProfile = {
          ...event.agentProfile,
          enabledServers: expectedServers,
        };
      }
    }

    // Inject per-agent directives and workflow
    try {
      const augmentation = prompts.getAgentPromptAugmentation(agentId, this.extensionDir);
      if (augmentation) {
        const existingPrompt = event.systemPrompt || '';
        result.systemPrompt = existingPrompt + '\n\n' + augmentation;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      context.log(`[Conductor] onAgentStarted: failed to inject agent prompt for ${agentId}: ${msg}`, 'error');
    }

    return result;
  }

  async onAgentStepFinished(
    event: AgentStepFinishedEvent,
    _context: ExtensionContext
  ): Promise<void | Partial<AgentStepFinishedEvent>> {
    if (!this.config.reflection?.enabled) return;

    const interval = this.config.reflection?.interval ?? 10;
    if (interval < 2) return;

    const profileId = event.agentProfile.id;
    const currentCount = this.stepCount.get(profileId) ?? 0;
    this.stepCount.set(profileId, currentCount + 1);

    return event;
  }

  async onAgentProfileUpdated(
    context: ExtensionContext,
    agentId: string,
    updatedProfile: AgentProfile
  ): Promise<AgentProfile> {
    const idx = this.agents.findIndex(a => a.id === agentId);
    if (idx !== -1) {
      const currentAgent = this.agents[idx];

      // Preserve conductor-managed enabledServers if they differ from incoming
      const currentServers = currentAgent.enabledServers || [];
      const incomingServers = updatedProfile.enabledServers || [];
      if (JSON.stringify(incomingServers) !== JSON.stringify(currentServers) && currentServers.length > 0) {
        context.log(
          `[Conductor] onAgentProfileUpdated: preserving enabledServers for ${agentId} (incoming: [${incomingServers}], expected: [${currentServers}])`,
          'warn'
        );
        updatedProfile = {
          ...updatedProfile,
          enabledServers: currentServers,
        };
      }

      this.agents[idx] = updatedProfile;

      // Persist the override
      try {
        await this.persistAgentOverride(context, agentId, updatedProfile);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        context.log(`[Conductor] failed to persist agent override for ${agentId}: ${msg}`, 'error');
      }
    }
    return updatedProfile;
  }

  async onPromptTemplate(event: PromptTemplateEvent, context: ExtensionContext): Promise<Partial<PromptTemplateEvent> | void> {
    try {
      if (event.name === 'system-prompt') {
        const prompt = prompts.renderSystemPrompt(this.extensionDir, event.data);
        return { prompt };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      context.log(`[Conductor] onPromptTemplate failed: ${msg}`, 'error');
    }

    return void 0;
  }

  private async persistAgentOverride(context: ExtensionContext, agentId: string, updatedProfile: AgentProfile): Promise<void> {
    const baseProfile = getBaseProfile(agentId, this.config, this.agentsConfig);
    const diff: Record<string, any> = {};

    for (const field of CONFIGURABLE_FIELDS) {
      const updatedVal = (updatedProfile as any)[field];
      const baseVal = (baseProfile as any)[field];

      if (JSON.stringify(updatedVal) !== JSON.stringify(baseVal)) {
        diff[field] = updatedVal;
      }
    }

    const projectDir = context.getProjectDir();
    const localConfigPath = path.join(projectDir, '.aider-desk', 'conductor.json');
    
    // Check for malformed JSON before proceeding
    if (fs.existsSync(localConfigPath)) {
      try {
        JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
      } catch (e) {
        context.log(`[Conductor] existing local config is malformed, aborting override to prevent data loss: ${e}`, 'error');
        return;
      }
    }

    if (!this.localConfig.agents) {
      this.localConfig.agents = {};
    }

    if (Object.keys(diff).length === 0) {
      delete this.localConfig.agents[agentId];
    } else {
      this.localConfig.agents[agentId] = diff;
    }

    if (Object.keys(this.localConfig.agents).length === 0) {
      delete this.localConfig.agents;
    }

    const aiderDeskDir = path.join(projectDir, '.aider-desk');
    if (!fs.existsSync(aiderDeskDir)) {
      fs.mkdirSync(aiderDeskDir, { recursive: true });
    }

    fs.writeFileSync(localConfigPath, JSON.stringify(this.localConfig, null, 2), 'utf-8');
    
    const fields = Object.keys(diff);
    if (fields.length > 0) {
      context.log(`[Conductor] persisted agent override for ${agentId}: ${fields.join(', ')}`, 'info');
    } else {
      context.log(`[Conductor] removed agent override for ${agentId} (matches base profile)`, 'info');
    }
  }

  async onImportantReminders(
    event: ImportantRemindersEvent,
    _context: ExtensionContext
  ): Promise<void | Partial<ImportantRemindersEvent>> {
    try {
      if (this.config.reminders) {
        let reminders: string[] = [];
        if (event.profile.id === 'conductor' && this.config.reminders.conductor) {
          reminders = this.config.reminders.conductor;
        } else if (this.config.reminders.subagent) {
          reminders = this.config.reminders.subagent;
        }

        if (reminders.length > 0) {
          const customReminders = `\n<ThisIsImportant>\n${reminders.map((r: string) => `<Reminder>\n${r}\n</Reminder>`).join('\n')}\n</ThisIsImportant>`;

          if (event.profile.id === 'conductor') {
            event.remindersContent = customReminders;
          } else {
            event.remindersContent += customReminders;
          }
        }
      }

      if (this.config.reflection?.enabled) {
        const interval = this.config.reflection?.interval ?? 10;
        const profileId = event.profile.id;
        const currentCount = this.stepCount.get(profileId) ?? 0;
        const lastReflected = this.lastReflectionStep.get(profileId) ?? 0;

        if (interval >= 2 && currentCount > 0 && currentCount - lastReflected >= interval) {
          this.lastReflectionStep.set(profileId, currentCount);

          const reflectionPrompt = `\n<ThisIsImportant>\n<Reminder>\n⏸️ **REFLECTION CHECKPOINT** — You have completed ${interval} steps since the last checkpoint. Pause and reflect:

1. **Progress**: What have you accomplished so far? Summarize key outcomes.
2. **Alignment**: Are you still on track with the original brief/task? Has the scope drifted?
3. **Issues**: Are there any blockers, unexpected complications, or diminishing returns?
4. **Next Steps**: Should you continue as planned, adjust your approach, or conclude?

Be honest and concise. If you're off track, course-correct now.
</Reminder>\n</ThisIsImportant>`;

          if (event.profile.id === 'conductor') {
            event.remindersContent = reflectionPrompt + (event.remindersContent || '');
          } else {
            event.remindersContent += reflectionPrompt;
          }
        }
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      _context.log(`[Conductor] Failed to process reminders: ${errorMessage}`, 'warn');
    }

    return event;
  }

  async onSubagentFinished(event: SubagentFinishedEvent, context: ExtensionContext): Promise<void | Partial<SubagentFinishedEvent>> {
    try {
      const agentId = event.subagentProfile?.id;
      if (!agentId) return event;

      const agentConfig = this.getAgentConfigEntry(agentId);
      if (!agentConfig?.atomicCommit) return event;

      await this.performAtomicCommit(context, agentId, event.subagentProfile?.name || agentId, '');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      context.log(`[Conductor] onSubagentFinished error: ${errorMessage}`, 'error');
    }

    return event;
  }

  getTools(_context: ExtensionContext, _mode: string, agentProfile: AgentProfile): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const isWorkflowAgent = Boolean(agentProfile?.id && this.agents.some(a => a.id === agentProfile.id));

    if (isWorkflowAgent) {
      tools.push({
        name: 'update-spec',
        description:
          'Create or update the SPEC.md file with the latest requirements, task breakdowns, and status. This is the central source of truth for the current work.',
        inputSchema: z.object({
          content: z.string().describe('The full markdown content for the SPEC.md file')
        }),
        async execute(input, _signal, ctx) {
          const taskContext = ctx.getTaskContext();
          if (!taskContext) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No active task context' }] };
          }

          const specDir = resolveSpecDir(ctx);
          fs.mkdirSync(specDir, { recursive: true });
          const specPath = path.join(specDir, 'SPEC.md');
          fs.writeFileSync(specPath, (input as any).content, 'utf-8');
          ctx.log(`[Conductor] update-spec created file at: ${specPath}`, 'info');

          try {
            await taskContext.addFile(specPath, false);
          } catch {
            // File may already be in context
          }

          // Trigger UI refresh to show the SPEC.md button
          ctx.triggerUIDataRefresh('conductor-spec-button');

          return { content: [{ type: 'text' as const, text: `SPEC.md updated at ${specPath}` }] };
        }
      });

      tools.push({
        name: 'read-spec',
        description: 'Read the current SPEC.md file contents. Returns empty string if no spec exists yet.',
        inputSchema: z.object({}),
        async execute(_input, _signal, ctx) {
          const taskContext = ctx.getTaskContext();
          if (!taskContext) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No active task context' }] };
          }

          const specPath = path.join(resolveSpecDir(ctx), 'SPEC.md');
          let content = '';
          try {
            content = fs.readFileSync(specPath, 'utf-8');
          } catch {
            content = '(No SPEC.md exists yet)';
          }

          return { content: [{ type: 'text' as const, text: content }] };
        }
      });
    }

    // conductor-only tool: delegate-to-agent (subtask mode only)
    // In subagent mode the native subagents---run_task tool is used instead,
    // which properly blocks the conductor until the specialist finishes.
    if (agentProfile?.id === 'conductor' && this.config.delegationMode === 'subtask') {
      const specialistIds = this.agents.filter(a => a.id !== 'conductor').map(a => a.id);

      tools.push({
        name: 'delegate-to-agent',
        description: `Delegate a task to a specialist subagent. Creates a visible subtask under the current task and runs the subagent inside it, so all work is tracked in the subtask. Available agents: ${specialistIds.join(', ')}`,
        inputSchema: z.object({
          agentId: z.string().describe(`The specialist agent ID to delegate to. One of: ${specialistIds.join(', ')}`),
          taskName: z.string().describe('Short descriptive name for the subtask (e.g., "Create CatComponent")'),
          taskDescription: z
            .string()
            .describe(
              'Detailed task description including: what to do, which files/areas to work on, acceptance criteria, and verification commands. The subagent only sees this text — include ALL necessary context.'
            )
        }),
        execute: async (input, _signal, ctx) => {
          const { agentId, taskName, taskDescription: rawTaskDescription } = input as any;
          const taskDescription = sanitizeTaskDescription(rawTaskDescription);
          const taskContext = ctx.getTaskContext();
          if (!taskContext) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No active task context' }] };
          }

          const profiles = ctx.getProjectContext().getAgentProfiles();
          const profile = profiles.find((p: AgentProfile) => p.id === agentId);

          if (!profile) {
            return {
              isError: true,
              content: [
                { type: 'text' as const, text: `Agent "${agentId}" not found. Available: ${specialistIds.join(', ')}` }
              ]
            };
          }

          ctx.log(`[Conductor] Delegating to ${profile.name} (subtask): ${taskDescription.slice(0, 100)}...`, 'info');

          return this.delegateViaSubtask(ctx, taskContext, profile, taskName, taskDescription);
        }
      });
    }

    return tools;
  }

  private getAgentConfigEntry(agentId: string): AgentConfigEntry | undefined {
    return this.agentsConfig.agents.find(a => a.id === agentId);
  }

  /**
   * Stage all changed files and commit with an auto-generated message.
   * Used by both onSubagentFinished (subagent mode) and delegateViaSubtask (subtask mode).
   */
  private async performAtomicCommit(
    ctx: ExtensionContext,
    agentId: string,
    agentName: string,
    taskDescription: string
  ): Promise<void> {
    const projectDir = ctx.getProjectDir();
    if (!git.isGitRepo(projectDir)) return;

    const changedFiles = git.getChangedFiles(projectDir);
    if (changedFiles.length === 0) return;

    const stageResult = git.stageFiles(projectDir);
    if (!stageResult.success) {
      ctx.log(`[Conductor] Failed to stage files: ${stageResult.error}`, 'error');
      return;
    }

    if (!git.hasStagedChanges(projectDir)) return;

    // Get commit provider/model with fallback chain:
    // 1. Per-agent override (loadAgents() spreads AgentDefaults into the profile at runtime,
    //    so commitProvider/commitModel may exist on the profile object even though AgentProfile
    //    doesn't declare them)
    // 2. Config defaults (this.config.defaults.commitProvider/commitModel)
    // 3. Agent's own provider/model as final fallback
    const agentProfile = this.agents.find(a => a.id === agentId);
    const commitProvider = (agentProfile as ConductorAgentProfile)?.commitProvider ?? this.config.defaults.commitProvider ?? agentProfile?.provider;
    const commitModel = (agentProfile as ConductorAgentProfile)?.commitModel ?? this.config.defaults.commitModel ?? agentProfile?.model;

    const message = await this.generateCommitMessage(ctx, agentId, agentName, taskDescription, commitProvider, commitModel);
    const commitResult = git.commit(projectDir, message);
    if (commitResult.success) {
      ctx.log(`[Conductor] Atomic commit (${agentId}): ${commitResult.output}`, 'info');
    } else {
      ctx.log(`[Conductor] Atomic commit failed (${agentId}): ${commitResult.error}`, 'error');
    }
  }

  private async generateCommitMessage(
    ctx: ExtensionContext,
    agentId: string,
    agentName: string,
    taskDescription: string,
    commitProvider: string | undefined,
    commitModel: string | undefined
  ): Promise<string> {
    const sanitizedAgentName = agentName.replace(/^[\u2500-\u257F ]+/, '').trim().toLowerCase() || agentId;

    if (!commitProvider || !commitModel) {
      return this.fallbackCommitMessage(sanitizedAgentName, taskDescription);
    }

    try {
      const taskContext = ctx.getTaskContext();
      if (!taskContext) {
        ctx.log('[Conductor] No task context for commit message generation, using fallback', 'warn');
        return this.fallbackCommitMessage(sanitizedAgentName, taskDescription);
      }

      const diffContent = git.getDiff(ctx.getProjectDir()) || '(no diff available)';
      const systemPrompt = `You are a commit message generator. Write a concise, conventional-commits-style commit message based on the git diff. Use the format: "type(agent): description" where agent is the lowercase agent name. Types: feat, fix, refactor, style, docs, test, chore. Examples: "feat(implementor): add user authentication", "fix(debugger): resolve null pointer in parser", "refactor(simplifier): extract validation into shared module". Keep the message under 72 characters. Output ONLY the commit message, nothing else.`;
      const userPrompt = `Agent: ${sanitizedAgentName}\nTask: ${taskDescription.slice(0, 200)}\n\nDiff:\n${diffContent.slice(0, 4000)}`;

      // Find a profile whose provider and model match the commit fields.
      const profiles = ctx.getProjectContext().getAgentProfiles();
      const commitProfile = profiles.find(
        (p: AgentProfile) => p.provider === commitProvider && p.model === commitModel
      );
      if (!commitProfile) {
        ctx.log(
          `[Conductor] No agent profile found matching commitProvider "${commitProvider}" and commitModel "${commitModel}", using fallback`,
          'warn'
        );
        return this.fallbackCommitMessage(sanitizedAgentName, taskDescription);
      }

      const generated = await taskContext.generateText(commitProfile, systemPrompt, userPrompt);
      if (generated?.trim()) {
        return generated.trim();
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      ctx.log(`[Conductor] LLM commit message generation failed: ${errorMessage}`, 'warn');
    }

    return this.fallbackCommitMessage(sanitizedAgentName, taskDescription);
  }

  private fallbackCommitMessage(sanitizedAgentName: string, taskDescription: string): string {
    const shortDesc = taskDescription.slice(0, 80).split('\n')[0].trim() || 'code changes';
    return git.generateFallbackMessage(sanitizedAgentName, shortDesc);
  }

  /**
   * Subtask mode: creates a child task, sets agent profile, runs via runPrompt.
   * Messages persist in the subtask's context manager.
   */
  private async delegateViaSubtask(
    ctx: ExtensionContext,
    taskContext: ReturnType<ExtensionContext['getTaskContext']> & {},
    profile: AgentProfile,
    taskName: string,
    taskDescription: string
  ) {
    try {
      const parentId = taskContext.data.id;
      const newTask = await ctx.getProjectContext().createTask({
        parentId,
        name: taskName,
        autoApprove: this.config.defaults.autoApprove,
        activate: false,
        sendEvent: true,
        provider: profile.provider,
        model: profile.model,
      });

      const subtaskContext = ctx.getProjectContext().getTask(newTask.id);
      if (!subtaskContext) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Subtask "${taskName}" created (id: ${newTask.id}) but could not get its context.`
            }
          ]
        };
      }

      await subtaskContext.updateTask({ agentProfileId: profile.id });
      await subtaskContext.runPrompt(taskDescription, 'agent');

      let resultSummary = '';
      try {
        const RESULT_MARKER = '<!-- RESULT -->';
        const messages = await subtaskContext.getContextMessages();
        const markedText = [...messages]
          .filter(m => m.role === 'assistant')
          .map(m =>
            (m as any).content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text as string)
              .join('\n')
              .trim()
          )
          .find(t => t.startsWith(RESULT_MARKER));
        if (markedText) {
          // Strip the marker line itself before passing to conductor
          resultSummary = `\n\n--- Subtask Result ---\n${markedText.slice(RESULT_MARKER.length).trimStart()}`;
        } else {
          // Fallback: pick the longest assistant message
          ctx.log(`[Conductor] No ${RESULT_MARKER} marker found in subtask — falling back to longest message`, 'warn');
          const allTexts = [...messages]
            .filter(m => m.role === 'assistant')
            .map(m =>
              (m as any).content
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text as string)
                .join('\n')
                .trim()
            )
            .filter(t => t.length > 0);
          const longest = allTexts.reduce((best, t) => (t.length > best.length ? t : best), '');
          if (longest) resultSummary = `\n\n--- Subtask Result ---\n${longest}`;
        }

        await subtaskContext.updateTask({
          state: 'completed',
          completedAt: new Date().toISOString()
        });

        // Atomic commit: commit changes made by this subagent if the agent has atomicCommit flag
        const agentConfig = this.getAgentConfigEntry(profile.id);
        if (agentConfig?.atomicCommit) {
          await this.performAtomicCommit(ctx, profile.id, profile.name, taskDescription);
        }
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        ctx.log(`[Conductor] Failed to extract subtask results or update status: ${errorMessage}`, 'warn');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Subtask "${taskName}" (id: ${newTask.id}) completed by ${profile.name}.${resultSummary}`
          }
        ]
      };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error delegating to ${profile.name}: ${errorMessage}` }]
      };
    }
  }
}