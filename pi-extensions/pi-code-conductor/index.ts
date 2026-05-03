import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents, getAgent } from "./agents.js";
import { spawnSubagent, cleanupSubagents, registry } from "./subagent-process.js";
import { createSecurityGate } from "./security-gate.js";
import { registerResultTools } from "./result-capture.js";
import { renderDashboard } from "./agent-dashboard.js";
import { pauseAgent, resumeAgent, steerAgent, abortAgent } from "./pause-steer.js";
import { setGlobalContext, triggerDashboardUpdate, clearGlobalContext } from "./event-bridge.js";

import { registerSpecTools } from "./spec-manager.js";
import { registerTodoTools } from "./todo-manager.js";
import { registerCommitTool } from "./commit-tool.js";
import { registerChainTools } from "./chain.js";

export default function(pi: ExtensionAPI) {
  // 1. Initialize Security Gate
  createSecurityGate(pi);

  // 2. Register Tools
  registerResultTools(pi);
  registerSpecTools(pi);
  registerTodoTools(pi);
  registerCommitTool(pi);
  registerChainTools(pi);

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
      setGlobalContext(ctx);
      const agent = getAgent(args.agent, ctx.cwd);
      if (!agent) {
        return { isError: true, content: [{ type: "text", text: `Agent not found: ${args.agent}` }] };
      }

      const handle = spawnSubagent(pi, agent, args.task, args.cwd || ctx.cwd);
      triggerDashboardUpdate(pi);
      
      if (signal) {
        signal.onabort = () => {
          handle.state = "aborted";
          handle.process.kill("SIGTERM");
        };
      }

      return await handle.resultPromise;
    }
  });

  pi.registerTool({
    name: "pause-agent",
    label: "Pause Agent",
    description: "Pause a running subagent.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      setGlobalContext(ctx);
      const result = await pauseAgent(args.id, ctx);
      triggerDashboardUpdate(pi);
      return { content: [{ type: "text", text: result }] };
    }
  });

  pi.registerTool({
    name: "resume-agent",
    label: "Resume Agent",
    description: "Resume a paused subagent.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      setGlobalContext(ctx);
      const result = await resumeAgent(args.id, pi, ctx);
      triggerDashboardUpdate(pi);
      return { content: [{ type: "text", text: result }] };
    }
  });

  pi.registerTool({
    name: "steer-agent",
    label: "Steer Agent",
    description: "Inject a message into a running subagent's session.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      setGlobalContext(ctx);
      const result = await steerAgent(args.id, args.message, ctx);
      triggerDashboardUpdate(pi);
      return { content: [{ type: "text", text: result }] };
    }
  });

  pi.registerTool({
    name: "abort-agent",
    label: "Abort Agent",
    description: "Kill a running subagent.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      setGlobalContext(ctx);
      const result = await abortAgent(args.id, ctx);
      triggerDashboardUpdate(pi);
      return { content: [{ type: "text", text: result }] };
    }
  });

  // 3. Register Commands
  pi.registerCommand("agents", {
    description: "List discovered agents",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const agents = discoverAgents(ctx.cwd);
      const list = agents.map(a => `- **${a.name}** (${a.source}): ${a.description}`).join("\n");
      ctx.ui.notify(`Discovered agents:\n${list}`);
    }
  });

  pi.registerCommand("conductor-dashboard", {
    description: "Show/hide the conductor dashboard",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      if (ctx.hasUI) {
        const lines = renderDashboard(registry);
        ctx.ui.setWidget("conductor_dashboard", lines);
      }
    }
  });

  // 4. Lifecycle Events
  pi.on("session_shutdown", () => {
    cleanupSubagents();
    clearGlobalContext();
  });
}
