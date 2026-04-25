import type { PromptTemplateEvent, ExtensionContext } from '@aiderdesk/extensions';
import { TILLY_AGENT_IDS } from './agent-configs';

const BEHAVIORAL_SECTIONS = [
  'Objective',
  'Persona', 
  'CoreDirectives',
  'TodoManagement',
  'ResponseStyle',
  'RefusalPolicy',
  'CustomInstructions',
  'Workflow',
];

const BEHAVIORAL_PARENTS = ['Agent'];

function stripXmlSection(prompt: string, tagName: string): string {
  const regex = new RegExp(`\\s*<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>\\s*`, 'g');
  return prompt.replace(regex, '\n');
}

export async function handlePromptTemplate(
  event: PromptTemplateEvent,
  context: ExtensionContext
): Promise<void | Partial<PromptTemplateEvent>> {
  if (event.name === 'workflow') {
     const taskContext = context.getTaskContext();
     if (taskContext) {
       const agentProfile = await taskContext.getTaskAgentProfile();
       if (agentProfile && TILLY_AGENT_IDS.includes(agentProfile.id)) {
         return { prompt: '' };
       }
     }
  }

  if (event.name === 'system-prompt') {
    const taskContext = context.getTaskContext();
    if (!taskContext) return;
    const agentProfile = await taskContext.getTaskAgentProfile();
    if (!agentProfile || !TILLY_AGENT_IDS.includes(agentProfile.id)) return;

    let prompt = event.prompt;

    for (const parent of BEHAVIORAL_PARENTS) {
      prompt = stripXmlSection(prompt, parent);
    }

    for (const section of BEHAVIORAL_SECTIONS) {
      prompt = stripXmlSection(prompt, section);
    }

    prompt = prompt.replace(/\s*<(Rules|Knowledge)>\s*<\/\1>\s*/g, '\n');
    prompt = prompt.replace(/\n{3,}/g, '\n\n');

    return { prompt };
  }
}
