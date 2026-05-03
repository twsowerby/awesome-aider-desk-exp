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
  if (!handle || !handle.process || !handle.process.stdin) {
    return `Agent ${id} not found or not running.`;
  }

  // Format as a JSON message for Pi in --mode json
  // Pi expects a JSON object on stdin representing the next turn
  const msg = {
    role: "user",
    content: [{ type: "text", text: message }]
  };

  handle.process.stdin.write(JSON.stringify(msg) + "\n");
  
  if (ctx.hasUI) {
    ctx.ui.notify(`Sent message to agent ${handle.agentName} (${id}).`);
  }
  return `Message sent to agent ${id}.`;
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
