import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Handlebars from 'handlebars';
import type { AgentProfile } from '@aiderdesk/extensions';

export const TOOL_CONSTANTS = {
  TOOL_GROUP_NAME_SEPARATOR: '---',
  TODO_TOOL_GROUP_NAME: 'todo',
  TODO_TOOL_GET_ITEMS: 'get_items',
  TODO_TOOL_CLEAR_ITEMS: 'clear_items',
  TODO_TOOL_SET_ITEMS: 'set_items',
  TODO_TOOL_UPDATE_ITEM_COMPLETION: 'update_item_completion',
  MEMORY_TOOL_GROUP_NAME: 'memory',
  MEMORY_TOOL_RETRIEVE: 'retrieve_memory',
  MEMORY_TOOL_STORE: 'store_memory',
  MEMORY_TOOL_LIST: 'list_memories',
  MEMORY_TOOL_DELETE: 'delete_memory',
  SUBAGENTS_TOOL_GROUP_NAME: 'subagents',
  SUBAGENTS_TOOL_RUN_TASK: 'run_task',
  AIDER_TOOL_GROUP_NAME: 'aider',
  AIDER_TOOL_RUN_PROMPT: 'run_prompt',
  AIDER_TOOL_ADD_CONTEXT_FILES: 'add_context_files',
  AIDER_TOOL_GET_CONTEXT_FILES: 'get_context_files',
  AIDER_TOOL_DROP_CONTEXT_FILES: 'drop_context_files',
  POWER_TOOL_GROUP_NAME: 'power',
  POWER_TOOL_SEMANTIC_SEARCH: 'semantic_search',
  POWER_TOOL_FILE_READ: 'file_read',
  POWER_TOOL_FILE_WRITE: 'file_write',
  POWER_TOOL_FILE_EDIT: 'file_edit',
  POWER_TOOL_GLOB: 'glob',
  POWER_TOOL_GREP: 'grep',
  POWER_TOOL_BASH: 'bash',
};

// Cached compiled template
let systemPromptTemplate: Handlebars.TemplateDelegate | null = null;

/**
 * Compiles the system prompt Handlebars template (cached after first call).
 */
export function compileSystemTemplate(extensionDir: string): Handlebars.TemplateDelegate {
  if (!systemPromptTemplate) {
    const templatePath = path.join(extensionDir, 'prompts', 'system-prompt.hbs');
    const templateSource = fs.readFileSync(templatePath, 'utf-8');
    systemPromptTemplate = Handlebars.compile(templateSource);
  }
  return systemPromptTemplate;
}

/**
 * Renders the universal base system prompt using the provided data.
 */
export function renderSystemPrompt(extensionDir: string, data: unknown): string {
  const template = compileSystemTemplate(extensionDir);
  return template(data);
}

/**
 * Builds the data context for the system-prompt Handlebars template.
 * Uses ExtensionContext and AgentProfile as primary sources.
 * Falls back to event.data for fields we can't derive (like rulesFiles).
 */
export function buildTemplateData(
  projectDir: string,
  agentProfile: AgentProfile | null,
  extensionDir: string,
  eventData?: unknown
): Record<string, unknown> {
  const base = (typeof eventData === 'object' && eventData !== null)
    ? eventData as Record<string, unknown>
    : {};

  // Tool permissions and approvals
  const toolApprovals = (agentProfile?.toolApprovals ?? {}) as Record<string, string>;
  const isAllowed = (key: string) => toolApprovals[key] !== 'never';

  const usePowerTools = agentProfile?.usePowerTools ?? false;

  // Date and OS
  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const osName = `${os.type()} ${os.release()}`;

  return {
    projectDir,
    toolPermissions: {
      memory: {
        enabled: agentProfile?.useMemoryTools ?? false,
        retrieveAllowed: isAllowed('memory---retrieve_memory'),
        storeAllowed: isAllowed('memory---store_memory'),
        listAllowed: isAllowed('memory---list_memories'),
        deleteAllowed: isAllowed('memory---delete_memory'),
      },
      subagents: agentProfile?.useSubagents ?? false,
      todoTools: agentProfile?.useTodoTools ?? false,
      aiderTools: agentProfile?.useAiderTools ?? false,
      powerTools: {
        anyEnabled: usePowerTools,
        semanticSearch: usePowerTools,
        fileRead: usePowerTools,
        fileWrite: usePowerTools,
        fileEdit: usePowerTools,
        glob: usePowerTools,
        grep: usePowerTools,
        bash: usePowerTools,
      },
    },
    toolConstants: TOOL_CONSTANTS,
    currentDate,
    osName,
    taskDir: (base.taskDir as string) ?? projectDir,
    projectGitRootDirectory: (base.projectGitRootDirectory as string) || undefined,
    rulesFiles: (base.rulesFiles as string) ?? '',
    customInstructions: (base.customInstructions as string) ?? agentProfile?.customInstructions ?? undefined,
    workflow: (base.workflow as string) ?? getAgentWorkflow(agentProfile?.id ?? '', extensionDir),
  };
}

/**
 * Per-agent directive definitions.
 * Keyed by agent ID (matching agentProfile.id).
 */
const AGENT_DIRECTIVES: Record<string, string> = {
  conductor: `<CoreDirectives>
    <Directive id="delegate-first">Gather context by delegating to the Investigator. Their output satisfies this requirement. Use your own tools only for targeted spot-checks when writing subagent briefs.</Directive>
    <Directive id="trust-subagents">Information returned by delegated subagents is verified context. Do not re-investigate or re-verify with your own tools unless there is a specific, stated reason to doubt it.</Directive>
  </CoreDirectives>`,

  investigator: `<CoreDirectives>
    <Directive id="context-first">Prioritize understanding and full context. Never attempt to modify code or plan modifications without first identifying ALL relevant files and analyzing the request with available tools.</Directive>
    <Directive id="tool-mandate">If uncertain about any part of the codebase, use tools to gather information. Do not guess.</Directive>
    <Directive id="prioritize-tools">Exhaust tool capabilities before asking the user.</Directive>
  </CoreDirectives>
  <ToolUsageGuidelines>
    <Guideline id="assess-need">Determine the information required.</Guideline>
    <Guideline id="select-tool">Choose the single most appropriate tool for each sub-task.</Guideline>
    <Guideline id="handle-errors">Report errors immediately and suggest recovery steps.</Guideline>
    <Guideline id="avoid-loops">Do not repeat the same tool with the same arguments consecutively.</Guideline>
    <Guideline id="minimize-confirmation">Do not ask for confirmation when using tools; the app handles it.</Guideline>
  </ToolUsageGuidelines>`,

  implementor: `<CoreDirectives>
    <Directive id="implement-only">Implement exactly what is specified in the task description. Do not add features, refactor, or make assumptions beyond what is requested.</Directive>
    <Directive id="follow-patterns">Follow existing code patterns, naming conventions, and project structure precisely.</Directive>
  </CoreDirectives>`,

  verifier: `<CoreDirectives>
    <Directive id="verify-only">Verify only what is specified in the task description. Check each acceptance criterion explicitly.</Directive>
    <Directive id="report-failures">Report every failure with specific details: what was expected, what was found, and the file/line involved.</Directive>
  </CoreDirectives>`,

  reviewer: `<CoreDirectives>
    <Directive id="review-against-standards">Review code against project standards, patterns, and best practices. Focus on correctness, maintainability, and security.</Directive>
    <Directive id="actionable-feedback">Provide specific, actionable feedback. Cite the file, line, and what should change.</Directive>
  </CoreDirectives>`,

  critic: `<CoreDirectives>
    <Directive id="critique-constructively">Identify weaknesses, risks, and edge cases. Be thorough but constructive.</Directive>
    <Directive id="challenge-assumptions">Question assumptions and propose alternatives where the approach may fail.</Directive>
  </CoreDirectives>`,

  debugger: `<CoreDirectives>
    <Directive id="systematic-debug">Follow a systematic debugging approach: reproduce, isolate, identify root cause, then fix.</Directive>
    <Directive id="minimal-fix">Apply the minimal fix that addresses the root cause. Do not refactor or make unrelated changes.</Directive>
  </CoreDirectives>`,

  simplifier: `<CoreDirectives>
    <Directive id="simplify-only">Simplify only what is specified. Reduce complexity without changing behavior.</Directive>
    <Directive id="preserve-behavior">All simplifications must preserve exact existing behavior. Verify with tests.</Directive>
  </CoreDirectives>`,
};

/**
 * Per-agent workflow file paths (relative to prompts directory).
 * If not defined, the agent has no custom workflow file.
 */
const AGENT_WORKFLOW_FILES: Record<string, string> = {
  conductor: 'conductor-workflow.md',
};

/**
 * Returns role-specific directives for the given agent ID.
 * Returns empty string if no directives are defined for the agent.
 */
export function getAgentDirectives(agentId: string): string {
  return AGENT_DIRECTIVES[agentId] || '';
}

/**
 * Returns role-specific workflow content for the given agent ID.
 * Returns empty string if no workflow file is defined or found.
 */
export function getAgentWorkflow(agentId: string, extensionDir: string): string {
  const workflowFile = AGENT_WORKFLOW_FILES[agentId];
  if (!workflowFile) return '';

  try {
    const workflowPath = path.join(extensionDir, 'prompts', workflowFile);
    return fs.readFileSync(workflowPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Returns the full per-agent prompt augmentation (directives + workflow)
 * to be appended to the agent's system prompt.
 */
export function getAgentPromptAugmentation(agentId: string, extensionDir: string): string {
  const directives = getAgentDirectives(agentId);
  const workflow = getAgentWorkflow(agentId, extensionDir);

  const parts: string[] = [];
  if (directives) parts.push(directives);
  if (workflow) parts.push(workflow);

  return parts.join('\n\n');
}