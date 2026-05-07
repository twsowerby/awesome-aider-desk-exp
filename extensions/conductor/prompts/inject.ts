import type { AgentStartedEvent, AgentProfile, ExtensionContext } from '@aiderdesk/extensions';
import { AGENT_CONFIGS } from './agent-configs';
import type { ExtensionToolGroup } from './types';

function resolvePlaceholders(text: string, delegateToolName: string): string {
  return text.replace(/\{\{DELEGATE_TOOL\}\}/g, delegateToolName);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildAgentPrompt(profile: AgentProfile, delegateToolName: string = 'delegate-to-agent', extensionTools?: ExtensionToolGroup[]): string {
  const config = AGENT_CONFIGS[profile.id];
  if (!config) return '';

  const sections: string[] = [];

  // Objective
  sections.push(`  <Objective>${escapeXml(config.objective)}</Objective>`);

  // Persona
  const traits = config.persona.map(t => `    <Trait>${escapeXml(t)}</Trait>`).join('\n');
  sections.push(`  <Persona>\n${traits}\n  </Persona>`);

  // Core Directives
  const directives = config.coreDirectives
    .map(d => `    <Directive id="${d.id}">${escapeXml(d.text)}</Directive>`)
    .join('\n');
  sections.push(`  <CoreDirectives>\n${directives}\n  </CoreDirectives>`);

  // TodoManagement
  if (config.todoManagement) {
    const guidelines = config.todoManagement.utilizationGuidelines
      .map(g => `      <Guideline>${escapeXml(g)}</Guideline>`)
      .join('\n');

    sections.push(`  <TodoManagement enabled="true" group="todo">
    <Rule id="resume-or-reset">On each new user prompt, first check for an in-progress task list using todo---get_items; resume if related, otherwise clear with todo---clear_items.</Rule>
    <Operations>
      <Operation id="getItems" tool="get_items" />
      <Operation id="clear" tool="clear_items" />
      <Operation id="set" tool="set_items" />
      <Operation id="update" tool="update_item_completion" />
    </Operations>
    <Utilization>
${guidelines}
    </Utilization>
  </TodoManagement>`);
  }

  // Workflow
  sections.push(config.workflow);

  // Response Style
  const styles = config.responseStyle
    .map(s => `    <Rule id="${s.id}">${escapeXml(s.text)}</Rule>`)
    .join('\n');
  sections.push(`  <ResponseStyle>\n${styles}\n  </ResponseStyle>`);

  // Refusal Policy
  if (config.refusalPolicy) {
    sections.push(`  <RefusalPolicy>\n    <Rule>${escapeXml(config.refusalPolicy)}</Rule>\n  </RefusalPolicy>`);
  }

  // Knowledge / CustomInstructions
  const escapedNotes = config.operationalNotes.replace(/\]\]>/g, ']]]]><![CDATA[>');
  sections.push(`  <Knowledge>
    <CustomInstructions><![CDATA[
${escapedNotes}
]]></CustomInstructions>
  </Knowledge>`);

  // ExtensionTools
  if (extensionTools && extensionTools.length > 0) {
    const groups = extensionTools.map(g => 
      `    <ToolGroup id="${escapeXml(g.id)}" prefix="${escapeXml(g.prefix)}">\n      ${escapeXml(g.description)}\n    </ToolGroup>`
    ).join('\n');
    sections.push(`  <ExtensionTools>\n${groups}\n  </ExtensionTools>`);
  }

  const fullPrompt = sections.join('\n\n');
  return resolvePlaceholders('\n\n' + fullPrompt, delegateToolName);
}

function insertBeforeClosingTag(prompt: string, content: string): string {
  const closingTag = '</AiderDeskSystemPrompt>';
  const insertIndex = prompt.lastIndexOf(closingTag);

  if (insertIndex !== -1) {
    return prompt.slice(0, insertIndex) + content + '\n' + prompt.slice(insertIndex);
  }

  // Fallback: just append
  return prompt + content;
}

export async function handleAgentStarted(
  event: AgentStartedEvent,
  context: ExtensionContext,
  options?: { delegateToolName?: string; extensionTools?: ExtensionToolGroup[] }
): Promise<void | Partial<AgentStartedEvent>> {
  const delegateToolName = options?.delegateToolName ?? 'delegate-to-agent';
  const extensionTools = options?.extensionTools;
  const agentPrompt = buildAgentPrompt(event.agentProfile, delegateToolName, extensionTools);
  if (!agentPrompt) return;

  const basePrompt = event.systemPrompt ?? '';
  const newPrompt = insertBeforeClosingTag(basePrompt, agentPrompt);

  context.log(`Injected custom prompt for agent: ${event.agentProfile.id}`, 'info');

  return { systemPrompt: newPrompt };
}
