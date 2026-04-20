import type {
  AgentProfile,
  Extension,
  ExtensionContext,
  ToolDefinition,
  UIComponentDefinition
} from '@aiderdesk/extensions';
import { exec, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as git from './git';

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
  reminders?: {
    conductor?: string[];
    subagent?: string[];
  };
  defaults: AgentDefaults;
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

function loadAgents(extensionDir: string, configDefaults: AgentDefaults, delegationMode: string): AgentProfile[] {
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

    return {
      ...configDefaults,
      ...mergedOverrides,
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
  private extensionDir = '';

  async onLoad(context: ExtensionContext): Promise<void> {
    this.extensionDir = path.resolve(__dirname);
    try {
      this.config = loadConfig(this.extensionDir);
      const agentsDir = path.join(this.extensionDir, 'agents');
      this.agentsConfig = JSON.parse(fs.readFileSync(path.join(agentsDir, 'index.json'), 'utf-8'));
      this.agents = loadAgents(this.extensionDir, this.config.defaults, this.config.delegationMode);
      context.log(
        `Conductor loaded — mode: ${this.config.delegationMode}, ${this.agents.length} agents: ${this.agents.map(a => a.id).join(', ')}`,
        'info'
      );
    } catch (e: any) {
      context.log(`Conductor extension failed to load: ${e.message}`, 'error');
    }
  }

  getAgents(_context: ExtensionContext): AgentProfile[] {
    return this.agents;
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

  async onAgentProfileUpdated(
    _context: ExtensionContext,
    agentId: string,
    updatedProfile: AgentProfile
  ): Promise<AgentProfile> {
    const idx = this.agents.findIndex(a => a.id === agentId);
    if (idx !== -1) {
      this.agents[idx] = updatedProfile;
    }
    return updatedProfile;
  }

  async onImportantReminders(event: any, _context: ExtensionContext): Promise<any> {
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
    } catch (e) {
      _context.log(`[Conductor] Failed to process reminders: ${e}`, 'warn');
    }

    return event;
  }

  async onSubagentFinished(event: any, context: ExtensionContext): Promise<any> {
    try {
      const agentId = event.subagentProfile?.id;
      if (!agentId) return event;

      const agentConfig = this.getAgentConfigEntry(agentId);
      if (!agentConfig?.atomicCommit) return event;

      await this.performAtomicCommit(context, agentId, event.subagentProfile?.name || agentId, '');
    } catch (e: any) {
      context.log(`[Conductor] onSubagentFinished error: ${e.message}`, 'error');
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

    // Get commit provider/model from the agent profile (merged with defaults)
    const agentProfile = this.agents.find(a => a.id === agentId);
    const commitProvider = (agentProfile as AgentDefaults | undefined)?.commitProvider ?? agentProfile?.provider;
    const commitModel = (agentProfile as AgentDefaults | undefined)?.commitModel ?? agentProfile?.model;

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
    if (!commitProvider || !commitModel) {
      return this.fallbackCommitMessage(agentId, taskDescription);
    }

    try {
      const taskContext = ctx.getTaskContext();
      if (!taskContext) {
        ctx.log('[Conductor] No task context for commit message generation, using fallback', 'warn');
        return this.fallbackCommitMessage(agentId, taskDescription);
      }

      const diffContent = git.getDiff(ctx.getProjectDir()) || '(no diff available)';
      const systemPrompt = `You are a commit message generator. Write a concise, conventional-commits-style commit message based on the git diff. Use the format: "type: description". Types: feat, fix, refactor, style, docs, test, chore. Keep the message under 72 characters. Output ONLY the commit message, nothing else.`;
      const userPrompt = `Agent: ${agentName} (${agentId})\nTask: ${taskDescription.slice(0, 200)}\n\nDiff:\n${diffContent.slice(0, 4000)}`;

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
        return this.fallbackCommitMessage(agentId, taskDescription);
      }

      const generated = await taskContext.generateText(commitProfile, systemPrompt, userPrompt);
      if (generated?.trim()) {
        return generated.trim();
      }
    } catch (e: any) {
      ctx.log(`[Conductor] LLM commit message generation failed: ${e.message}`, 'warn');
    }

    return this.fallbackCommitMessage(agentId, taskDescription);
  }

  private fallbackCommitMessage(agentId: string, taskDescription: string): string {
    const shortDesc = taskDescription.slice(0, 80).split('\n')[0].trim() || 'code changes';
    return git.generateFallbackMessage(agentId, shortDesc);
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
      } catch (e: any) {
        ctx.log(`[Conductor] Failed to extract subtask results or update status: ${e.message}`, 'warn');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Subtask "${taskName}" (id: ${newTask.id}) completed by ${profile.name}.${resultSummary}`
          }
        ]
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error delegating to ${profile.name}: ${e.message}` }]
      };
    }
  }
}