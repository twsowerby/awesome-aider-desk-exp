import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let isConductorMode = false;
let conductorPrompt = "";

const CONDUCTOR_ALLOWED_TOOLS = new Set([
  "delegate", "delegate-chain", "update-spec", "read-spec",
  "todo-set", "todo-get", "todo-update", "todo-clear",
  "commit", "pause-agent", "resume-agent", "steer-agent", "abort-agent",
  "report-result"
]);

async function loadConductorPrompt(): Promise<string> {
  try {
    const agentPath = path.join(__dirname, "agents", "conductor.md");
    const content = await fs.promises.readFile(agentPath, "utf-8");
    const bodyStart = content.indexOf("---", 4);
    if (bodyStart > 0) {
      return content.substring(bodyStart + 3).trim();
    }
    return content;
  } catch (err) {
    return "Conductor: Plan, delegate, and verify multi-agent workflows.";
  }
}

async function selectAgent(ctx: ExtensionCommandContext): Promise<string | null> {
  const activeAgents = Array.from(registry.entries()).filter(([_, h]) => h.state === "running" || h.state === "paused");
  if (activeAgents.length === 0) {
    ctx.ui.notify("No active subagents.");
    return null;
  }
  if (activeAgents.length === 1) return activeAgents[0][0];

  const options = activeAgents.map(([id, h]) => ({
    label: `${h.agentName} (${id.substring(0, 8)})`,
    value: id
  }));

  return await ctx.ui.select("Select subagent:", options);
}

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (isConductorMode && !CONDUCTOR_ALLOWED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Conductor cannot use '${event.toolName}' directly. Delegate this work to a specialist agent using the 'delegate' tool.`
      };
    }
  });

  createSecurityGate(pi);
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
    description: "Abort and re-delegate a subagent with new context.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      setGlobalContext(ctx);
      const handle = registry.get(args.id);
      if (!handle) return { content: [{ type: "text", text: `Agent ${args.id} not found` }] };
      
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

  // Commands
  pi.registerCommand("agents", {
    description: "List discovered agents",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const agents = discoverAgents(ctx.cwd);
      const list = agents.map(a => `- **${a.name}** (${a.source}): ${a.description}`).join("\n");
      ctx.ui.notify(`Discovered agents:\n${list}`);
    }
  });

  pi.registerCommand("pause", {
    description: "Pause a running subagent",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const id = await selectAgent(ctx);
      if (id) {
        await pauseAgent(id, ctx);
        triggerDashboardUpdate(pi);
      }
    }
  });

  pi.registerCommand("resume", {
    description: "Resume a paused subagent",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const id = await selectAgent(ctx);
      if (id) {
        await resumeAgent(id, pi, ctx);
        triggerDashboardUpdate(pi);
      }
    }
  });

  pi.registerCommand("steer", {
    description: "Abort current subagent and re-delegate with steering message",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const id = await selectAgent(ctx);
      if (!id) return;
      
      const handle = registry.get(id);
      if (!handle) return;

      const message = args.trim() || await ctx.ui.input("Enter steering message:");
      if (!message) return;

      // Abort the running agent
      await abortAgent(id, ctx);
      if (ctx.hasUI) ctx.ui.notify(`Aborted ${handle.agentName}. Re-delegating with: ${message}`, "info");
      
      // Tell the conductor to re-delegate with the steer message
      pi.sendMessage({
        customType: "conductor_steer",
        content: `The user wants to steer the ${handle.agentName} agent with this message: "${message}". Please re-delegate to ${handle.agentName} with the original task plus this additional context.`,
        display: `Steering: ${message}`,
        details: { agentName: handle.agentName, steerMessage: message }
      }, { triggerTurn: true });
      
      triggerDashboardUpdate(pi);
    }
  });

  pi.registerCommand("abort", {
    description: "Abort a running subagent",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const id = await selectAgent(ctx);
      if (id) {
        await abortAgent(id, ctx);
        triggerDashboardUpdate(pi);
      }
    }
  });

  pi.registerCommand("inspect", {
    description: "Show detailed output of a subagent",
    handler: async (args, ctx) => {
      setGlobalContext(ctx);
      const options = Array.from(registry.entries()).map(([id, h]) => ({
        label: `${h.agentName} (${h.state})`,
        value: id
      }));
      
      if (options.length === 0) {
        ctx.ui.notify("No agents in registry.");
        return;
      }
      
      const id = options.length === 1 ? options[0].value : await ctx.ui.select("Inspect agent:", options);
      if (!id) return;
      
      const handle = registry.get(id);
      if (handle) {
        const log = handle.eventLog.map(e => JSON.stringify(e)).join("\n");
        ctx.ui.notify(`Event Log for ${handle.agentName}:\n${log}`);
      }
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

  pi.registerCommand("code-conductor", {
    description: "Activate/deactivate conductor mode.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      setGlobalContext(ctx);
      if (args.trim() === "off") {
        isConductorMode = false;
        if (ctx.hasUI) ctx.ui.notify("Conductor mode deactivated", "info");
        ctx.ui.setStatus("conductor", undefined);
        return;
      }
      
      isConductorMode = true;
      if (!conductorPrompt) conductorPrompt = await loadConductorPrompt();
      
      if (ctx.hasUI) {
        ctx.ui.notify("⚡ Conductor mode activated", "info");
        ctx.ui.setStatus("conductor", "⚡ Conductor");
        const lines = renderDashboard(registry);
        ctx.ui.setWidget("conductor_dashboard", lines);
      }
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!isConductorMode) return;
    const conductorDirective = `\n<ConductorMode ACTIVE>\n${conductorPrompt}\n</ConductorMode>`;
    return { systemPrompt: (event.systemPrompt || "") + conductorDirective };
  });

  pi.on("session_shutdown", () => {
    cleanupSubagents();
    clearGlobalContext();
    isConductorMode = false;
  });
}
