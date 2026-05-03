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
    // Strip the YAML frontmatter (between --- markers) to get just the system prompt body
    const bodyStart = content.indexOf("---", 4); // find second ---
    if (bodyStart > 0) {
      return content.substring(bodyStart + 3).trim();
    }
    return content;
  } catch (err) {
    return "Conductor: Plan, delegate, and verify multi-agent workflows.";
  }
}

export default function(pi: ExtensionAPI) {
  // 0. Conductor mode enforcement
  pi.on("tool_call", (event, ctx) => {
    if (isConductorMode && !CONDUCTOR_ALLOWED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Conductor cannot use '${event.toolName}' directly. Delegate this work to a specialist agent using the 'delegate' tool. For example: delegate to investigator to explore code, delegate to implementor to make changes, delegate to reviewer for code review.`
      };
    }
  });

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

  pi.registerCommand("code-conductor", {
    description: "Activate/deactivate conductor mode. Use '/code-conductor' to activate, '/code-conductor off' to deactivate.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      setGlobalContext(ctx);
      if (args.trim() === "off") {
        isConductorMode = false;
        if (ctx.hasUI) ctx.ui.notify("Conductor mode deactivated", "info");
        ctx.ui.setStatus("conductor", undefined);
        return;
      }
      
      isConductorMode = true;
      
      // Load the conductor prompt if not already loaded
      if (!conductorPrompt) {
        conductorPrompt = await loadConductorPrompt();
      }
      
      if (ctx.hasUI) {
        ctx.ui.notify("⚡ Conductor mode activated", "info");
        ctx.ui.setStatus("conductor", "⚡ Conductor");
        
        // Show dashboard immediately on activation
        const lines = renderDashboard(registry);
        ctx.ui.setWidget("conductor_dashboard", lines);
      }
      
      // Send a message to the agent telling it it's now the conductor
      pi.sendMessage({
        customType: "conductor_activation",
        content: "CONDUCTOR MODE ACTIVE. You are now the Conductor. You plan, delegate, and verify — you NEVER do work yourself. You cannot use read, write, edit, bash, grep, find, or ls. ALL work must be delegated to specialist agents via the 'delegate' tool. When a user asks you to do something, delegate it to the appropriate specialist. Start every task by delegating to the investigator to gather context.",
        display: "⚡ Conductor mode activated",
        details: { mode: "conductor" }
      }, { triggerTurn: true });
    }
  });

  // 4. Lifecycle Events
  pi.on("before_agent_start", (event, ctx) => {
    if (!isConductorMode) return;

    const conductorDirective = `
<ConductorMode ACTIVE>
You are the Conductor. You ONLY plan, delegate, and verify. You NEVER do work yourself.
You CANNOT use: read, write, edit, bash, grep, find, ls. These are BLOCKED.
You CAN use: delegate, delegate-chain, update-spec, read-spec, todo-*, commit, pause/resume/steer/abort-agent.
ALL work goes through specialist agents via the 'delegate' tool.
Available agents: investigator, implementor, verifier, reviewer, critic, debugger, simplifier.
Workflow: delegate to investigator first → create SPEC.md → wait for approval → delegate to implementor → verify → review.

${conductorPrompt}
</ConductorMode>`;

    return {
      systemPrompt: (event.systemPrompt || "") + conductorDirective
    };
  });

  pi.on("session_shutdown", () => {
    cleanupSubagents();
    clearGlobalContext();
    isConductorMode = false;
    conductorPrompt = "";
  });
}
