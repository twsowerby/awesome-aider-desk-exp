import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { AgentConfig } from "./agents.js";
import { forwardEvents } from "./event-bridge.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface AgentToolResult {
  content: { type: string, text: string }[];
  details?: any;
  isError?: boolean;
}

export interface SubagentHandle {
  id: string;
  agentName: string;
  process: ChildProcess;
  state: "running" | "paused" | "done" | "failed" | "aborted";
  startedAt: number;
  result?: any;
  resultPromise: Promise<AgentToolResult>;
  lastActivity?: string;
  pauseBuffer: any[];
  isPaused: boolean;
  tempFiles: string[];
}

export const registry = new Map<string, SubagentHandle>();

function generateTempSettings(agent: AgentConfig, tmpDir: string): string {
  if (!agent.mcp_servers?.length) return "";
  
  const settings = {
    mcpServers: Object.fromEntries(
      agent.mcp_servers.map(server => [
        server.name,
        { command: server.command, args: server.args || [] }
      ])
    )
  };
  
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  
  return settingsPath;
}

function generateCustomToolsExtension(agent: AgentConfig, tmpDir: string): string {
  if (!agent.custom_tools?.length) return "";
  
  const toolsJsonPath = path.join(tmpDir, "tools.json");
  fs.writeFileSync(toolsJsonPath, JSON.stringify(agent.custom_tools, null, 2));
  
  const extensionCode = `
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";

export default function(pi) {
  const configPath = path.join(__dirname, "tools.json");
  const tools = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Object({ args: Type.Optional(Type.String()) }),
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const command = tool.command;
        let execCmd: string;
        let execArgs: string[];
        
        if (params.args) {
          const parts = command.split(/\s+/);
          const argParts = params.args.split(/\s+/);
          execCmd = parts[0];
          execArgs = [...parts.slice(1).map(p => p === "{{args}}" ? null : p), ...argParts].filter(p => p !== null) as string[];
        } else {
          const parts = command.split(/\s+/);
          execCmd = parts[0];
          execArgs = parts.slice(1).filter(p => p !== "{{args}}");
        }
        
        const result = await ctx.exec(execCmd, execArgs, { signal });
        return { content: [{ type: "text", text: result.stdout + "\\n" + result.stderr }], details: { command, exitCode: result.exitCode } };
      }
    });
  }
}
`;
  
  const extPath = path.join(tmpDir, "custom-tools.ts");
  fs.writeFileSync(extPath, extensionCode);
  
  return extPath;
}

export function spawnSubagent(pi: ExtensionAPI, agent: AgentConfig, task: string, cwd: string): SubagentHandle {
  const id = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-conductor-${id}-`));
  const tempFiles: string[] = [];

  const args = ["--mode", "json", "--no-session", "-p"];
  
  if (agent.model) {
    args.push("--model", agent.model);
  }
  
  if (agent.tools) {
    args.push("--tools", agent.tools.join(","));
  }

  // MCP Settings
  const settingsPath = generateTempSettings(agent, tmpDir);
  if (settingsPath) {
    args.push("--settings", settingsPath);
    tempFiles.push(settingsPath);
  }

  // Custom Tools Extension
  const customToolsExtPath = generateCustomToolsExtension(agent, tmpDir);
  if (customToolsExtPath) {
    args.push("--extension", customToolsExtPath);
    tempFiles.push(customToolsExtPath);
  }
  
  // System Prompt
  const promptPath = path.join(tmpDir, "system.md");
  fs.writeFileSync(promptPath, agent.systemPrompt);
  args.push("--append-system-prompt", promptPath);
  tempFiles.push(promptPath);
  
  // Main Subagent Extension
  // In a real environment, __dirname might not be reliable if bundled, 
  // but for this task we assume it works.
  const extensionPath = path.join(__dirname, "subagent-extension.ts");
  args.push("--extension", extensionPath);

  // Initial Task
  args.push(task);

  let proc: ChildProcess;
  try {
    proc = spawn("pi", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
  } catch (err: any) {
    const errorResult: AgentToolResult = { isError: true, content: [{ type: "text", text: `Failed to spawn pi: ${err.message}` }] };
    const errorHandle: any = {
      id,
      agentName: agent.name,
      state: "failed",
      startedAt: Date.now(),
      result: errorResult,
      resultPromise: Promise.resolve(errorResult),
      tempFiles: [tmpDir]
    };
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return errorHandle;
  }

  let resolveResult: (value: AgentToolResult) => void;
  const resultPromise = new Promise<AgentToolResult>((resolve) => {
    resolveResult = resolve;
  });

  const handle: SubagentHandle = {
    id,
    agentName: agent.name,
    process: proc,
    state: "running",
    startedAt: Date.now(),
    resultPromise,
    pauseBuffer: [],
    isPaused: false,
    tempFiles: [tmpDir]
  };

  registry.set(id, handle);

  forwardEvents(pi, handle);

  proc.on("error", (err) => {
    handle.state = "failed";
    const result = { isError: true, content: [{ type: "text", text: `Process error: ${err.message}` }] };
    handle.result = result;
    resolveResult(result);
  });

  proc.on("exit", (code) => {
    if (handle.state === "running") {
      handle.state = code === 0 ? "done" : "failed";
    }
    let result: AgentToolResult;
    if (handle.result?.content) {
      result = handle.result;
    } else if (handle.result) {
      // Handle case where result exists but content is missing/malformed
      result = { content: [{ type: "text", text: typeof handle.result === "string" ? handle.result : JSON.stringify(handle.result) }] };
    } else {
      result = { 
        content: [{ type: "text", text: handle.state === "done" ? "Subagent finished." : `Subagent exited with code ${code}` }] 
      };
    }
    resolveResult(result);
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  return handle;
}

export function cleanupSubagents() {
  for (const handle of registry.values()) {
    if (handle.state === "running") {
      handle.process.kill("SIGTERM");
    }
    // Final cleanup of temp files if any
    for (const fileOrDir of handle.tempFiles) {
      try { fs.rmSync(fileOrDir, { recursive: true, force: true }); } catch {}
    }
  }
}
