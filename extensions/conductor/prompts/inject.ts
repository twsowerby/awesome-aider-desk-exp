import type { AgentStartedEvent, AgentProfile, ExtensionContext } from '@aiderdesk/extensions';
import { AGENT_CONFIGS } from './agent-configs';

function buildAgentPrompt(profile: AgentProfile): string {
  const config = AGENT_CONFIGS[profile.id];
  if (!config) return '';

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
  context: ExtensionContext
): Promise<void | Partial<AgentStartedEvent>> {
  const agentPrompt = buildAgentPrompt(event.agentProfile);
  if (!agentPrompt) return;

  const basePrompt = event.systemPrompt ?? '';
  const newPrompt = insertBeforeClosingTag(basePrompt, agentPrompt);

  context.log(`Injected custom prompt for agent: ${event.agentProfile.id}`, 'info');

  return { systemPrompt: newPrompt };
}
