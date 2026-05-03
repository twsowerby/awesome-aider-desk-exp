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
        content: "Conductor mode activated. You are now the Conductor. Read the conductor system prompt at .pi/agents/conductor.md or use the delegate, update-spec, and todo tools to orchestrate multi-agent workflows. Key rules: (1) Plan before delegating, (2) Create SPEC.md and wait for user approval, (3) Delegate to specialist agents, (4) Run post-implementation pipeline (Verifier → Reviewer).",
        display: "⚡ Conductor mode activated",
        details: { mode: "conductor" }
      }, { triggerTurn: true });
    }
  });

  // 4. Lifecycle Events
  pi.on("before_agent_start", (event, ctx) => {
    if (!isConductorMode) return;

    const conductorDirective = `
<ConductorMode>
You are the Conductor. You plan, delegate, and verify. You NEVER edit files directly.
Available agents: investigator, implementor, verifier, reviewer, critic, debugger, simplifier.
Workflow: Understand → Plan (create SPEC.md, wait for approval) → Delegate → Review → Verify → Complete.
Tools: delegate, delegate-chain, update-spec, read-spec, todo-set, todo-get, todo-update, todo-clear, commit.

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
