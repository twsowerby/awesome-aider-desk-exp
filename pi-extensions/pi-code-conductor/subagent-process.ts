import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentConfig } from "./agents.js";
import { forwardEvents } from "./event-bridge.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface SubagentHandle {
  id: string;
  agentName: string;
  process: ChildProcess;
  state: "running" | "paused" | "done" | "failed" | "aborted";
  startedAt: number;
  result?: any;
  lastActivity?: string;
  pauseBuffer: any[];
  isPaused: boolean;
}

export const registry = new Map<string, SubagentHandle>();

export function spawnSubagent(pi: ExtensionAPI, agent: AgentConfig, task: string, cwd: string): SubagentHandle {
  const id = Math.random().toString(36).substring(7);
  const args = ["--mode", "json", "--no-session", "-p"];
  
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools) args.push("--tools", agent.tools.join(","));
  
  // Wave 1: Minimal system prompt passing
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-"));
  const promptPath = path.join(tmpDir, "system.md");
  fs.writeFileSync(promptPath, agent.systemPrompt);
  args.push("--append-system-prompt", promptPath);
  
  // Pass the subagent-specific extension to the child
  const extensionPath = path.join(__dirname, "subagent-extension.ts");
  args.push("--extension", extensionPath);

  // Pass the task as a positional argument
  args.push(task);

  let proc: ChildProcess;
  try {
    proc = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
  } catch (err: any) {
    const errorHandle: any = {
      id,
      agentName: agent.name,
      state: "failed",
      startedAt: Date.now(),
      result: { error: `Failed to spawn pi: ${err.message}` }
    };
    return errorHandle;
  }

  const handle: SubagentHandle = {
    id,
    agentName: agent.name,
    process: proc,
    state: "running",
    startedAt: Date.now(),
    pauseBuffer: [],
    isPaused: false
  };

  registry.set(id, handle);

  forwardEvents(pi, handle);

  proc.on("error", (err) => {
    handle.state = "failed";
    handle.result = { error: `Process error: ${err.message}` };
  });

  proc.on("exit", (code) => {
    if (handle.state === "running") {
      handle.state = code === 0 ? "done" : "failed";
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    
    // Cleanup registry after a delay to allow result retrieval
    setTimeout(() => {
      registry.delete(id);
    }, 1000 * 60 * 5); // 5 minutes
  });

  return handle;
}

export function cleanupSubagents() {
  for (const handle of registry.values()) {
    if (handle.state === "running") {
      handle.process.kill("SIGTERM");
    }
  }
}
