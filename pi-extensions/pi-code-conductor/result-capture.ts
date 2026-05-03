import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registry } from "./subagent-process.js";

export const ReportResultSchema = Type.Object({
  completed: Type.Boolean(),
  summary: Type.String(),
  files_changed: Type.Optional(Type.Array(Type.String())),
  issues: Type.Optional(Type.Array(Type.String())),
  artifacts: Type.Optional(Type.Array(Type.String())),
});

export function registerResultTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "report-result",
    label: "Report Result",
    description: "Report your final result back to the conductor. Call this when your task is complete.",
    parameters: ReportResultSchema,
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      // In a real subagent process, this tool is called by the subagent.
      // We need to identify which subagent is calling it.
      // Since subagents run in their own process, they would call this tool
      // and we'd see it in the event stream.
      
      // For Wave 1, we just return a success message.
      // The actual capture happens in event-bridge.ts by watching tool_execution_start for 'report-result'.
      return "Result recorded. You may now exit.";
    }
  });
}
