import { type SubagentHandle } from "./subagent-process.js";

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
  lines.push("│ /pause    /steer    /abort    /inspect         │");
  lines.push("└────────────────────────────────────────────────┘");

  return lines;
}
