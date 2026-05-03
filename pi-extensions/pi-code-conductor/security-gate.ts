import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

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
  // Use a simple but correct glob-to-regex conversion
  // 1. Escape regex special characters except * and ?
  let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  
  // 2. Handle **
  regexStr = regexStr.replace(/\*\*/g, '___DOUBLE_STAR___');
  
  // 3. Handle *
  regexStr = regexStr.replace(/\*/g, '[^/]*');
  
  // 4. Handle ?
  regexStr = regexStr.replace(/\?/g, '[^/]');
  
  // 5. Restore ** as .*
  regexStr = regexStr.replace(/___DOUBLE_STAR___/g, '.*');
  
  const regex = new RegExp('^' + regexStr + '$');
  
  // If no glob chars, use specific matching logic
  if (!pattern.includes('*') && !pattern.includes('?')) {
    // For files, match against basename or full path if pattern has slashes
    if (pattern.includes('/')) {
      return text === pattern || text.endsWith('/' + pattern);
    } else {
      return path.basename(text) === pattern;
    }
  }

  return regex.test(text);
}

function extractCommandSegments(cmd: string): string[] {
  // Split on shell operators: &&, ||, ;, |, &
  return cmd.split(/\s*(?:&&|\|\||;|\|&?)\s*/)
    .map(s => s.trim().replace(/^\\/, ''))
    .filter(s => s.length > 0);
}

function isBashMatch(cmd: string, pattern: string): boolean {
  const segments = extractCommandSegments(cmd);
  const regex = new RegExp('\\b' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  
  return segments.some(segment => {
    if (pattern.includes(' ')) {
      return segment.includes(pattern);
    }
    return regex.test(segment);
  });
}

export function createSecurityGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent) => {
    const policy = defaultPolicy; // Future: load from file
    
    if (event.toolName === "bash") {
      const cmd = (event.input as any).command;
      if (policy.deny_patterns.bash.some(p => isBashMatch(cmd, p))) {
        return { block: true, reason: `Blocked dangerous command: ${cmd}` };
      }
      if (policy.confirm_patterns.bash.some(p => isBashMatch(cmd, p))) {
        const approved = await pi.ui.confirm("Security Confirmation", `Allow command: ${cmd}?`);
        if (!approved) return { block: true, reason: "User denied" };
      }
    }
    
    if (["write", "edit"].includes(event.toolName)) {
      const filePath = (event.input as any).path || (event.input as any).file || (event.input as any).file_path;
      if (filePath) {
        if (policy.deny_patterns.files.some(p => matchesPattern(filePath, p))) {
          return { block: true, reason: `Blocked write to protected path: ${filePath}` };
        }
        if (policy.confirm_patterns.files.some(p => matchesPattern(filePath, p))) {
          const approved = await pi.ui.confirm("Security Confirmation", `Allow write to ${filePath}?`);
          if (!approved) return { block: true, reason: "User denied" };
        }
      }
    }
  });
}
