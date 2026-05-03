import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SubagentHandle } from "./subagent-process.js";

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
  // Update last activity for dashboard
  if (event.type === "tool_execution_start") {
    handle.lastActivity = `Calling ${event.toolName}`;
  } else if (event.type === "message_start" && event.message?.role === "assistant") {
    handle.lastActivity = "Thinking...";
  }

  // Capture result if report-result is called
  if (event.type === "tool_execution_start" && event.toolName === "report-result") {
    handle.result = event.args;
    handle.state = "done";
  }

  // Forward to conductor session as a custom message or entry
  // For Wave 1, we'll use a simple notification or status update
  // In a full implementation, we'd use pi.sendMessage or similar to show in UI
  // if (event.type === "tool_execution_start") {
  //    pi.ui.setStatus(handle.id, `${handle.agentName}: ${event.toolName}`);
  // }
}

export function resumeSubagent(pi: ExtensionAPI, handle: SubagentHandle) {
  handle.isPaused = false;
  while (handle.pauseBuffer.length > 0) {
    const event = handle.pauseBuffer.shift();
    processEvent(pi, handle, event);
  }
}
