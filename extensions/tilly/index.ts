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
import { AGENT_CONFIGS } from './prompts/agent-configs';

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

function deepMerge<T>(target: T, source: any): T {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target } as any;
  for (const key of Object.keys(source)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const sVal = source[key];
    const tVal = result[key];
    result[key] = (tVal && sVal && typeof tVal === 'object' && typeof sVal === 'object' && !Array.isArray(tVal))
      ? deepMerge(tVal, sVal)
      : sVal;
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
  private currentProjectDir: string = '';
  private stepCount: Map<string, number> = new Map();

  async onLoad(context: ExtensionContext): Promise<void> {
    try {
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
      
      const registryPath = path.join(__dirname, 'agents', 'index.json');
      this.registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      this.refreshAgents(context, context.getProjectDir());
    } catch (e: any) {
      context.log(`[Tilly] failed to load: ${e.message}`, 'error');
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

    this.config = deepMerge(this.baseConfig, localConfig);
    const availableProfiles = context.getProjectContext().getAgentProfiles();

    this.agents = Object.entries(this.registry).map(([id, entry]) => {
      const mergedEntry = deepMerge(entry, localConfig.agents?.[id]);
      const [provider, model] = mergedEntry.model.split('/');
      const profile = availableProfiles.find((p: AgentProfile) => p.provider === provider && p.model === model) || availableProfiles[0];

      let customInstructions = '';
      try {
        customInstructions = fs.readFileSync(path.join(__dirname, mergedEntry.instructions), 'utf-8');
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
  }

  getAgents(context: ExtensionContext): AgentProfile[] {
    const projectDir = context.getProjectDir();
    if (projectDir && projectDir !== this.currentProjectDir) this.refreshAgents(context, projectDir);
    return this.agents;
  }

  async onAgentStarted(event: AgentStartedEvent, context: ExtensionContext): Promise<Partial<AgentStartedEvent> | void> {
    const tillyAgent = this.agents.find(a => a.id === event.agentProfile?.id) as TillyAgentProfile;
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
    const count = this.stepCount.get(event.profile.id) || 0;
    if (count > 0 && count % this.config.editorialCheckpointInterval === 0) {
      event.remindersContent = (event.remindersContent || '') + `\n<ThisIsImportant>\n<Reminder>\n🛑 **EDITORIAL CHECKPOINT** — Step ${count}. Verify alignment with BRIEF.md.\n</Reminder>\n</ThisIsImportant>`;
    }

    if (this.config.contentStyleGuide) {
      const stylePath = path.isAbsolute(this.config.contentStyleGuide) ? this.config.contentStyleGuide : path.join(context.getProjectDir(), this.config.contentStyleGuide);
      if (fs.existsSync(stylePath)) {
        try {
          event.remindersContent = (event.remindersContent || '') + `\n<ThisIsImportant>\n<Reminder>\n📖 **STYLE GUIDE**\n\n${fs.readFileSync(stylePath, 'utf-8')}\n</Reminder>\n</ThisIsImportant>`;
        } catch (e: any) {
          context.log(`[Tilly] Style guide error: ${e.message}`, 'warn');
        }
      }
    }
    return event;
  }

  async onAgentStepFinished(event: AgentStepFinishedEvent): Promise<void> {
    this.stepCount.set(event.agentProfile.id, (this.stepCount.get(event.agentProfile.id) || 0) + 1);
  }

  async onSubagentFinished(event: SubagentFinishedEvent, context: ExtensionContext): Promise<void> {
    const tillyAgent = this.agents.find(a => a.id === event.subagentProfile?.id) as TillyAgentProfile;
    if (tillyAgent?.atomicCommit) {
      const dir = context.getProjectDir();
      if (git.isGitRepo(dir) && git.getChangedFiles(dir).length > 0) {
        git.stageFiles(dir);
        git.commit(dir, `feat(${tillyAgent.id}): completed ${event.subagentProfile?.name}`);
        context.log(`[Tilly] Atomic commit: ${tillyAgent.id}`, 'info');
      }
    }
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

  getUIComponents(): UIComponentDefinition[] {
    return [{
      id: 'tilly-brief-button',
      placement: 'task-top-bar-right',
      loadData: true,
      jsx: `(props) => {
        const { Button } = props.ui;
        if (!props.data?.exists) return null;
        return <Button variant="subtle" size="compact-s" className="mr-2 px-2 py-1 bg-bg-secondary text-text-tertiary hover:text-text-primary text-2xs border border-border-default" onClick={() => props.executeExtensionAction('open-brief')}>BRIEF.md</Button>;
      }`
    }];
  }

  async getUIExtensionData(componentId: string, context: ExtensionContext): Promise<unknown> {
    if (componentId !== 'tilly-brief-button') return;
    const rootId = this.getRootTaskId(context);
    if (!rootId) return { exists: false };
    const briefPath = path.join(context.getProjectDir(), '.aider-desk', 'tasks', rootId, 'BRIEF.md');
    let hasCode = false;
    try { execSync('code --version', { stdio: 'ignore' }); hasCode = true; } catch {}
    return { exists: fs.existsSync(briefPath) && hasCode };
  }

  async executeUIExtensionAction(componentId: string, action: string, _args: unknown[], context: ExtensionContext): Promise<unknown> {
    if (componentId !== 'tilly-brief-button' || action !== 'open-brief') return;
    const briefPath = path.join(context.getProjectDir(), '.aider-desk', 'tasks', this.getRootTaskId(context), 'BRIEF.md');
    if (fs.existsSync(briefPath)) {
      exec(`code "${briefPath}"`, err => context.log(`[Tilly] ${err ? 'Failed to open' : 'Opened'} BRIEF.md`, err ? 'error' : 'info'));
      return { success: true };
    }
    return { success: false };
  }

  getTools(_context: ExtensionContext, _mode: string, agentProfile: AgentProfile): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: 'update-brief',
        description: 'Updates BRIEF.md for the task.',
        inputSchema: z.object({ content: z.string() }),
        async execute(input, _signal, ctx) {
          const briefDir = path.join(ctx.getProjectDir(), '.aider-desk', 'tasks', (ctx.extension as TillyExtension).getRootTaskId(ctx));
          fs.mkdirSync(briefDir, { recursive: true });
          fs.writeFileSync(path.join(briefDir, 'BRIEF.md'), (input as any).content, 'utf-8');
          ctx.triggerUIDataRefresh('tilly-brief-button');
          return { content: [{ type: 'text', text: 'BRIEF.md updated' }] };
        }
      },
      {
        name: 'read-brief',
        description: 'Reads BRIEF.md.',
        inputSchema: z.object({}),
        async execute(_input, _signal, ctx) {
          try {
            const content = fs.readFileSync(path.join(ctx.getProjectDir(), '.aider-desk', 'tasks', (ctx.extension as TillyExtension).getRootTaskId(ctx), 'BRIEF.md'), 'utf-8');
            return { content: [{ type: 'text', text: content }] };
          } catch { return { content: [{ type: 'text', text: '' }] }; }
        }
      }
    ];

    if (agentProfile.id === 'tilly') {
      tools.push({
        name: 'delegate-to-content-agent',
        description: 'Delegates to a specialist.',
        inputSchema: z.object({
          agentId: z.enum(Object.keys(AGENT_CONFIGS).filter(id => id !== 'tilly') as [string, ...string[]]),
          taskName: z.string(),
          taskDescription: z.string()
        }),
        async execute(input, _signal, ctx) {
          const { agentId, taskName, taskDescription } = input as any;
          const profile = (ctx.extension as TillyExtension).getAgents(ctx).find(a => a.id === agentId);
          if (!profile) return { isError: true, content: [{ type: 'text', text: 'Agent not found' }] };
          const taskContext = ctx.getTaskContext();
          if (!taskContext) return { isError: true, content: [{ type: 'text', text: 'No task context' }] };
          const newTask = await ctx.getProjectContext().createTask({ parentId: taskContext.data.id, name: taskName, provider: profile.provider, model: profile.model, agentProfileId: profile.id });
          const subtask = ctx.getProjectContext().getTask(newTask.id);
          if (subtask) {
            await subtask.runPrompt(taskDescription, 'agent');
            return { content: [{ type: 'text', text: `Delegated to ${agentId}.` }] };
          }
          return { isError: true, content: [{ type: 'text', text: 'Failed to create subtask' }] };
        }
      });
    }
    return tools;
  }
}
