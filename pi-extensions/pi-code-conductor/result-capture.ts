import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registry } from "./subagent-process.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { Value } from "@sinclair/typebox/value";

export function registerResultTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "report-result",
    label: "Report Result",
    description: "Report your final result back to the conductor. Call this when your task is complete.",
    parameters: Type.Object({
      output_schema: Type.Optional(Type.String({ description: "The name of the schema to validate against" })),
      data: Type.Any({ description: "The structured result data" })
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      let validationWarning: string | undefined;
      
      if (args.output_schema) {
        const schema = OUTPUT_SCHEMAS[args.output_schema];
        if (schema) {
          const isValid = Value.Check(schema, args.data);
          if (!isValid) {
            const errors = [...Value.Errors(schema, args.data)];
            validationWarning = `Validation failed for ${args.output_schema}: ${errors.map(e => e.message).join(", ")}`;
          }
        } else {
          validationWarning = `Unknown output_schema: ${args.output_schema}`;
        }
      }

      // The actual capture happens in event-bridge.ts or by the subagent process manager
      // that monitors tool calls. Here we just provide feedback to the agent.
      
      if (validationWarning) {
        return {
          isError: false,
          content: [{ type: "text", text: `Result received with warnings: ${validationWarning}` }],
          data: {
             ...args.data,
             _validationWarning: validationWarning
          }
        };
      }

      return {
        content: [{ type: "text", text: "Result recorded successfully. You may now exit." }],
        data: args.data
      };
    }
  });
}
