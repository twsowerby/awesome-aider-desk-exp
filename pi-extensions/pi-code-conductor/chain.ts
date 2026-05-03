import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSubagent, registry } from "./subagent-process.js";
import { getAgent } from "./agents.js";
import { setGlobalContext, triggerDashboardUpdate } from "./event-bridge.js";

export function registerChainTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate-chain",
    label: "Delegate Chain",
    description: "Run a sequence of agents, passing the output of each as context to the next.",
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Name of the agent" }),
        task: Type.String({ description: "The task for the agent. Use {previous} to inject the previous agent's result." })
      })),
      previousPlaceholder: Type.Optional(Type.String({ default: "{previous}" }))
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      setGlobalContext(ctx);
      const placeholder = args.previousPlaceholder || "{previous}";
      let lastResultText = "";

      for (let i = 0; i < args.agents.length; i++) {
        const step = args.agents[i];
        const agent = getAgent(step.name, ctx.cwd);
        if (!agent) {
          return { isError: true, content: [{ type: "text", text: `Agent not found: ${step.name}` }] };
        }

        const task = step.task.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), lastResultText);
        
        if (onUpdate) {
          onUpdate({ type: "progress", message: `Step ${i + 1}/${args.agents.length}: ${step.name}` } as any);
        }

        const handle = spawnSubagent(pi, agent, task, ctx.cwd);
        triggerDashboardUpdate(pi);

        if (signal) {
          signal.onabort = () => {
            handle.state = "aborted";
            handle.process.kill("SIGTERM");
          };
        }

        const result = await handle.resultPromise;
        if (result.isError) {
          return { isError: true, content: [{ type: "text", text: `Chain failed at step ${i + 1} (${step.name}): ${result.content[0].text}` }] };
        }

        // Extract result text for next step
        lastResultText = result.content.map(c => c.text).join("\n");
        
        // If we have structured data from report-result, we should use that instead if possible
        // In this implementation, we assume the text content is sufficient or that result.details 
        // might contain the structured data if we updated forwardEvents to capture it.
        if (handle.result?.data) {
           lastResultText = JSON.stringify(handle.result.data, null, 2);
        }
      }

      return { content: [{ type: "text", text: lastResultText }] };
    }
  });
}
