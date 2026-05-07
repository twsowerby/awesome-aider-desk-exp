import type { PromptTemplateEvent, ExtensionContext } from '@aiderdesk/extensions';
import { CONDUCTOR_AGENT_IDS } from './agent-configs';

// Sections to REMOVE from the system prompt (behavioral, agent-specific)
// Note: ExtensionTools is NOT included here because it's a structural section
// (like PowerTools, ToolUsageGuidelines) injected during onAgentStarted.
// It should survive the strip phase.
const BEHAVIORAL_SECTIONS = [
  'Objective',
  'Persona', 
  'CoreDirectives',
  'TodoManagement',
  'ResponseStyle',
  'RefusalPolicy',
  'CustomInstructions',
];

// Parent tags that wrap behavioral sections
const BEHAVIORAL_PARENTS = ['Agent'];

function stripXmlSection(prompt: string, tagName: string): string {
  const regex = new RegExp(
    `\\s*<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>\\s*`,
    'g'
  );
  return prompt.replace(regex, '\n');
}

export async function handlePromptTemplate(
  event: PromptTemplateEvent,
  context: ExtensionContext
): Promise<void | Partial<PromptTemplateEvent>> {
  // Check if this is a conductor-managed agent
  const taskContext = context.getTaskContext();
  if (!taskContext) return;
  
  const agentProfile = await taskContext.getTaskAgentProfile();
  if (!agentProfile || !CONDUCTOR_AGENT_IDS.includes(agentProfile.id)) return;

  // Strip the default workflow
  if (event.name === 'workflow') {
    return { prompt: '' };
  }

  // Strip behavioral sections from the system prompt
  if (event.name === 'system-prompt') {
    let prompt = event.prompt;

    // Remove behavioral parent sections (like <Agent>)
    for (const parent of BEHAVIORAL_PARENTS) {
      prompt = stripXmlSection(prompt, parent);
    }

    // Remove individual behavioral sections
    for (const section of BEHAVIORAL_SECTIONS) {
      prompt = stripXmlSection(prompt, section);
    }

    // Remove the rendered workflow block
    prompt = prompt.replace(/\s*<Workflow>[\s\S]*?<\/Workflow>\s*/g, '\n');

    // Strip <Rules></Rules> if it contains only whitespace
    prompt = prompt.replace(/\s*<Rules>\s*<\/Rules>\s*/g, '\n');

    // Strip <Knowledge></Knowledge> if it contains only whitespace
    prompt = prompt.replace(/\s*<Knowledge>\s*<\/Knowledge>\s*/g, '\n');

    // Clean up excessive blank lines
    prompt = prompt.replace(/\n{3,}/g, '\n\n');

    return { prompt };
  }
}
