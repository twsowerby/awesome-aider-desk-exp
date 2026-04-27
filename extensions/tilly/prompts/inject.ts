import type { AgentStartedEvent, AgentProfile, ExtensionContext } from '@aiderdesk/extensions';
import { AGENT_CONFIGS } from './agent-configs';

export interface AgentPromptConfig {
  objective: string;
  persona: string[];
  coreDirectives: { id: string; text: string }[];
  workflow: string;
  todoManagement?: {
    utilizationGuidelines: string[];
  };
  responseStyle?: { id: string; text: string }[];
  refusalPolicy?: string;
  operationalNotes?: string;
}

const DEFAULT_RESPONSE_STYLE = [
  { id: "conciseness", text: "Keep responses brief (ideally under 4 lines), excluding tool calls/code. Use one-word confirmations like \"Done\" after successful actions." },
  { id: "verbosity", text: "Provide additional detail only when asked, reporting errors, or explaining complex plans/findings." }
];

const DEFAULT_REFUSAL_POLICY = "When unable to comply, state inability clearly in 1-2 sentences and offer alternatives if possible.";

function resolvePlaceholders(text: string, delegateToolName: string): string {
  return text.replace(/\{\{DELEGATE_TOOL\}\}/g, delegateToolName);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildAgentPrompt(profile: AgentProfile, delegateToolName: string = 'delegate-to-content-agent'): string {
  const config = AGENT_CONFIGS[profile.id];
  if (!config) return '';

  const sections: string[] = [];
  sections.push(`  <Objective>${escapeXml(config.objective)}</Objective>`);

  const traits = config.persona.map(t => `    <Trait>${escapeXml(t)}</Trait>`).join('\n');
  sections.push(`  <Persona>\n${traits}\n  </Persona>`);

  const directives = config.coreDirectives
    .map(d => `    <Directive id="${d.id}">${escapeXml(d.text)}</Directive>`)
    .join('\n');
  sections.push(`  <CoreDirectives>\n${directives}\n  </CoreDirectives>`);

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

  sections.push(config.workflow.startsWith('<Workflow>') ? config.workflow : `<Workflow>\n  <Step number="1" title="Execute">\n    <Instruction>${escapeXml(config.workflow)}</Instruction>\n  </Step>\n</Workflow>`);

  const styles = (config.responseStyle || DEFAULT_RESPONSE_STYLE)
    .map(s => `    <Rule id="${s.id}">${escapeXml(s.text)}</Rule>`)
    .join('\n');
  sections.push(`  <ResponseStyle>\n${styles}\n  </ResponseStyle>`);

  sections.push(`  <RefusalPolicy>\n    <Rule>${escapeXml(config.refusalPolicy || DEFAULT_REFUSAL_POLICY)}</Rule>\n  </RefusalPolicy>`);

  if (config.operationalNotes) {
    const escapedNotes = config.operationalNotes.replace(/\]\]>/g, ']]]]><![CDATA[>');
    sections.push(`  <Knowledge>\n    <CustomInstructions><![CDATA[\n${escapedNotes}\n]]></CustomInstructions>\n  </Knowledge>`);
  }

  return resolvePlaceholders('\n\n' + sections.join('\n\n'), delegateToolName);
}

function insertBeforeClosingTag(prompt: string, content: string): string {
  const closingTag = '</AiderDeskSystemPrompt>';
  const insertIndex = prompt.lastIndexOf(closingTag);
  return insertIndex !== -1 ? prompt.slice(0, insertIndex) + content + '\n' + prompt.slice(insertIndex) : prompt + content;
}

export async function handleAgentStarted(
  event: AgentStartedEvent,
  context: ExtensionContext,
  options?: { delegateToolName?: string }
): Promise<void | Partial<AgentStartedEvent>> {
  const delegateToolName = options?.delegateToolName ?? 'delegate-to-content-agent';
  const agentPrompt = buildAgentPrompt(event.agentProfile, delegateToolName);
  if (!agentPrompt) return;

  const newPrompt = insertBeforeClosingTag(event.systemPrompt ?? '', agentPrompt);
  context.log(`Injected custom prompt for agent: ${event.agentProfile.id}`, 'info');
  return { systemPrompt: newPrompt };
}
