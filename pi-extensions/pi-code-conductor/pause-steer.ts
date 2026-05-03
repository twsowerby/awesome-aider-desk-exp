import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registry } from "./subagent-process.js";
import { resumeSubagent } from "./event-bridge.js";

export async function pauseAgent(id: string, ctx: ExtensionContext): Promise<string> {
  const handle = registry.get(id);
  if (!handle) return `Agent ${id} not found.`;
  
  handle.isPaused = true;
  handle.state = "paused";
  if (ctx.hasUI) {
    ctx.ui.notify(`Agent ${handle.agentName} (${id}) paused.`);
  }
  return `Agent ${id} paused.`;
}

export async function resumeAgent(id: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
  const handle = registry.get(id);
  if (!handle) return `Agent ${id} not found.`;
  
  if (!handle.isPaused) return `Agent ${id} is not paused.`;
  
  handle.state = "running";
  resumeSubagent(pi, handle);
  
  if (ctx.hasUI) {
    ctx.ui.notify(`Agent ${handle.agentName} (${id}) resumed.`);
  }
  return `Agent ${id} resumed.`;
}

export async function steerAgent(id: string, message: string, ctx: ExtensionContext): Promise<string> {
  const handle = registry.get(id);
  if (!handle) return `Agent ${id} not found`;
  if (handle.state !== "running" && handle.state !== "paused") return `Agent ${id} is not running (state: ${handle.state})`;
  
  // Since stdin is ignored for reliability, we suggest re-delegation.
  // The conductor/user should abort and re-delegate.
  return `Steering not available for running subagents (stdin is closed for reliability). Use abort-agent to stop the current agent, then delegate again with additional context: "${message}"`;
}

export async function abortAgent(id: string, ctx: ExtensionContext): Promise<string> {
  const handle = registry.get(id);
  if (!handle) return `Agent ${id} not found.`;
  
  if (handle.process) {
    handle.process.kill("SIGKILL");
  }
  handle.state = "aborted";
  
  if (ctx.hasUI) {
    ctx.ui.notify(`Agent ${handle.agentName} (${id}) aborted.`);
  }
  return `Agent ${id} aborted.`;
}
