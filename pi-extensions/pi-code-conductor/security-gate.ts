import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";

export interface SecurityPolicy {
  deny_patterns: Record<string, string[]>;
  confirm_patterns: Record<string, string[]>;
}

const defaultPolicy: SecurityPolicy = {
  deny_patterns: {
    bash: [
      "rm -rf /",
      "rm -rf ~",
      "git push --force",
      "git push -f",
      "drop database",
      "truncate table"
    ],
    files: [
      ".env",
      ".env.*",
      "**/credentials*",
      "**/secrets*",
      "**/*.pem",
      "**/*.key"
    ]
  },
  confirm_patterns: {
    bash: [
      "rm ",
      "rmdir ",
      "git push",
      "npm publish",
      "docker ",
      "sudo "
    ],
    files: [
      "package.json",
      "package-lock.json",
      "*.lock",
      ".pi/*"
    ]
  }
};

function matchesPattern(text: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
    return regex.test(text);
  }
  return text.includes(pattern);
}

export function createSecurityGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent) => {
    const policy = defaultPolicy; // Future: load from file
    
    if (event.toolName === "bash") {
      const cmd = (event.input as any).command;
      if (policy.deny_patterns.bash.some(p => cmd.includes(p))) {
        return { block: true, reason: `Blocked dangerous command: ${cmd}` };
      }
      if (policy.confirm_patterns.bash.some(p => cmd.includes(p))) {
        const approved = await pi.ui.confirm("Security Confirmation", `Allow command: ${cmd}?`);
        if (!approved) return { block: true, reason: "User denied" };
      }
    }
    
    if (["write", "edit"].includes(event.toolName)) {
      const path = (event.input as any).path || (event.input as any).file || (event.input as any).file_path;
      if (path) {
        if (policy.deny_patterns.files.some(p => matchesPattern(path, p))) {
          return { block: true, reason: `Blocked write to protected path: ${path}` };
        }
        if (policy.confirm_patterns.files.some(p => matchesPattern(path, p))) {
          const approved = await pi.ui.confirm("Security Confirmation", `Allow write to ${path}?`);
          if (!approved) return { block: true, reason: "User denied" };
        }
      }
    }
  });
}
