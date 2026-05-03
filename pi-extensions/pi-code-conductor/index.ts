import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents, getAgent } from "./agents.js";
import { spawnSubagent, cleanupSubagents, registry } from "./subagent-process.js";
import { createSecurityGate } from "./security-gate.js";
import { registerResultTools } from "./result-capture.js";

export default function(pi: ExtensionAPI) {
  // 1. Initialize Security Gate
  createSecurityGate(pi);

  // 2. Register Tools
  registerResultTools(pi);

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Delegate a task to a specialist subagent.",
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent to delegate to" }),
      task: Type.String({ description: "The task for the subagent" }),
      cwd: Type.Optional(Type.String({ description: "Working directory" }))
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const agent = getAgent(args.agent, ctx.cwd);
      if (!agent) {
        return { isError: true, content: [{ type: "text", text: `Agent not found: ${args.agent}` }] };
      }

      const handle = spawnSubagent(pi, agent, args.task, args.cwd || ctx.cwd);
      
      return new Promise((resolve) => {
        handle.process.on("exit", (code) => {
          const result = handle.result || { summary: "Subagent finished without reporting structured result." };
          resolve({
            content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
            details: result
          });
        });

        if (signal) {
          signal.onabort = () => {
            handle.process.kill("SIGTERM");
            resolve({ content: [{ type: "text", text: "Delegation aborted." }] });
          };
        }
      });
    }
  });

  pi.registerTool({
    name: "pause-agent",
    label: "Pause Agent",
    description: "Pause a running subagent.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (toolCallId, args) => {
      const handle = registry.get(args.id);
      if (handle) {
        handle.isPaused = true;
        return `Agent ${args.id} paused.`;
      }
      return `Agent ${args.id} not found.`;
    }
  });

  pi.registerTool({
    name: "steer-agent",
    label: "Steer Agent",
    description: "Inject a message into a running subagent's session.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    execute: async (toolCallId, args) => {
      const handle = registry.get(args.id);
      if (handle && handle.process.stdin) {
        const msg = { role: "user", content: [{ type: "text", text: args.message }] };
        handle.process.stdin.write(JSON.stringify(msg) + "\n");
        return `Message sent to agent ${args.id}.`;
      }
      return `Agent ${args.id} not found or not running.`;
    }
  });

  // 3. Register Commands
  pi.registerCommand({
    name: "agents",
    description: "List discovered agents",
    execute: async (args, ctx) => {
      const agents = discoverAgents(ctx.cwd);
      const list = agents.map(a => `- **${a.name}** (${a.source}): ${a.description}`).join("\n");
      ctx.ui.notify(`Discovered agents:\n${list}`);
    }
  });

  // 4. Lifecycle Events
  pi.on("session_shutdown", () => {
    cleanupSubagents();
  });
}
