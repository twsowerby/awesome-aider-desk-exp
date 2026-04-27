export interface AgentPromptConfig {
  objective: string;
  persona: string[];
  coreDirectives: { id: string; text: string }[];
  workflow: string;
  todoManagement?: {
    utilizationGuidelines: string[];
  };
  responseStyle: { id: string; text: string }[];
  refusalPolicy?: string;
  operationalNotes: string;
}
