import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SubagentHandle } from "./subagent-process.js";
import { renderDashboard } from "./agent-dashboard.js";
import { registry } from "./subagent-process.js";

// Global reference to the last known context to allow UI updates from background events
let lastCtx: any = null;

export function setGlobalContext(ctx: any) {
  lastCtx = ctx;
}

export function clearGlobalContext() {
  lastCtx = null;
}

export function forwardEvents(pi: ExtensionAPI, handle: SubagentHandle) {
  let buffer = "";

  handle.process.stdout?.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handle.eventLog.push(event);
        
        if (handle.isPaused) {
          handle.pauseBuffer.push(event);
          continue;
        }

        processEvent(pi, handle, event);
      } catch (e) {
        // Ignore non-JSON output
      }
    }
  });

  handle.process.stderr?.on("data", (data) => {
    // Optionally log stderr
  });
}

function processEvent(pi: ExtensionAPI, handle: SubagentHandle, event: any) {
  let changed = false;

  // Update last activity for dashboard
  if (event.type === "tool_execution_start") {
    handle.lastActivity = `Calling ${event.toolName}`;
    changed = true;
  } else if (event.type === "message_start" && event.message?.role === "assistant") {
    handle.lastActivity = "Thinking...";
    changed = true;
  }

  // Capture result if report-result is called
  if (event.type === "tool_execution_start" && event.toolName === "report-result") {
    handle.lastActivity = `Reporting result...`;
    changed = true;
  }

  if (event.type === "tool_execution_end" && event.toolName === "report-result") {
    handle.result = event.output;
    handle.state = "done";
    changed = true;
  }

  // Update dashboard if anything changed
  if (changed) {
    triggerDashboardUpdate(pi);
  }
}

export function resumeSubagent(pi: ExtensionAPI, handle: SubagentHandle) {
  handle.isPaused = false;
  const events = [...handle.pauseBuffer];
  handle.pauseBuffer.length = 0;
  for (const event of events) {
    processEvent(pi, handle, event);
  }
  triggerDashboardUpdate(pi);
}

export function triggerDashboardUpdate(pi: ExtensionAPI) {
  if (lastCtx && lastCtx.hasUI) {
    try {
      const lines = renderDashboard(registry);
      lastCtx.ui.setWidget("conductor_dashboard", lines);
    } catch (e) {
      // Context might be stale
    }
  }
}
