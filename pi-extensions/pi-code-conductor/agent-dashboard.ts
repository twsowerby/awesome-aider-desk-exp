import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registry, type SubagentHandle } from "./subagent-process.js";

export function initDashboard(pi: ExtensionAPI) {
  // The dashboard is updated via events and doesn't need much initial setup
  // but we could register a command or set an initial empty widget.
}

export function updateDashboard(pi: ExtensionAPI) {
  // We need to find a way to get the ExtensionContext (ctx) to use ctx.ui.setWidget
  // Since updateDashboard might be called from event handlers where we don't have ctx,
  // we might need to store the last known ctx or use a different approach.
  // HOWEVER, the spec says "initDashboard(pi: ExtensionAPI) - called during extension init"
  // and "updateDashboard(pi: ExtensionAPI, registry: SubagentRegistry)".
  // Wait, the spec says "ctx.ui.setWidget(...) available ONLY on ctx, NOT on pi".
  // This means we MUST have access to a ctx.
  
  // Let's assume we'll trigger a custom event that the main extension file listens to,
  // or we pass a reference to ctx.ui to this module.
}

export function renderDashboard(registry: Map<string, SubagentHandle>): string[] {
  const lines: string[] = [];
  lines.push("┌─ Conductor ─────────────────────────────────┐");

  if (registry.size === 0) {
    lines.push("│ No active subagents.                        │");
  } else {
    for (const handle of registry.values()) {
      const stateIcon = handle.state === "running" ? "⚙️" : 
                        handle.state === "paused" ? "⏳" :
                        handle.state === "done" ? "✅" :
                        handle.state === "aborted" ? "🛑" : "❌";
      
      const duration = Math.floor((Date.now() - handle.startedAt) / 1000);
      const activity = handle.lastActivity || "Idle";
      
      // Truncate activity to fit
      const displayActivity = activity.length > 20 ? activity.substring(0, 17) + "..." : activity;
      
      const line = `│ ${stateIcon} ${handle.agentName.padEnd(12)} ${handle.state.toUpperCase().padEnd(8)} ${displayActivity.padEnd(20)} ${duration}s │`;
      lines.push(line);
    }
  }

  lines.push("│                                                │");
  lines.push("│ [p] pause  [s] steer  [a] abort  [i] inspect  │");
  lines.push("└────────────────────────────────────────────────┘");

  return lines;
}
