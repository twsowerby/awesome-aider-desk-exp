import type {
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
import { handlePromptTemplate } from './prompts/strip';
import { handleAgentStarted } from './prompts/inject';

interface TillyAgentProfile extends AgentProfile {
  atomicCommit?: boolean;
}

interface AgentRegistryEntry {
  name: string;
  role: string;
  model: string;
  instructions: string;
  atomicCommit: boolean;
  enabledServers: string[];
}

interface AgentRegistry {
  [agentId: string]: AgentRegistryEntry;
}

interface TillyConfig {
  defaults: {
    provider: string;
    model: string;
    maxIterations: number;
    enabledServers: string[];
    usePowerTools: boolean;
    useAiderTools: boolean;
    useTodoTools: boolean;
    useSubagents: boolean;
    useTaskTools: boolean;
    useMemoryTools: boolean;
    useSkillsTools: boolean;
    useExtensionTools: boolean;
    autoApprove: boolean;
  };
  editorialCheckpointInterval: number;
  contentStyleGuide?: string;
  atomicCommit?: boolean;
}

/**
 * Recursively merges two objects.
 */
function deepMerge<T>(target: T, source: any): T {
  if (source === undefined) return target;
  const isObject = (val: any): val is Record<string, any> => 
    val !== null && typeof val === 'object' && !Array.isArray(val);
  if (!isObject(target) || !isObject(source)) return source;
  const result = { ...target } as any;
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = deepMerge(result[key], source[key]);
  }
  return result;
}

export default class TillyExtension implements Extension {
  static metadata = {
    name: 'Tilly',
    version: '0.2.1',
    description: 'Content production team orchestration extension for AiderDesk',
    author: 'Tom Sowerby',
    capabilities: ['agents', 'tools', 'ui']
  };

  private agents: AgentProfile[] = [];
  private registry!: AgentRegistry;
  private config!: TillyConfig;
  private baseConfig!: TillyConfig;
  private extensionDir = '';
  private currentProjectDir: string = '';
  private stepCount: Map<string, number> = new Map();

  async onLoad(context: ExtensionContext): Promise<void> {
    this.extensionDir = path.resolve(__dirname);
    try {
      // Default config
      this.baseConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          maxIterations: 20,
          enabledServers: [],
          usePowerTools: true,
          useAiderTools: true,
          useTodoTools: true,
          useSubagents: true,
          useTaskTools: true,
          useMemoryTools: true,
          useSkillsTools: true,
          useExtensionTools: true,
          autoApprove: false
        },
        editorialCheckpointInterval: 10,
        atomicCommit: true
      };
      this.config = JSON.parse(JSON.stringify(this.baseConfig));

      const registryPath = path.join(this.extensionDir, 'agents', 'index.json');
      this.registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

      this.refreshAgents(context, context.getProjectDir());
    } catch (e: any) {
      context.log(`[Tilly] extension failed to load: ${e.message}`, 'error');
    }
  }

  private refreshAgents(context: ExtensionContext, projectDir: string): void {
    if (!projectDir) return;
    this.currentProjectDir = projectDir;
    this.stepCount.clear();

    let localConfig: any = {};
    const localConfigPath = path.join(projectDir, '.aider-desk', 'tilly.json');
    if (fs.existsSync(localConfigPath)) {
      try {
        localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
      } catch (e: any) {
        context.log(`[Tilly] failed to load local config: ${e.message}`, 'warn');
      }
    }

    this.config = deepMerge(JSON.parse(JSON.stringify(this.baseConfig)), localConfig);

    const availableProfiles = context.getProjectContext().getAgentProfiles();

    this.agents = Object.entries(this.registry).map(([id, entry]) => {
      const localAgentOverrides = localConfig.agents?.[id] || {};
      const mergedEntry = deepMerge(entry, localAgentOverrides);

      const [provider, model] = mergedEntry.model.split('/');
      const profile = availableProfiles.find((p: AgentProfile) => p.provider === provider && p.model === model) 
                   || availableProfiles[0];

      const instructionsPath = path.join(this.extensionDir, mergedEntry.instructions);
      let customInstructions = '';
      try {
        customInstructions = fs.readFileSync(instructionsPath, 'utf-8');
      } catch {
        customInstructions = `Role: ${mergedEntry.role}`;
      }

      return {
        ...this.config.defaults,
        ...profile,
        id,
        name: mergedEntry.name,
        customInstructions,
        atomicCommit: mergedEntry.atomicCommit ?? this.config.atomicCommit,
        enabledServers: mergedEntry.enabledServers || []
      } as TillyAgentProfile;
    });

    context.log(`[Tilly] refreshed agents for ${path.basename(projectDir)}`, 'info');
  }

  getAgents(context: ExtensionContext): AgentProfile[] {
    const projectDir = context.getProjectDir();
    if (projectDir && projectDir !== this.currentProjectDir) {
      this.refreshAgents(context, projectDir);
    }
    return this.agents;
  }

  async onAgentStarted(event: AgentStartedEvent, context: ExtensionContext): Promise<Partial<AgentStartedEvent> | void> {
    const agentId = event.agentProfile?.id;
    const tillyAgent = this.agents.find(a => a.id === agentId) as TillyAgentProfile;
    
    const result = await handleAgentStarted(event, context);
    
    if (tillyAgent) {
      const mergedProfile = { ...event.agentProfile, ...result?.agentProfile };
      mergedProfile.customInstructions = (tillyAgent.customInstructions || '') + '\n\n' + (mergedProfile.customInstructions || '');
      mergedProfile.enabledServers = tillyAgent.enabledServers || [];
      return { ...result, agentProfile: mergedProfile };
    }

    return result;
  }

  async onPromptTemplate(event: PromptTemplateEvent, context: ExtensionContext): Promise<Partial<PromptTemplateEvent> | void> {
    return handlePromptTemplate(event, context);
  }

  async onImportantReminders(event: ImportantRemindersEvent, context: ExtensionContext): Promise<void | Partial<ImportantRemindersEvent>> {
    const agentId = event.profile.id;
    const count = this.stepCount.get(agentId) || 0;
    
    if (count > 0 && count % this.config.editorialCheckpointInterval === 0) {
      const checkpoint = `\n<ThisIsImportant>\n<Reminder>\n🛑 **EDITORIAL CHECKPOINT** — You have reached step ${count}. 
Please verify that the content is still aligned with the BRIEF.md and matches the requested style and tone.
</Reminder>\n</ThisIsImportant>`;
      event.remindersContent = (event.remindersContent || '') + checkpoint;
    }

    if (this.config.contentStyleGuide) {
      const styleGuidePath = path.isAbsolute(this.config.contentStyleGuide) 
        ? this.config.contentStyleGuide 
        : path.join(context.getProjectDir(), this.config.contentStyleGuide);
      
      if (fs.existsSync(styleGuidePath)) {
        try {
          const styleGuide = fs.readFileSync(styleGuidePath, 'utf-8');
          const reminder = `\n<ThisIsImportant>\n<Reminder>\n📖 **CONTENT STYLE GUIDE**\n\n${styleGuide}\n</Reminder>\n</ThisIsImportant>`;
          event.remindersContent = (event.remindersContent || '') + reminder;
        } catch (e: any) {
          context.log(`[Tilly] Failed to read style guide: ${e.message}`, 'warn');
        }
      }
    }
    
    return event;
  }

  async onAgentStepFinished(event: AgentStepFinishedEvent, _context: ExtensionContext): Promise<void | Partial<AgentStepFinishedEvent>> {
    const agentId = event.agentProfile.id;
    this.stepCount.set(agentId, (this.stepCount.get(agentId) || 0) + 1);
  }

  async onSubagentFinished(event: SubagentFinishedEvent, context: ExtensionContext): Promise<void | Partial<SubagentFinishedEvent>> {
    const agentId = event.subagentProfile?.id;
    const tillyAgent = this.agents.find(a => a.id === agentId) as TillyAgentProfile;
    
    if (tillyAgent?.atomicCommit) {
      const projectDir = context.getProjectDir();
      if (git.isGitRepo(projectDir) && git.getChangedFiles(projectDir).length > 0) {
        git.stageFiles(projectDir);
        const message = `feat(${agentId}): completed task - ${event.subagentProfile?.name}`;
        git.commit(projectDir, message);
        context.log(`[Tilly] Atomic commit for ${agentId}`, 'info');
      }
    }
    return event;
  }

  getUIComponents(_context: ExtensionContext): UIComponentDefinition[] {
    return [
      {
        id: 'tilly-brief-button',
        placement: 'task-top-bar-right',
        loadData: true,
        jsx: `(props) => {
          const { Button } = props.ui;
          const { data, executeExtensionAction } = props;

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
              onClick={() => executeExtensionAction('open-brief')}
            >
              BRIEF.md
            </Button>
          );
        }`
      }
    ];
  }

  async getUIExtensionData(componentId: string, context: ExtensionContext): Promise<unknown> {
    if (componentId !== 'tilly-brief-button') return undefined;
    const taskContext = context.getTaskContext();
    if (!taskContext) return { exists: false };
    
    const briefPath = path.join(context.getProjectDir(), '.aider-desk', 'tasks', this.getRootTaskId(context), 'BRIEF.md');
    
    let codeAvailable = false;
    try {
      execSync('code --version', { stdio: 'ignore' });
      codeAvailable = true;
    } catch {
      // codeAvailable is false
    }

    return { exists: fs.existsSync(briefPath) && codeAvailable, briefPath };
  }

  async executeUIExtensionAction(componentId: string, action: string, _args: unknown[], context: ExtensionContext): Promise<unknown> {
    if (componentId !== 'tilly-brief-button' || action !== 'open-brief') return undefined;
    
    const briefPath = path.join(context.getProjectDir(), '.aider-desk', 'tasks', this.getRootTaskId(context), 'BRIEF.md');
    
    if (fs.existsSync(briefPath)) {
      exec(`code "${briefPath}"`, error => {
        if (error) {
          context.log(`[Tilly] Failed to open VS Code: ${error.message}`, 'error');
        } else {
          context.log(`[Tilly] Opened BRIEF.md in VS Code: ${briefPath}`, 'info');
        }
      });
      return { success: true, filePath: briefPath };
    }
    return { success: false, error: 'BRIEF.md does not exist' };
  }

  private getRootTaskId(ctx: ExtensionContext): string {
    let task = ctx.getTaskContext()?.data;
    while (task?.parentId) {
      const parent = ctx.getProjectContext().getTask(task.parentId);
      if (!parent) break;
      task = parent.data;
    }
    return task?.id || '';
  }

  getTools(_context: ExtensionContext, _mode: string, agentProfile: AgentProfile): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    
    tools.push({
      name: 'update-brief',
      description: 'Creates/updates BRIEF.md file with content. Writes to the task\'s working directory.',
      inputSchema: z.object({
        content: z.string().describe('The full markdown content for BRIEF.md')
      }),
      async execute(input, _signal, ctx) {
        const rootId = (ctx.extension as TillyExtension).getRootTaskId(ctx);
        const briefDir = path.join(ctx.getProjectDir(), '.aider-desk', 'tasks', rootId);
        fs.mkdirSync(briefDir, { recursive: true });
        const briefPath = path.join(briefDir, 'BRIEF.md');
        fs.writeFileSync(briefPath, (input as any).content, 'utf-8');
        ctx.triggerUIDataRefresh('tilly-brief-button');
        return { content: [{ type: 'text', text: `BRIEF.md updated at ${briefPath}` }] };
      }
    });

    tools.push({
      name: 'read-brief',
      description: 'Reads current BRIEF.md contents. Returns empty string if no brief exists.',
      inputSchema: z.object({}),
      async execute(_input, _signal, ctx) {
        const rootId = (ctx.extension as TillyExtension).getRootTaskId(ctx);
        const briefPath = path.join(ctx.getProjectDir(), '.aider-desk', 'tasks', rootId, 'BRIEF.md');
        try {
          const content = fs.readFileSync(briefPath, 'utf-8');
          return { content: [{ type: 'text', text: content }] };
        } catch {
          return { content: [{ type: 'text', text: '' }] };
        }
      }
    });

    if (agentProfile.id === 'tilly') {
      const specialistIds = Object.keys((_context.extension as any).registry).filter(id => id !== 'tilly');
      tools.push({
        name: 'delegate-to-content-agent',
        description: 'Delegates a task to a content specialist subagent.',
        inputSchema: z.object({
          agentId: z.enum(specialistIds as [string, ...string[]]).describe('The specialist agent ID'),
          taskName: z.string().describe('Short name for the subtask'),
          taskDescription: z.string().describe('Detailed instructions for the specialist')
        }),
        async execute(input, _signal, ctx) {
          const { agentId, taskName, taskDescription } = input as any;
          const tilly = ctx.extension as TillyExtension;
          const profile = tilly.getAgents(ctx).find(a => a.id === agentId);
          if (!profile) return { isError: true, content: [{ type: 'text', text: `Agent ${agentId} not found` }] };

          const taskContext = ctx.getTaskContext();
          if (!taskContext) return { isError: true, content: [{ type: 'text', text: 'No task context' }] };

          const newTask = await ctx.getProjectContext().createTask({
            parentId: taskContext.data.id,
            name: taskName,
            provider: profile.provider,
            model: profile.model,
            agentProfileId: profile.id
          });

          const subtaskContext = ctx.getProjectContext().getTask(newTask.id);
          if (subtaskContext) {
            await subtaskContext.runPrompt(taskDescription, 'agent');
            return { content: [{ type: 'text', text: `Task delegated to ${agentId}. Subtask ID: ${newTask.id}` }] };
          }
          return { isError: true, content: [{ type: 'text', text: 'Failed to create subtask context' }] };
        }
      });
    }

    return tools;
  }
}
