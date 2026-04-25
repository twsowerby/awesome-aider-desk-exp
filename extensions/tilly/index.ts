import type {
  AgentStartedEvent,
  Extension,
  ExtensionContext,
  ImportantRemindersEvent,
  PromptTemplateEvent,
  SubagentFinishedEvent,
  ToolDefinition,
  UIComponentDefinition
} from '@aiderdesk/extensions';
import { z } from 'zod';
import { handleAgentStarted } from './prompts/inject';
import { handlePromptTemplate } from './prompts/strip';

export default class TillyExtension implements Extension {
  static metadata = {
    name: 'Tilly',
    version: '0.1.0',
    description: 'Content production team orchestration extension for AiderDesk',
    author: 'Tom Sowerby',
    capabilities: ['agents', 'tools', 'ui']
  };

  async onLoad(context: ExtensionContext): Promise<void> {
    context.log('[Tilly] extension loaded', 'info');
  }

  async onAgentStarted(event: AgentStartedEvent, context: ExtensionContext): Promise<Partial<AgentStartedEvent> | void> {
    context.log(`[Tilly] Agent started: ${event.agentProfile?.name}`, 'info');
    return handleAgentStarted(event, context);
  }

  async onPromptTemplate(event: PromptTemplateEvent, context: ExtensionContext): Promise<Partial<PromptTemplateEvent> | void> {
    return handlePromptTemplate(event, context);
  }

  async onImportantReminders(event: ImportantRemindersEvent, _context: ExtensionContext): Promise<void | Partial<ImportantRemindersEvent>> {
    // Placeholder for adding important reminders to the agent's context
    return undefined;
  }

  async onSubagentFinished(event: SubagentFinishedEvent, context: ExtensionContext): Promise<void | Partial<SubagentFinishedEvent>> {
    context.log(`[Tilly] Subagent finished: ${event.subagentProfile?.name}`, 'info');
    return undefined;
  }

  getUIComponents(_context: ExtensionContext): UIComponentDefinition[] {
    // Placeholder for UI components
    return [];
  }

  getTools(_context: ExtensionContext, _mode: string, _agentProfile: any): ToolDefinition[] {
    return [
      {
        name: 'update-brief',
        description: 'Update the content production brief.',
        inputSchema: z.object({
          content: z.string().describe('The new content for the brief')
        }),
        async execute(input, _signal, context) {
          context.log('[Tilly] update-brief tool called', 'info');
          return { content: [{ type: 'text', text: 'Brief updated (placeholder)' }] };
        }
      },
      {
        name: 'read-brief',
        description: 'Read the current content production brief.',
        inputSchema: z.object({}),
        async execute(_input, _signal, context) {
          context.log('[Tilly] read-brief tool called', 'info');
          return { content: [{ type: 'text', text: 'Current brief content (placeholder)' }] };
        }
      },
      {
        name: 'delegate-to-content-agent',
        description: 'Delegate a task to a content production agent.',
        inputSchema: z.object({
          agentId: z.string().describe('The ID of the agent to delegate to'),
          task: z.string().describe('The task description')
        }),
        async execute(input, _signal, context) {
          context.log(`[Tilly] delegate-to-content-agent tool called for agent: ${(input as any).agentId}`, 'info');
          return { content: [{ type: 'text', text: 'Task delegated (placeholder)' }] };
        }
      }
    ];
  }
}
