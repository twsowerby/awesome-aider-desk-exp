import type { AgentProfile } from '@aiderdesk/extensions';

export interface ExtensionToolGroup {
  id: string;           // e.g., "supabase"
  prefix: string;       // e.g., "supabase---"
  description: string;  // Domain description for LLM awareness
}

export interface ConductorAgentProfile extends AgentProfile {
  commitProvider?: string;
  commitModel?: string;
  extensionTools?: ExtensionToolGroup[];
}

export interface AgentPromptConfig {
  objective: string;
  persona: string[];
  coreDirectives: Array<{ id: string; text: string }>;
  workflow: string;
  todoManagement?: {
    utilizationGuidelines: string[];
  };
  responseStyle: Array<{ id: string; text: string }>;
  refusalPolicy?: string;
  operationalNotes: string;
}
